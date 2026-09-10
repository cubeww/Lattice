import { bezierControls } from '../../../core/model/bezier';
import { RotationOriginEdit } from '../../../core/model/rotation-origin';
import { controllerPoints } from '../../../core/model/controller';
import { curveSamples } from '../../../core/model/curves';
import { modelingPoints, pointTriangles } from '../../../core/model/modeling-points';
import type {
  EditorState,
  ModelObject,
  PointSelection,
  VertexEdit,
  ViewState,
  TopologyVertex,
} from '../../../shared/types';
import type { SourcePreview, SourceScene, SourceNode, Affine } from '../../../shared/scene';
import {
  ModelEvaluator,
  type EvaluatedMesh,
  type EvaluatedDeformer,
  type Point,
} from '../../../core/model/evaluate';
import {
  applyMatrix,
  boundsOf,
  keyformAt,
  locked,
  related,
  inversePoint,
  type Bounds,
} from '../../../core/model/selection';
import { MeshRenderer } from './webgl';
import { pickMesh } from './picking';
import type { MeshPreview } from '../modeling/mesh-preview';
import { surfacePoint, sampleSurface, type SurfacePoint } from '../../../core/model/topology';
import {
  OperationError,
  type RenderStamp,
  type RenderModelOptions,
} from '../../../shared/workflow';
import { captureModel } from './model-capture';

export interface CanvasInteraction {
  hover: { guid: string; name: string; x: number; y: number } | null;
  selection: {
    guid: string;
    bounds: Bounds;
    screen: Bounds;
    reason: 'meshOnly' | 'keyform' | 'locked' | null;
  } | null;
  revision: number;
}
export interface CanvasPoint {
  guid: string;
  index: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
}
export type ViewCamera = Pick<ViewState, 'zoom' | 'panX' | 'panY'>;
export class SourceViewport {
  private renderer: MeshRenderer;
  private evaluator: ModelEvaluator | null = null;
  private meshPreview: MeshPreview | null = null;
  private meshEvaluator: ModelEvaluator | null = null;
  private manualMappings = new WeakMap<TopologyVertex, SurfacePoint>();
  private manualMappingMesh: EvaluatedMesh['source'] | null = null;
  private textureKey = '';
  private pendingMeshTextures = '';
  private meshTextureAbort: AbortController | null = null;
  private scene: SourceScene | null = null;
  private evaluated: EvaluatedMesh[] = [];
  private deformers: EvaluatedDeformer[] = [];
  private state: EditorState | null = null;
  private objects = new Map<string, ModelObject>();
  private lockedGuids = new Set<string>();
  private request = 0;
  private modelDirty = true;
  private renderDirty = true;
  private cameraPreview: ViewCamera | null = null;
  private disposed = false;
  private failed = false;
  private loadedRevision = -1;
  private requestedRevision = -1;
  private pointer: Point | null = null;
  private verticesPreview: VertexEdit[] | null = null;
  private pointsPreview: PointSelection | null = null;
  private guide: Point[] = [];
  private pathDraft: Point[] = [];
  private gluePreview: Map<
    string,
    { indexA: number; indexB: number; weightA: number; weightB: number }[]
  > | null = null;
  private rotationPreview: {
    guid: string;
    value: { x?: number; y?: number; angle?: number; scale?: number };
    preserveChildren: boolean;
  } | null = null;
  private rotationOriginEdit: RotationOriginEdit | null = null;
  private lastInteraction = '';
  private readonly abort = new AbortController();
  private refreshAbort: AbortController | null = null;
  private readonly resizeObserver: ResizeObserver;
  private projection = { scale: 1, x: 0, y: 0 };
  private frameWaiters = new Set<{
    revision: number;
    resolve: (stamp: RenderStamp) => void;
    reject: (error: Error) => void;
  }>();
  private frameAck = 0;
  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
    private reportError: (error: string) => void,
    private reportInteraction: (info: CanvasInteraction) => void,
  ) {
    this.renderer = new MeshRenderer(canvas, (error) => {
      this.failed = true;
      this.reportError(error);
    });
    this.resizeObserver = new ResizeObserver(() => {
      this.renderDirty = true;
      this.schedule();
    });
    this.resizeObserver.observe(canvas);
  }
  private async readScene(
    preview: SourcePreview,
    signal = this.abort.signal,
  ): Promise<SourceScene & { revision: number }> {
    const response = await fetch(preview.sceneUrl, { signal });
    if (!response.ok) throw new Error('Could not read the source scene.');
    return response.json();
  }
  async load(preview: SourcePreview) {
    try {
      const scene = await this.readScene(preview);
      if (this.disposed) return false;
      const evaluator = new ModelEvaluator(scene);
      await this.renderer.load(scene, this.abort.signal);
      if (this.disposed) return false;
      this.textureKey = this.sceneTextureKey(scene);
      this.scene = scene;
      this.evaluator = evaluator;
      this.setMeshPreview(this.meshPreview);
      this.loadedRevision = scene.revision;
      this.requestedRevision = scene.revision;
      this.schedule(true);
      return true;
    } catch (error) {
      this.renderer.dispose();
      throw error;
    }
  }
  private async refresh(preview: SourcePreview) {
    this.meshTextureAbort?.abort();
    this.pendingMeshTextures = '';
    this.refreshAbort?.abort();
    const controller = new AbortController();
    this.refreshAbort = controller;
    const signal = AbortSignal.any([this.abort.signal, controller.signal]);
    this.requestedRevision = preview.revision;
    try {
      const scene = await this.readScene(preview, signal);
      if (signal.aborted) return;
      const evaluator = new ModelEvaluator(scene);
      await this.renderer.load(scene, signal);
      if (signal.aborted) return;
      this.textureKey = this.sceneTextureKey(scene);
      this.evaluator = evaluator;
      this.scene = scene;
      this.loadedRevision = scene.revision;
      this.requestedRevision = scene.revision;
      this.setMeshPreview(
        this.meshPreview?.documentRevision === this.state?.documentRevision
          ? this.meshPreview
          : null,
      );
      this.verticesPreview = null;
      this.rotationPreview = null;
      this.rotationOriginEdit = null;
      this.schedule(true);
    } catch (error) {
      if (!signal.aborted) {
        this.failed = true;
        this.reportError(String(error));
      }
    }
  }
  update(state: EditorState) {
    if (this.state && state.revision <= this.state.revision) return;
    const previous = this.state;
    const parametersChanged =
      !previous ||
      Object.keys(state.parameterValues).length !== Object.keys(previous.parameterValues).length ||
      Object.entries(state.parameterValues).some(
        ([id, value]) => previous.parameterValues[id] !== value,
      );
    this.state = state;
    if (
      this.meshPreview &&
      (this.meshPreview.documentId !== state.preview?.id ||
        this.meshPreview.documentRevision !== state.documentRevision)
    )
      this.setMeshPreview(null);
    if (!previous || previous.documentRevision !== state.documentRevision) {
      // Names and locks can change without changing the rendered geometry.
      this.objects = new Map(state.document?.objects.map((o) => [o.guid, o]) || []);
      this.lockedGuids = new Set(
        [...this.objects.values()].filter((o) => locked(this.objects, o.guid)).map((o) => o.guid),
      );
    }
    if (this.scene && state.preview && state.preview.revision > this.requestedRevision)
      void this.refresh(state.preview);
    this.schedule(parametersChanged);
  }
  camera(): ViewCamera {
    const { zoom, panX, panY } = this.cameraPreview || this.state!.view;
    return { zoom, panX, panY };
  }
  setMeshPreview(value: MeshPreview | null) {
    // Keep the accepted preview on screen until the committed scene is ready.
    if (!value && this.meshPreview && (this.state?.preview?.revision ?? -1) > this.loadedRevision)
      return;
    const previous = this.meshPreview;
    this.meshPreview = value;
    const base = value?.scene || this.scene;
    if (!base || this.disposed) return;
    const key = this.sceneTextureKey(base);
    if (key !== this.textureKey) {
      if (this.pendingMeshTextures === key) return;
      this.meshTextureAbort?.abort();
      const controller = new AbortController();
      this.meshTextureAbort = controller;
      this.pendingMeshTextures = key;
      const signal = AbortSignal.any([controller.signal, this.abort.signal]);
      void this.renderer
        .load(base, signal)
        .then(() => {
          if (signal.aborted || this.disposed) return;
          this.textureKey = key;
          this.pendingMeshTextures = '';
          this.setMeshPreview(this.meshPreview);
        })
        .catch((error) => {
          if (!signal.aborted) {
            this.pendingMeshTextures = '';
            this.reportError(String(error));
          }
        });
      return;
    }
    this.meshTextureAbort?.abort();
    this.pendingMeshTextures = '';
    if (
      value &&
      this.meshEvaluator &&
      previous?.scene === value.scene &&
      previous.geometry === value.geometry &&
      previous.enabled === value.enabled
    ) {
      this.schedule(previous.manual?.showOthers !== value.manual?.showOthers);
      return;
    }
    this.meshEvaluator = null;
    if (value?.scene) {
      const meshes = new Map(
          (value.enabled ? value.geometry?.meshes || [] : []).map((m) => [m.guid, m]),
        ),
        glues = new Map((value.enabled ? value.geometry?.glues || [] : []).map((g) => [g.guid, g]));
      this.meshEvaluator = new ModelEvaluator({
        ...base,
        meshes: base.meshes.map((m) => meshes.get(m.guid) || m),
        glues: base.glues?.map((g) => glues.get(g.guid) || g),
      });
    }
    this.schedule(true);
  }
  private sceneTextureKey(scene: SourceScene) {
    return JSON.stringify(scene.textures.map((t) => [t.url, t.width, t.height]));
  }
  setCameraPreview(value: ViewCamera | null) {
    this.cameraPreview = value;
    this.schedule();
  }
  setPointer(point: Point | null) {
    this.pointer = point;
    this.schedule();
  }
  setVerticesPreview(edits: VertexEdit[] | null) {
    if (edits === null && this.verticesPreview === null) return;
    this.verticesPreview = edits;
    this.schedule(true);
  }
  setGluePreview(value: typeof this.gluePreview) {
    if (value === null && this.gluePreview === null) return;
    this.gluePreview = value;
    this.schedule(true);
  }
  setRotationPreview(value: typeof this.rotationPreview) {
    if (value === null && this.rotationPreview === null) return;
    if (!value || value.guid !== this.rotationPreview?.guid) this.rotationOriginEdit = null;
    this.rotationPreview = value;
    this.schedule(true);
  }
  rotation() {
    const node = this.deformers.find(
      (d) =>
        d.visible && d.source.guid === this.state?.selectedGuid && d.source.kind === 'rotation',
    );
    if (!node || !this.state) return null;
    const form = keyformAt(node.source, this.state.parameterValues);
    if (!form?.rotation) return null;
    const p = this.projection,
      center = node.transform(0, 0),
      end = node.transform(0, -(node.source.handleLength || 80));
    return {
      guid: node.source.guid,
      form: form.rotation,
      toCanvas: node.toCanvas,
      center,
      end,
      screenCenter: [p.x + center[0] * p.scale, p.y + center[1] * p.scale] as Point,
      screenEnd: [p.x + end[0] * p.scale, p.y + end[1] * p.scale] as Point,
      locked: this.lockedGuids.has(node.source.guid),
    };
  }
  setSelectionPreview(points: PointSelection | null) {
    this.pointsPreview = points;
    this.schedule();
  }
  setPathDraft(points: Point[]) {
    this.pathDraft = points;
    this.schedule();
  }
  glues() {
    if (!this.state) return [];
    const { x, y, scale } = this.projection;
    return (this.scene?.glues || [])
      .filter((g) =>
        this.state!.selectedGuids.some((id) => [g.guid, g.meshA, g.meshB].includes(id)),
      )
      .map((g) => {
        const a = this.evaluated.find((m) => m.source.guid === g.meshA),
          b = this.evaluated.find((m) => m.source.guid === g.meshB),
          pa = a?.ungluedPositions,
          pb = b?.ungluedPositions;
        return {
          glue: g,
          points:
            pa && pb
              ? g.pairs.map((pair, index) => {
                  const a: Point = [pa[pair.indexA * 2], pa[pair.indexA * 2 + 1]],
                    b: Point = [pb[pair.indexB * 2], pb[pair.indexB * 2 + 1]];
                  return {
                    index,
                    a,
                    b,
                    sa: [x + a[0] * scale, y + a[1] * scale] as Point,
                    sb: [x + b[0] * scale, y + b[1] * scale] as Point,
                  };
                })
              : [],
        };
      });
  }
  beziers() {
    if (!this.state || this.state.view.editLevel === 1) return [];
    const { x, y, scale } = this.projection;
    return this.deformers
      .filter(
        (d) =>
          d.visible &&
          d.source.kind === 'warp' &&
          this.state!.selectedGuids.includes(d.source.guid) &&
          !this.lockedGuids.has(d.source.guid),
      )
      .map((d) => {
        const settings = d.source.bezier?.find((b) => b.level === this.state!.view.editLevel) || {
            columns: 1,
            rows: 1,
          },
          grid = bezierControls(
            d.positions,
            d.source.columns,
            d.source.rows,
            settings.columns,
            settings.rows,
          );
        return {
          guid: d.source.guid,
          columns: d.source.columns,
          rows: d.source.rows,
          settings,
          positions: [...d.positions],
          grid,
          points: grid.points.map((point) => ({
            point,
            screen: [x + point[0] * scale, y + point[1] * scale] as Point,
          })),
        };
      });
  }
  controllers() {
    if (!this.state || this.state.view.editLevel === 1) return [];
    const p = this.projection;
    return this.evaluated
      .filter(
        (m) =>
          this.state!.selectedGuids.includes(m.source.guid) && !this.lockedGuids.has(m.source.guid),
      )
      .flatMap((mesh) =>
        (mesh.source.controllers || []).map((controller) => ({
          guid: mesh.source.guid,
          controller,
          positions: [...mesh.positions],
          points: controllerPoints(controller, mesh.positions).map((point) => ({
            point,
            screen: [p.x + point[0] * p.scale, p.y + point[1] * p.scale] as Point,
          })),
        })),
      );
  }
  setGuide(points: Point[]) {
    this.guide = points;
    this.schedule();
  }
  canvasPoint(sx: number, sy: number): Point {
    const { x, y, scale } = this.projection;
    return [(sx - x) / scale, (sy - y) / scale];
  }
  manualPoints(): CanvasPoint[] {
    const draft = this.meshPreview?.manual;
    if (!draft || this.pendingMeshTextures) return [];
    const mesh = this.evaluated.find((m) => m.source.guid === draft.guid);
    if (!mesh) return [];
    if (this.manualMappingMesh !== mesh.source) {
      this.manualMappingMesh = mesh.source;
      this.manualMappings = new WeakMap();
    }
    const projection = this.projection;
    return draft.vertices.map((vertex, index) => {
      let mapping = this.manualMappings.get(vertex);
      if (!mapping) {
        mapping = surfacePoint(mesh.source.uvs, mesh.source.indices, vertex.u, vertex.v);
        this.manualMappings.set(vertex, mapping);
      }
      const [x, y] = sampleSurface(mesh.positions, mapping);
      return {
        guid: draft.guid,
        index,
        x,
        y,
        sx: projection.x + x * projection.scale,
        sy: projection.y + y * projection.scale,
      };
    });
  }
  manualUvAt(sx: number, sy: number): TopologyVertex | null {
    const draft = this.meshPreview?.manual;
    if (!draft || this.pendingMeshTextures) return null;
    const mesh = this.evaluated.find((m) => m.source.guid === draft.guid);
    if (!mesh) return null;
    const [u, v] = sampleSurface(
      mesh.source.uvs,
      surfacePoint(mesh.positions, mesh.source.indices, ...this.canvasPoint(sx, sy)),
    );
    return { u, v };
  }
  points(selectedOnly = true): CanvasPoint[] {
    const state = this.state;
    if (!state) return [];
    const { x, y, scale } = this.projection;
    return modelingPoints(
      this.evaluated,
      this.deformers,
      this.objects,
      state.selectedGuids,
      !selectedOnly,
      this.lockedGuids,
    ).map((p) => ({ ...p, sx: x + p.x * scale, sy: y + p.y * scale }));
  }
  meshIndices(guid: string) {
    return this.scene ? pointTriangles(this.scene, guid) : [];
  }
  fitScale() {
    return this.scene
      ? Math.max(
          0.05,
          Math.min(
            8,
            (this.canvas.clientWidth - 100) / this.scene.canvas.width,
            (this.canvas.clientHeight - 90) / this.scene.canvas.height,
          ),
        )
      : 1;
  }
  private schedule(model = false) {
    this.modelDirty ||= model;
    if (this.request || this.disposed || this.failed) return;
    this.request = requestAnimationFrame(() => {
      this.request = 0;
      try {
        this.draw();
      } catch (error) {
        this.failed = true;
        this.reportError(String(error));
      }
    });
  }
  whenRendered(revision: number): Promise<RenderStamp> {
    if (this.disposed || this.failed)
      return Promise.reject(
        new OperationError('PREVIEW_UNAVAILABLE', 'The viewport is unavailable.'),
      );
    return new Promise((resolve, reject) => {
      const waiter = {
        revision,
        resolve: (stamp: RenderStamp) => {
          clearTimeout(timer);
          resolve(stamp);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.frameWaiters.delete(waiter);
        reject(
          new OperationError(
            'PREVIEW_TIMEOUT',
            'The viewport did not draw the requested revision.',
            { revision },
          ),
        );
      }, 45000);
      this.frameWaiters.add(waiter);
      this.schedule();
    });
  }
  renderModel(options: RenderModelOptions) {
    if (!this.scene || !this.state || this.failed || this.disposed)
      throw new OperationError('PREVIEW_UNAVAILABLE', 'The viewport is unavailable.');
    if (this.meshPreview || this.pendingMeshTextures)
      throw new OperationError(
        'EDITOR_BUSY',
        'Finish or cancel the mesh preview before rendering the committed model.',
      );
    const width = this.canvas.width,
      height = this.canvas.height;
    try {
      return captureModel(
        this.renderer,
        this.canvas,
        this.scene,
        this.objects,
        this.state.parameterValues,
        options,
      );
    } finally {
      this.canvas.width = width;
      this.canvas.height = height;
      this.renderer.setPose(this.evaluated);
      this.renderDirty = true;
      this.draw();
    }
  }
  private draw() {
    if (!this.scene || !this.evaluator || !this.state) return;
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1,
      pixelWidth = Math.round(width * dpr),
      pixelHeight = Math.round(height * dpr),
      state = this.state;
    for (const canvas of [this.canvas, this.overlay])
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        this.renderDirty = true;
      }
    const camera = this.camera(),
      scale = camera.zoom,
      x = width / 2 + camera.panX - (this.scene.canvas.width * scale) / 2,
      y = height / 2 + camera.panY - (this.scene.canvas.height * scale) / 2;
    this.renderDirty ||=
      x !== this.projection.x || y !== this.projection.y || scale !== this.projection.scale;
    this.projection = { x, y, scale };
    if (this.modelDirty && !this.pendingMeshTextures) {
      if (this.meshEvaluator) {
        this.evaluated = this.meshEvaluator.evaluate(state.parameterValues);
        this.deformers = this.meshEvaluator.evaluatedDeformers;
      } else if (this.verticesPreview || (!this.rotationPreview && !this.gluePreview)) {
        this.evaluated = this.evaluator.evaluate(state.parameterValues);
        this.deformers = this.evaluator.evaluatedDeformers;
      }
      if (!this.meshPreview && (this.verticesPreview || this.rotationPreview || this.gluePreview)) {
        const changed = new Set((this.verticesPreview || []).map((edit) => edit.guid));
        if (this.rotationPreview) changed.add(this.rotationPreview.guid);
        const draft = <T extends SourceNode>(node: T): T => {
          if (!changed.has(node.guid)) return node;
          const current = keyformAt(node, state.parameterValues);
          return {
            ...node,
            forms: node.forms.map((form) =>
              form === current
                ? {
                    ...form,
                    positions: [...form.positions],
                    rotation: form.rotation ? { ...form.rotation } : null,
                  }
                : form,
            ),
          };
        };
        // A drag changes only the selected forms, not every keyform and texture.
        let scene: SourceScene = {
          ...this.scene,
          meshes: this.scene.meshes.map(draft),
          deformers: this.scene.deformers.map(draft),
          glues: this.scene.glues?.map((glue) =>
            this.gluePreview?.has(glue.guid) ? { ...glue } : glue,
          ),
        };
        if (this.rotationPreview) {
          if (this.rotationPreview.preserveChildren) {
            this.rotationOriginEdit ??= new RotationOriginEdit(
              this.scene,
              this.rotationPreview.guid,
              state.parameterValues,
            );
            scene = this.rotationOriginEdit.apply(this.rotationPreview.value);
          } else {
            const node = scene.deformers.find((d) => d.guid === this.rotationPreview!.guid),
              form = node && keyformAt(node, state.parameterValues);
            if (form?.rotation) Object.assign(form.rotation, this.rotationPreview.value);
          }
        }
        for (const edit of this.verticesPreview || []) {
          const node = [...scene.deformers, ...scene.meshes].find((d) => d.guid === edit.guid),
            form = node && keyformAt(node, state.parameterValues),
            parent = [...this.deformers, ...this.evaluated].find(
              (d) => d.source.guid === edit.guid,
            )?.toCanvas;
          if (form && parent)
            for (const p of edit.points) {
              const i = p.index * 2,
                local = inversePoint(
                  parent,
                  [p.x, p.y],
                  [form.positions[i], form.positions[i + 1]],
                );
              form.positions[i] = local[0];
              form.positions[i + 1] = local[1];
            }
        }
        for (const [id, pairs] of this.gluePreview || []) {
          const glue = scene.glues?.find((g) => g.guid === id);
          if (glue) glue.pairs = pairs;
        }
        const evaluator = new ModelEvaluator(scene);
        this.evaluated = evaluator.evaluate(state.parameterValues);
        this.deformers = evaluator.evaluatedDeformers;
      }
      const manual = this.meshPreview?.manual;
      if (manual)
        this.evaluated = this.evaluated.map((mesh) => ({
          ...mesh,
          opacity:
            mesh.source.guid === manual.guid ? 1 : mesh.opacity * (manual.showOthers ? 0.15 : 0),
          visible: mesh.source.guid === manual.guid || mesh.visible,
        }));
      this.renderer.setPose(this.evaluated);
      this.modelDirty = false;
      this.renderDirty = true;
    }
    if (this.renderDirty) {
      this.renderer.draw([
        (2 * scale) / width,
        (-2 * scale) / height,
        (2 * x) / width - 1,
        1 - (2 * y) / height,
      ]);
      this.renderDirty = false;
    }
    const hoverGuid =
      this.pointer && state.view.tool === 'select' && !this.verticesPreview && !this.meshPreview
        ? this.hitTest(...this.pointer)
        : null;
    const ctx = this.overlay.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (state.view.grid) {
      ctx.strokeStyle = 'rgba(104,121,143,.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = Math.max(16, 100 * scale);
      for (let gx = x % step; gx < width; gx += step) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, height);
      }
      for (let gy = y % step; gy < height; gy += step) {
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
      }
      ctx.stroke();
    }
    if (this.meshPreview?.manual) {
      const draft = this.meshPreview.manual,
        points = this.manualPoints(),
        selected = new Set(draft.selected);
      for (const [priority, color] of [
        [10, '#12b6df'],
        [20, '#3ab981'],
        [30, '#dc5467'],
        [40, '#cc50d0'],
      ] as const) {
        ctx.beginPath();
        for (const edge of draft.edges) {
          if (edge.priority !== priority) continue;
          const a = points[edge.a],
            b = points[edge.b];
          if (!a || !b) continue;
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
        }
        ctx.lineWidth = priority >= 30 ? 1.3 : 1;
        if (priority >= 30) {
          ctx.strokeStyle = '#ffffffc0';
          ctx.stroke();
          ctx.setLineDash([2, 2]);
        }
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (draft.pen) {
        ctx.strokeStyle = '#dc5467';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        for (const from of draft.pen.from) {
          const point = points[from];
          if (!point) continue;
          ctx.moveTo(point.sx, point.sy);
          ctx.lineTo(...draft.pen.to);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const point of points) {
        const active = selected.has(point.index),
          hover = draft.hover === point.index;
        const size = active || hover ? 6 : 4;
        ctx.fillStyle = active ? '#ed5365' : hover ? '#65cc9e' : '#fff';
        ctx.strokeStyle = active ? '#b63148' : '#354856';
        ctx.fillRect(point.sx - size / 2, point.sy - size / 2, size, size);
        ctx.strokeRect(point.sx - size / 2, point.sy - size / 2, size, size);
      }
      if (draft.guide.length > 1) {
        ctx.strokeStyle = '#318f7a';
        ctx.fillStyle = '#318f7a18';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        draft.guide.forEach(([gx, gy], i) => (i ? ctx.lineTo(gx, gy) : ctx.moveTo(gx, gy)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (draft.eraser) {
        const { center, size, edgesOnly } = draft.eraser;
        ctx.beginPath();
        ctx.arc(center[0], center[1], (size * scale) / 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffffcc';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = edgesOnly ? '#218ca9' : '#a25865';
        ctx.fillStyle = edgesOnly ? '#218ca90a' : '#a258650a';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
      this.completeFrame(null, null, width, height);
      return;
    }
    const selected: EvaluatedMesh[] = [];
    const weights = this.pointsPreview || state.pointSelection;
    for (const mesh of this.evaluated) {
      if (!mesh.visible || mesh.opacity < 0.01) continue;
      const active = state.selectedGuids.some((guid) =>
          related(this.objects, mesh.source.guid, guid),
        ),
        hover = mesh.source.guid === hoverGuid;
      if (active) selected.push(mesh);
      if (!active && !hover && !state.view.mesh) continue;
      const px = (i: number) => x + mesh.positions[i * 2] * scale,
        py = (i: number) => y + mesh.positions[i * 2 + 1] * scale;
      ctx.strokeStyle = active
        ? 'rgba(63,85,98,.55)'
        : hover
          ? 'rgba(71,200,111,.7)'
          : 'rgba(61,123,155,.4)';
      ctx.lineWidth = active || hover ? 1 : 0.65;
      ctx.beginPath();
      const indices = mesh.source.indices;
      for (let i = 0; i < indices.length; i += 3) {
        ctx.moveTo(px(indices[i]), py(indices[i]));
        ctx.lineTo(px(indices[i + 1]), py(indices[i + 1]));
        ctx.lineTo(px(indices[i + 2]), py(indices[i + 2]));
        ctx.closePath();
      }
      ctx.stroke();
      if (
        active &&
        !mesh.source.path &&
        (this.meshPreview || state.view.editLevel === 1 || !mesh.source.controllers?.length)
      ) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#405762';
        for (let i = 0; i < mesh.positions.length / 2; i++) {
          const weight = weights[mesh.source.guid]?.[i] || 0;
          ctx.fillStyle = weight ? `rgba(237,83,101,${0.3 + 0.7 * weight})` : '#fff';
          ctx.beginPath();
          ctx.arc(px(i), py(i), 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    if (this.meshPreview) {
      this.completeFrame(null, null, width, height);
      return;
    }
    for (const d of this.deformers.filter(
      (d) => d.visible && state.selectedGuids.includes(d.source.guid),
    )) {
      ctx.strokeStyle = '#8da949';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (d.source.kind === 'warp') {
        const { columns, rows } = d.source;
        for (let r = 0; r <= rows; r++)
          for (let c = 0; c <= columns; c++) {
            const i = r * (columns + 1) + c,
              px = x + d.positions[i * 2] * scale,
              py = y + d.positions[i * 2 + 1] * scale;
            if (c < columns) {
              ctx.moveTo(px, py);
              ctx.lineTo(
                x + d.positions[(i + 1) * 2] * scale,
                y + d.positions[(i + 1) * 2 + 1] * scale,
              );
            }
            if (r < rows) {
              ctx.moveTo(px, py);
              ctx.lineTo(
                x + d.positions[(i + columns + 1) * 2] * scale,
                y + d.positions[(i + columns + 1) * 2 + 1] * scale,
              );
            }
          }
        ctx.stroke();
        if (state.view.editLevel === 1)
          for (let i = 0; i < d.positions.length / 2; i++) {
            ctx.fillStyle = weights[d.source.guid]?.[i] ? '#ef6e73' : '#fff';
            ctx.fillRect(
              x + d.positions[i * 2] * scale - 2,
              y + d.positions[i * 2 + 1] * scale - 2,
              4,
              4,
            );
            ctx.strokeRect(
              x + d.positions[i * 2] * scale - 2,
              y + d.positions[i * 2 + 1] * scale - 2,
              4,
              4,
            );
          }
      }
    }
    for (const g of this.glues())
      for (const p of g.points) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#caa349';
        ctx.beginPath();
        ctx.moveTo(...p.sa);
        ctx.lineTo(...p.sb);
        ctx.stroke();
        for (const [point, color] of [
          [p.sa, '#e87878'],
          [p.sb, '#78aa59'],
        ] as const) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(...point, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    for (const b of this.beziers()) {
      ctx.strokeStyle = '#80a245';
      ctx.lineWidth = 1;
      b.points.forEach((p, i) => {
        const c = i % b.grid.width,
          r = Math.floor(i / b.grid.width),
          anchor = c % 3 === 0 && r % 3 === 0;
        if (!anchor && c % 3 !== 0 && r % 3 !== 0) return;
        if (!anchor) {
          const ac = c % 3 === 1 ? c - 1 : c % 3 === 2 ? c + 1 : c,
            ar = r % 3 === 1 ? r - 1 : r % 3 === 2 ? r + 1 : r,
            a = b.points[ar * b.grid.width + ac];
          if (a) {
            ctx.beginPath();
            ctx.moveTo(...a.screen);
            ctx.lineTo(...p.screen);
            ctx.stroke();
          }
        }
        ctx.fillStyle = anchor ? '#8ab251' : '#fff';
        ctx.beginPath();
        ctx.arc(...p.screen, anchor ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
    for (const path of this.controllers()) {
      const points = path.points.map((p) => p.screen),
        curve = curveSamples(points, 20);
      ctx.strokeStyle = '#73a943';
      ctx.lineWidth = 2;
      ctx.beginPath();
      curve.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.stroke();
      for (const p of points) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(...p, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    for (const p of this.points().filter(
      (p) => this.scene!.meshes.find((m) => m.guid === p.guid)?.path,
    )) {
      ctx.fillStyle = weights[p.guid]?.[p.index] ? '#ee6a80' : '#fff';
      ctx.strokeStyle = '#57924f';
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (this.pathDraft.length) {
      const points = curveSamples(this.pathDraft, 20);
      ctx.strokeStyle = state.view.tool === 'artPath' ? state.toolSettings.pathColor : '#73a943';
      ctx.lineWidth = state.view.tool === 'artPath' ? state.toolSettings.pathWidth * scale : 2;
      ctx.beginPath();
      points.forEach((p, i) =>
        i
          ? ctx.lineTo(x + p[0] * scale, y + p[1] * scale)
          : ctx.moveTo(x + p[0] * scale, y + p[1] * scale),
      );
      ctx.stroke();
      ctx.lineWidth = 1;
      for (const p of this.pathDraft) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x + p[0] * scale, y + p[1] * scale, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    const rotation = this.rotation();
    if (rotation) {
      const { screenCenter: a, screenEnd: b } = rotation;
      ctx.strokeStyle = '#e35669';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(...a, 18, 0, Math.PI * 2);
      ctx.stroke();
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(...p, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    let selection: CanvasInteraction['selection'] = null;
    const editablePoints = this.points();
    if ((selected.length || editablePoints.length) && state.selectedGuid) {
      const partial = editablePoints.filter((p) => weights[p.guid]?.[p.index] > 0);
      const positions = (partial.length ? partial : editablePoints).flatMap((p) => [p.x, p.y]);
      const bounds = boundsOf(
        positions.length ? positions : selected.flatMap((mesh) => [...mesh.positions]),
      );
      const sources = state.selectedGuids.map((guid) =>
        [...this.scene!.meshes, ...this.scene!.deformers.filter((d) => d.kind === 'warp')].find(
          (m) => m.guid === guid,
        ),
      );
      const reason = sources.some((source) => !source)
        ? 'meshOnly'
        : sources.some((source) => this.lockedGuids.has(source!.guid))
          ? 'locked'
          : sources.some((source) => !keyformAt(source!, state.parameterValues))
            ? 'keyform'
            : null;
      selection = {
        guid: state.selectedGuid,
        bounds,
        screen: {
          x: x + bounds.x * scale - 5,
          y: y + bounds.y * scale - 5,
          width: bounds.width * scale + 10,
          height: bounds.height * scale + 10,
        },
        reason,
      };
    }
    if (this.guide.length) {
      ctx.beginPath();
      this.guide.forEach((point, i) => (i ? ctx.lineTo(...point) : ctx.moveTo(...point)));
      ctx.closePath();
      ctx.strokeStyle = '#d55167';
      ctx.fillStyle = '#ed536514';
      ctx.setLineDash([4, 3]);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.pointer && ['brushSelect', 'deformBrush', 'glue'].includes(state.view.tool)) {
      const brush = state.toolSettings,
        r = (brush.size * scale) / 2;
      ctx.save();
      ctx.translate(...this.pointer);
      ctx.rotate((brush.angle * Math.PI) / 180);
      ctx.strokeStyle = '#3b778bcc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (brush.shape === 'circle') ctx.arc(0, 0, r, 0, Math.PI * 2);
      else ctx.rect(-r, -r, 2 * r, 2 * r);
      ctx.stroke();
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      if (brush.shape === 'circle') ctx.arc(0, 0, r * brush.hardness, 0, Math.PI * 2);
      else
        ctx.rect(
          -r * brush.hardness,
          -r * brush.hardness,
          2 * r * brush.hardness,
          2 * r * brush.hardness,
        );
      ctx.stroke();
      ctx.restore();
    }
    this.completeFrame(hoverGuid, selection, width, height);
  }
  private completeFrame(
    hoverGuid: string | null,
    selection: CanvasInteraction['selection'],
    width: number,
    height: number,
  ) {
    const object = hoverGuid ? this.objects.get(hoverGuid) : null;
    const info: CanvasInteraction = {
      selection,
      hover:
        object && this.pointer
          ? {
              guid: object.guid,
              name: object.name || object.id,
              x: Math.min(width - 160, this.pointer[0] + 14),
              y: Math.max(4, this.pointer[1] - 26),
            }
          : null,
      revision: this.loadedRevision,
    };
    const json = JSON.stringify(info);
    if (json !== this.lastInteraction) {
      this.lastInteraction = json;
      this.reportInteraction(info);
    }
    this.overlay.dataset.hoveredGuid = hoverGuid || '';
    this.canvas.dataset.meshPreview = this.pendingMeshTextures
      ? 'loading'
      : this.meshPreview?.manual
        ? 'manual'
        : this.meshPreview
          ? this.meshPreview.enabled && this.meshPreview.geometry && this.meshEvaluator
            ? 'generated'
            : 'original'
          : '';
    this.canvas.dataset.previewVertices = this.meshPreview?.manual
      ? String(this.meshPreview.manual.vertices.length)
      : this.meshPreview?.enabled && this.meshPreview.geometry && this.meshEvaluator
        ? String(this.meshPreview!.geometry!.meshes.reduce((n, mesh) => n + mesh.uvs.length / 2, 0))
        : '';
    this.canvas.dataset.rendered = 'true';
    this.canvas.dataset.renderer = 'lattice-webgl2';
    this.canvas.dataset.sceneRevision = String(this.loadedRevision);
    this.canvas.dataset.stateRevision = String(this.state!.revision);
    const state = this.state!;
    if (
      this.frameWaiters.size &&
      this.loadedRevision >= (state.preview?.revision ?? Infinity) &&
      !this.pendingMeshTextures &&
      !this.modelDirty
    ) {
      const stamp = {
        revision: state.revision,
        previewId: state.preview!.id,
        sceneRevision: this.loadedRevision,
      };
      cancelAnimationFrame(this.frameAck);
      // Acknowledge after the submitted draw has had a compositor frame, not after texture loading.
      this.frameAck = requestAnimationFrame(() => {
        this.frameAck = 0;
        for (const waiter of this.frameWaiters)
          if (stamp.revision >= waiter.revision) {
            this.frameWaiters.delete(waiter);
            waiter.resolve(stamp);
          }
      });
    }
  }
  hitTest(screenX: number, screenY: number) {
    if (!this.renderer.alphas.length) return null;
    const { x, y, scale } = this.projection;
    return pickMesh(
      this.evaluated,
      this.renderer.alphas,
      (screenX - x) / scale,
      (screenY - y) / scale,
      this.lockedGuids,
    );
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    cancelAnimationFrame(this.request);
    cancelAnimationFrame(this.frameAck);
    for (const waiter of this.frameWaiters)
      waiter.reject(new OperationError('PREVIEW_REPLACED', 'The viewport was closed or replaced.'));
    this.frameWaiters.clear();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
