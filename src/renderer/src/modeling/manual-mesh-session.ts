import { useSyncExternalStore } from 'react';
import type { Point } from '../../../core/model/evaluate';
import { meshConnections, triangulate } from '../../../core/model/topology';
import { topologyPreview } from '../../../core/model/topology-preview';
import type { SourceScene } from '../../../shared/scene';
import type { TopologyVertex } from '../../../shared/types';
import { setMeshPreview, type MeshPreview } from './mesh-preview';
import {
  deleteVertices,
  eraseMesh,
  autoConnect,
  canConnect,
  connectVertex,
  insertVertex,
  rebuildAutomaticEdges,
  subdivideMesh,
  validMesh,
  withAutomaticEdges,
  type MeshDraft,
} from './manual-mesh-geometry';
import { hitEraser, type MeshEraserPoint } from './manual-mesh-eraser';

export type MeshTool = 'select' | 'lasso' | 'add' | 'erase' | 'pan';
export interface MeshScreenPoint extends MeshEraserPoint {
  sx: number;
  sy: number;
}
interface MeshEditorSnapshot {
  ready: boolean;
  busy: boolean;
  tool: MeshTool;
  vertices: number;
  triangles: number;
  selected: number;
  canUndo: boolean;
  canRedo: boolean;
  valid: boolean;
  error: string;
  showOthers: boolean;
  eraserSize: number;
}
interface EraserPointer {
  point: Point;
  edgesOnly: boolean;
}
const geometryChanged = (a: MeshDraft, b: MeshDraft) =>
  a.vertices !== b.vertices || a.indices !== b.indices || a.edges !== b.edges;
const listeners = new Set<() => void>();
let active: ManualMeshSession | null = null;
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getManualMeshSession = () => active;
export function setManualMeshSession(session: ManualMeshSession | null) {
  if (active !== session) active?.dispose();
  active = session;
  notify();
}
export const useManualMeshSession = () => useSyncExternalStore(subscribe, getManualMeshSession);
export const useManualMeshState = () =>
  useSyncExternalStore(subscribe, () => active?.snapshot ?? null);

/** Local edit transactions publish only an overlay during gestures, never model IPC or React frames. */
export class ManualMeshSession {
  draft: MeshDraft = { vertices: [], indices: [], edges: [], selected: [] };
  snapshot: MeshEditorSnapshot = {
    ready: false,
    busy: false,
    tool: 'add',
    vertices: 0,
    triangles: 0,
    selected: 0,
    canUndo: false,
    canRedo: false,
    valid: false,
    error: '',
    showOthers: true,
    eraserSize: 100,
  };
  private preview: MeshPreview | null = null;
  private undoStack: MeshDraft[] = [];
  private redoStack: MeshDraft[] = [];
  private initial: MeshDraft = this.draft;
  private hover: number | null = null;
  private guide: Point[] = [];
  private pen: { to: Point; from: number[] } | null = null;
  private eraser: { center: Point; edgesOnly: boolean } | null = null;
  private strokeFrame: number | null = null;
  private stroke: {
    before: MeshDraft;
    base: MeshDraft;
    points: MeshScreenPoint[];
    last: Point;
    vertices: Set<number>;
    edges: Set<string>;
    pending: boolean;
    error: string;
  } | null = null;
  private drag: {
    before: MeshDraft;
    start: Point;
    uv: TopologyVertex | null;
    points: MeshScreenPoint[];
    kind: 'move' | 'rectangle' | 'lasso';
    additive: boolean;
    subtract: boolean;
  } | null = null;
  constructor(
    readonly guid: string,
    readonly name: string,
    readonly documentId: string,
    readonly documentRevision: number,
    readonly finish: () => void,
    readonly cancel: () => void,
  ) {}
  dispose() {
    if (this.strokeFrame !== null) cancelAnimationFrame(this.strokeFrame);
    this.strokeFrame = null;
    this.stroke = null;
    this.drag = null;
    this.preview = null;
  }
  load(scene: SourceScene) {
    const mesh = scene.meshes.find((m) => m.guid === this.guid);
    if (!mesh || mesh.path || !mesh.indices.length)
      throw new Error('Select an ArtMesh with valid triangles.');
    const vertices: TopologyVertex[] = [];
    for (let i = 0; i < mesh.uvs.length; i += 2)
      vertices.push({ u: mesh.uvs[i], v: mesh.uvs[i + 1], sourceIndex: i / 2 });
    this.draft = {
      vertices,
      indices: [...mesh.indices],
      selected: [],
      edges: withAutomaticEdges(mesh.indices, mesh.editableEdges ?? meshConnections(mesh.indices)),
    };
    this.initial = this.draft;
    // Show the whole original layer under the editable wires, including pixels outside its mesh.
    const imageVertices = [...vertices];
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ])
      if (!imageVertices.some((p) => Math.hypot(p.u - u, p.v - v) < 1e-7))
        imageVertices.push({ u, v });
    const geometry = topologyPreview(scene, [
      {
        guid: this.guid,
        vertices: imageVertices,
        indices: triangulate(imageVertices.flatMap((v) => [v.u, v.v])),
        boundaryLoops: [],
      },
    ]);
    geometry.meshes = geometry.meshes.map((m) => ({
      ...m,
      clips: [],
      inverted: false,
      blend: 'normal',
      culling: false,
    }));
    this.preview = {
      documentId: this.documentId,
      documentRevision: this.documentRevision,
      scene,
      geometry,
      enabled: true,
    };
    this.update({ ready: true });
    this.paint();
  }
  private update(value: Partial<MeshEditorSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      vertices: this.draft.vertices.length,
      triangles: this.draft.indices.length / 3,
      selected: this.draft.selected.length,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      valid: validMesh(this.draft),
      ...value,
    };
    notify();
  }
  private paint() {
    if (!this.preview) return;
    setMeshPreview({
      ...this.preview,
      manual: {
        guid: this.guid,
        vertices: this.draft.vertices,
        indices: this.draft.indices,
        edges: this.draft.edges,
        selected: this.draft.selected,
        hover: this.hover,
        guide: this.guide,
        pen: this.pen,
        eraser: this.eraser ? { ...this.eraser, size: this.snapshot.eraserSize } : null,
        showOthers: this.snapshot.showOthers,
      },
    });
  }
  setBusy(busy: boolean) {
    this.update({ busy });
  }
  setError(error: string) {
    this.update({ error });
  }
  setTool(tool: MeshTool) {
    this.cancelDrag();
    this.hover = null;
    this.pen = null;
    this.eraser = null;
    this.update({ tool });
    this.paint();
  }
  setShowOthers(showOthers: boolean) {
    this.update({ showOthers });
    this.paint();
  }
  setEraserSize(size: number) {
    if (!Number.isFinite(size) || this.snapshot.busy) return;
    this.update({ eraserSize: Math.max(0.1, Math.min(10000, size)) });
    this.paint();
  }
  get changed() {
    return geometryChanged(this.draft, this.initial);
  }
  get dragging() {
    return this.drag !== null || this.stroke !== null;
  }
  private remember(before: MeshDraft) {
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  private change(operation: (draft: MeshDraft) => MeshDraft) {
    if (!this.snapshot.ready || this.snapshot.busy) return;
    this.cancelDrag();
    try {
      const next = operation(this.draft);
      if (next === this.draft) return;
      if (next.vertices.length > 10000 || next.indices.length > 60000)
        throw new Error('Mesh limit: 10,000 vertices.');
      this.remember(this.draft);
      this.draft = next;
      this.hover = null;
      this.pen = null;
      this.update({ error: '' });
      this.paint();
    } catch (error) {
      this.setError((error as Error).message);
    }
  }
  remove() {
    this.change(deleteVertices);
  }
  connect() {
    this.change(autoConnect);
  }
  subdivide() {
    this.change(subdivideMesh);
  }
  undo() {
    if (this.snapshot.busy) return;
    if (this.dragging) {
      this.cancelDrag();
      return;
    }
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.draft);
    this.draft = previous;
    this.pen = null;
    this.update({ error: '' });
    this.paint();
  }
  redo() {
    if (this.snapshot.busy) return;
    this.cancelDrag();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.draft);
    this.draft = next;
    this.pen = null;
    this.update({ error: '' });
    this.paint();
  }
  selectAll() {
    if (!this.snapshot.ready || this.snapshot.busy) return;
    this.draft = { ...this.draft, selected: this.draft.vertices.map((_, i) => i) };
    this.pen = null;
    this.update();
    this.paint();
  }
  private hit(screen: Point, points: MeshScreenPoint[]) {
    let hit: number | null = null,
      distance = 8;
    for (const point of points) {
      const d = Math.hypot(point.sx - screen[0], point.sy - screen[1]);
      if (d < distance) {
        distance = d;
        hit = point.index;
      }
    }
    return hit;
  }
  private snapEdge(screen: Point, uv: TopologyVertex, points: MeshScreenPoint[]) {
    let distance = 6,
      snapped = { screen, uv };
    for (const edge of this.draft.edges) {
      const a = points[edge.a],
        b = points[edge.b];
      if (!a || !b) continue;
      const dx = b.sx - a.sx,
        dy = b.sy - a.sy,
        length = dx * dx + dy * dy;
      if (!length) continue;
      const t = ((screen[0] - a.sx) * dx + (screen[1] - a.sy) * dy) / length;
      if (t <= 0 || t >= 1) continue;
      const target: Point = [a.sx + t * dx, a.sy + t * dy],
        d = Math.hypot(target[0] - screen[0], target[1] - screen[1]);
      if (d >= distance) continue;
      distance = d;
      const va = this.draft.vertices[edge.a],
        vb = this.draft.vertices[edge.b];
      snapped = {
        screen: target,
        uv: { u: va.u + t * (vb.u - va.u), v: va.v + t * (vb.v - va.v) },
      };
    }
    return snapped;
  }
  private sweepEraser(screen: Point, pointer: EraserPointer) {
    this.eraser = { center: screen, edgesOnly: pointer.edgesOnly };
    const stroke = this.stroke;
    if (!stroke || stroke.error) return;
    const hit = hitEraser(
      stroke.base,
      stroke.points,
      stroke.last,
      pointer.point,
      this.snapshot.eraserSize / 2,
      pointer.edgesOnly,
    );
    stroke.last = pointer.point;
    const oldVertices = stroke.vertices.size,
      oldEdges = stroke.edges.size;
    for (const index of hit.vertices) stroke.vertices.add(index);
    for (const key of hit.edges) stroke.edges.add(key);
    if (oldVertices === stroke.vertices.size && oldEdges === stroke.edges.size) return;
    stroke.pending = true;
    if (this.strokeFrame === null)
      this.strokeFrame = requestAnimationFrame(() => {
        this.strokeFrame = null;
        this.flushEraser();
        this.paint();
      });
  }
  private flushEraser() {
    if (this.strokeFrame !== null) cancelAnimationFrame(this.strokeFrame);
    this.strokeFrame = null;
    const stroke = this.stroke;
    if (!stroke?.pending || stroke.error) return;
    stroke.pending = false;
    try {
      this.draft = eraseMesh(stroke.base, stroke.vertices, stroke.edges);
    } catch (error) {
      this.draft = stroke.before;
      stroke.error = (error as Error).message;
      this.update({ error: stroke.error });
    }
  }
  pointerDown(
    screen: Point,
    uv: TopologyVertex | null,
    points: MeshScreenPoint[],
    additive: boolean,
    subtract: boolean,
    eraser: EraserPointer,
  ) {
    if (!this.snapshot.ready || this.snapshot.busy) return false;
    const hit = this.hit(screen, points),
      tool = this.snapshot.tool,
      before = this.draft;
    this.pen = null;
    if (tool === 'erase') {
      this.hover = null;
      this.draft = { ...before, selected: [] };
      this.stroke = {
        before,
        base: this.draft,
        points,
        last: eraser.point,
        vertices: new Set(),
        edges: new Set(),
        pending: false,
        error: '',
      };
      this.sweepEraser(screen, eraser);
      this.paint();
      return true;
    }
    if (!uv) return false;
    if (tool === 'add' && hit !== null && !before.selected.includes(hit) && !subtract) {
      this.change((d) => connectVertex(d, hit));
      this.draft = { ...this.draft, selected: additive ? [...before.selected, hit] : [hit] };
      this.update();
      this.paint();
      return false;
    }
    if (hit !== null && tool !== 'lasso') {
      const selected = new Set(additive || before.selected.includes(hit) ? before.selected : []);
      if (subtract || (additive && selected.has(hit))) selected.delete(hit);
      else selected.add(hit);
      this.draft = { ...before, selected: [...selected] };
      this.update();
      this.paint();
      if (!selected.has(hit)) return false;
      this.drag = {
        before: this.draft,
        start: screen,
        uv,
        points,
        kind: 'move',
        additive,
        subtract,
      };
    } else if (tool === 'add') {
      const point = this.snapEdge(screen, uv, points).uv;
      this.change((d) => insertVertex(d, point, additive));
      return false;
    } else {
      this.drag = {
        before,
        start: screen,
        uv,
        points,
        kind: tool === 'lasso' ? 'lasso' : 'rectangle',
        additive,
        subtract,
      };
      this.guide = [screen];
      if (!additive) this.draft = { ...before, selected: [] };
      this.paint();
    }
    return true;
  }
  pointerMove(
    screen: Point,
    uv: TopologyVertex | null,
    points: MeshScreenPoint[],
    eraser: EraserPointer,
  ) {
    if (!this.snapshot.ready || this.snapshot.busy) return;
    if (this.snapshot.tool === 'erase') {
      this.hover = null;
      this.sweepEraser(screen, eraser);
      this.paint();
      return;
    }
    const drag = this.drag;
    if (!drag) {
      const hover = this.hit(screen, points);
      if (this.snapshot.tool === 'add' && uv) {
        const snapped = hover === null ? this.snapEdge(screen, uv, points) : null;
        const target = hover === null ? snapped!.uv : this.draft.vertices[hover];
        const point = hover === null ? null : points.find((p) => p.index === hover);
        this.pen = {
          to: point ? [point.sx, point.sy] : snapped!.screen,
          from: this.draft.selected.filter((from) =>
            canConnect(this.draft, from, target, hover ?? undefined),
          ),
        };
        this.hover = hover;
        this.paint();
      } else if (hover !== this.hover || this.pen) {
        this.hover = hover;
        this.pen = null;
        this.paint();
      }
      return;
    }
    if (drag.kind === 'move' && uv && drag.uv) {
      if (Math.hypot(screen[0] - drag.start[0], screen[1] - drag.start[1]) < 2) {
        if (this.draft.vertices !== drag.before.vertices) {
          this.draft = drag.before;
          this.paint();
        }
        return;
      }
      const selected = new Set(drag.before.selected),
        du = uv.u - drag.uv.u,
        dv = uv.v - drag.uv.v;
      this.draft = {
        ...drag.before,
        vertices: drag.before.vertices.map((p, i) =>
          selected.has(i) ? { ...p, u: p.u + du, v: p.v + dv } : p,
        ),
      };
    } else if (drag.kind !== 'move') {
      if (drag.kind === 'rectangle')
        this.guide = [drag.start, [screen[0], drag.start[1]], screen, [drag.start[0], screen[1]]];
      else if (Math.hypot(screen[0] - this.guide.at(-1)![0], screen[1] - this.guide.at(-1)![1]) > 2)
        this.guide = [...this.guide, screen];
      const selected = new Set(drag.additive ? drag.before.selected : []);
      for (const p of drag.points) {
        let inside = false;
        for (let i = 0, j = this.guide.length - 1; i < this.guide.length; j = i++) {
          const a = this.guide[i],
            b = this.guide[j];
          if (
            a[1] > p.sy !== b[1] > p.sy &&
            p.sx < ((b[0] - a[0]) * (p.sy - a[1])) / (b[1] - a[1]) + a[0]
          )
            inside = !inside;
        }
        if (inside) {
          if (drag.subtract) selected.delete(p.index);
          else selected.add(p.index);
        }
      }
      this.draft = { ...drag.before, selected: [...selected] };
    }
    this.paint();
  }
  pointerUp() {
    if (this.stroke) {
      this.flushEraser();
      const stroke = this.stroke;
      if (geometryChanged(stroke.before, this.draft)) this.remember(stroke.before);
      this.stroke = null;
      this.update({ error: stroke.error });
      this.paint();
      return;
    }
    if (!this.drag) return;
    let error = '';
    if (this.drag.before.vertices !== this.draft.vertices) {
      try {
        const next = rebuildAutomaticEdges(this.draft);
        this.remember(this.drag.before);
        this.draft = next;
      } catch (cause) {
        this.draft = this.drag.before;
        error = (cause as Error).message;
      }
    }
    this.drag = null;
    this.guide = [];
    this.update({ error });
    this.paint();
  }
  cancelDrag() {
    if (this.stroke) {
      if (this.strokeFrame !== null) cancelAnimationFrame(this.strokeFrame);
      this.strokeFrame = null;
      this.draft = this.stroke.before;
      this.stroke = null;
      this.eraser = null;
      this.update();
      this.paint();
      return;
    }
    if (!this.drag) return;
    this.draft = this.drag.before;
    this.drag = null;
    this.guide = [];
    this.update();
    this.paint();
  }
  clearHover() {
    if (this.hover !== null || this.pen || this.eraser) {
      this.hover = null;
      this.pen = null;
      this.eraser = null;
      this.paint();
    }
  }
}
