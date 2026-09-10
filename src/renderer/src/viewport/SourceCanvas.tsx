import { moveBezierControl } from '../../../core/model/bezier';
import { operationError } from '../../../shared/workflow';
import { controllerDisplacement } from '../../../core/model/controller';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../store';
import { getMeshPreview, subscribeMeshPreview } from '../modeling/mesh-preview';
import { FrameCommand } from '../frame-command';
import { getManualMeshSession, useManualMeshState } from '../modeling/manual-mesh-session';
import { MeshEditBar } from '../modeling/MeshEditControls';
import {
  SourceViewport,
  type CanvasInteraction,
  type CanvasPoint,
  type ViewCamera,
} from './source';
import {
  handles,
  applyMatrix,
  identityMatrix,
  resizeMatrix,
  inversePoint,
  type Bounds,
  type ResizeHandle,
} from '../../../core/model/selection';
import type { Affine } from '../../../shared/scene';
import type { EditorState, PointSelection, ToolSettings, VertexEdit } from '../../../shared/types';
import type { Point } from '../../../core/model/evaluate';
import {
  brushWeight,
  strokeSamples,
  paintSelection,
  selectPointRegion,
  DeformationStroke,
} from '../../../core/model/brush';
import { groupVertexEdits as groupEdits } from '../../../core/model/modeling-points';

type Drag =
  | { kind: 'mesh'; pointer: number }
  | {
      kind: 'glue';
      pointer: number;
      x: number;
      y: number;
      revision: number;
      last: Point;
      groups: ReturnType<SourceViewport['glues']>;
      settings: ToolSettings;
      changed: boolean;
    }
  | {
      kind: 'bezier';
      pointer: number;
      x: number;
      y: number;
      revision: number;
      warp: ReturnType<SourceViewport['beziers']>[number];
      index: number;
      edits: VertexEdit[];
      changed: boolean;
    }
  | {
      kind: 'controller';
      pointer: number;
      x: number;
      y: number;
      revision: number;
      path: ReturnType<SourceViewport['controllers']>[number];
      index: number;
      edits: VertexEdit[];
      changed: boolean;
    }
  | {
      kind: 'rotation';
      pointer: number;
      x: number;
      y: number;
      revision: number;
      rotation: NonNullable<ReturnType<SourceViewport['rotation']>>;
      mode: 'move' | 'rotate';
      preserveChildren: boolean;
      startAngle: number;
      startLength: number;
      value: { x?: number; y?: number; angle?: number; scale?: number };
      changed: boolean;
    }
  | {
      kind: 'rotationDraw';
      pointer: number;
      x: number;
      y: number;
      revision: number;
      origin: Point;
      end: Point;
    }
  | { kind: 'pan'; pointer: number; x: number; y: number; origin: ViewCamera; latest: ViewCamera }
  | {
      kind: 'transform';
      pointer: number;
      x: number;
      y: number;
      guid: string;
      revision: number;
      zoom: number;
      bounds: Bounds;
      handle: ResizeHandle | 'move';
      matrix: Affine;
      changed: boolean;
      points: CanvasPoint[];
      weights: PointSelection;
      edits: VertexEdit[];
    }
  | {
      kind: 'region' | 'paint';
      pointer: number;
      x: number;
      y: number;
      revision: number;
      path: Point[];
      canvasPath: Point[];
      additive: boolean;
      points: CanvasPoint[];
      weights: PointSelection;
      initial: PointSelection;
      subtract: boolean;
      rectangle: boolean;
      settings: ToolSettings;
    }
  | {
      kind: 'brush';
      pointer: number;
      x: number;
      y: number;
      revision: number;
      last: Point;
      path: Point[];
      stroke: DeformationStroke;
      points: CanvasPoint[];
      weights: PointSelection;
      settings: ToolSettings;
      edits: VertexEdit[];
      changed: boolean;
    };

export function SourceCanvas() {
  const { state, command, perform, t } = useEditor();
  const manual = useManualMeshState();
  const canvas = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    stack = useRef<HTMLDivElement>(null);
  const viewport = useRef<SourceViewport | null>(null),
    current = useRef(state),
    dragging = useRef<Drag | null>(null);
  const [interaction, setInteraction] = useState<CanvasInteraction>({
    hover: null,
    selection: null,
    revision: -1,
  });
  const [space, setSpace] = useState(false),
    [draggingNow, setDraggingNow] = useState(false),
    [committing, setCommitting] = useState(false);
  const busy = useRef(false);
  const cameraGeneration = useRef(0),
    ownCameraUpdates = useRef(
      new Set<{
        key: string;
        revision: number;
        value: ViewCamera & { tool: EditorState['view']['tool']; previewId: string | null };
      }>(),
    ),
    lastCamera = useRef(state.view),
    appliedRevision = useRef(state.revision);
  const acceptCamera = useRef<(next: EditorState) => void>(() => {});
  const cameraKey = (value: ViewCamera) => `${value.zoom},${value.panX},${value.panY}`;
  const commitCamera = async (value: ViewCamera) => {
    const view = viewport.current,
      generation = cameraGeneration.current;
    if (!view) return;
    const expectedCamera = [...ownCameraUpdates.current].at(-1)?.value || {
      ...lastCamera.current,
      previewId: current.current.preview?.id || null,
    };
    const pending = {
      key: cameraKey(value),
      revision: Infinity,
      value: { ...value, tool: expectedCamera.tool, previewId: expectedCamera.previewId },
    };
    ownCameraUpdates.current.add(pending);
    try {
      const next = await window.lattice.command({ type: 'view', value, expectedCamera });
      pending.revision = next.revision;
      acceptCamera.current(next);
      if (appliedRevision.current >= next.revision) ownCameraUpdates.current.delete(pending);
      if (cameraGeneration.current === generation && viewport.current === view) {
        view.update(next);
        // An older acknowledgement must not replace a newer visible camera.
        if (dragging.current?.kind !== 'pan' && cameraKey(view.camera()) === pending.key)
          view.setCameraPreview(null);
      }
    } catch (error) {
      ownCameraUpdates.current.delete(pending);
      if (cameraGeneration.current === generation && viewport.current === view)
        view.setCameraPreview(null);
      throw error;
    }
  };
  const wheelCommands = useRef<FrameCommand<ViewCamera> | null>(null);
  if (!wheelCommands.current)
    wheelCommands.current = new FrameCommand(commitCamera, (error) =>
      perform(() => Promise.reject(error)),
    );
  const commitPan = (drag: Extract<Drag, { kind: 'pan' }>) => {
    if (
      !ownCameraUpdates.current.size &&
      cameraKey(drag.latest) === cameraKey(drag.origin) &&
      cameraKey(drag.latest) === cameraKey(lastCamera.current)
    ) {
      viewport.current?.setCameraPreview(null);
      return;
    }
    perform(() => commitCamera(drag.latest));
  };
  const pathDraft = useRef<{
    points: Point[];
    revision: number;
    tool: string;
    context: string;
  } | null>(null);
  const pathContext = JSON.stringify([
    state.preview?.id,
    state.documentRevision,
    state.selectedGuid,
    state.parameterValues,
  ]);
  const [pathCount, setPathCount] = useState(0);
  const finishPath = () => {
    const draft = pathDraft.current,
      s = current.current;
    if (!draft || draft.points.length < 2 || busy.current) return;
    const object = s.document?.objects.find((o) => o.guid === s.selectedGuid);
    busy.current = true;
    setCommitting(true);
    perform(async () => {
      try {
        await window.lattice.command(
          draft.tool === 'artPath'
            ? {
                type: 'createArtPath',
                points: draft.points,
                name: 'ArtPath',
                width: s.toolSettings.pathWidth,
                color: s.toolSettings.pathColor,
                parentGuid: object?.kind === 'part' ? object.guid : object?.parentGuid || null,
                deformerGuid:
                  object?.kind === 'warp' || object?.kind === 'rotation'
                    ? object.guid
                    : object?.deformerGuid || null,
                expectedRevision: draft.revision,
              }
            : {
                type: 'createController',
                guid: s.selectedGuid!,
                points: draft.points,
                width: s.toolSettings.size * 2,
                hardness: s.toolSettings.hardness,
                expectedRevision: draft.revision,
              },
        );
        pathDraft.current = null;
        setPathCount(0);
        viewport.current?.setPathDraft([]);
        await window.lattice.command({ type: 'view', value: { tool: 'select', editLevel: 2 } });
      } finally {
        busy.current = false;
        setCommitting(false);
      }
    });
  };
  const finishPathRef = useRef(finishPath);
  finishPathRef.current = finishPath;
  const fittedDocument = useRef<string | null>(null);
  current.current = state;
  const asset = state.preview!,
    selection = interaction.selection;
  const panMode = space || (manual ? manual.tool === 'pan' : state.view.tool === 'pan');
  const editable =
    !!selection &&
    !selection.reason &&
    interaction.revision === asset.revision &&
    !committing &&
    state.previewReady;

  const release = (pointer: number) => {
    if (stack.current?.hasPointerCapture(pointer)) stack.current.releasePointerCapture(pointer);
  };
  const cancel = () => {
    const drag = dragging.current;
    dragging.current = null;
    setDraggingNow(false);
    if (drag) {
      release(drag.pointer);
      if (drag.kind === 'pan') commitPan(drag);
      if (drag.kind === 'mesh') getManualMeshSession()?.cancelDrag();
    }
    pathDraft.current = null;
    setPathCount(0);
    viewport.current?.setPathDraft([]);
    viewport.current?.setVerticesPreview(null);
    viewport.current?.setRotationPreview(null);
    viewport.current?.setGluePreview(null);
    viewport.current?.setSelectionPreview(null);
    viewport.current?.setGuide([]);
    viewport.current?.setPointer(null);
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  acceptCamera.current = (next) => {
    if (next.revision <= appliedRevision.current) return;
    const previous = lastCamera.current,
      camera = next.view,
      key = cameraKey(camera);
    // Fit and external camera commands take precedence over local input.
    if (
      camera.tool !== previous.tool ||
      (key !== cameraKey(previous) &&
        ![...ownCameraUpdates.current].some((pending) => pending.key === key))
    ) {
      cameraGeneration.current++;
      wheelCommands.current!.cancel();
      ownCameraUpdates.current.clear();
      const pan = dragging.current;
      if (pan?.kind === 'pan') {
        dragging.current = null;
        release(pan.pointer);
        setDraggingNow(false);
      }
      viewport.current?.setCameraPreview(null);
    }
    for (const pending of ownCameraUpdates.current)
      if (pending.key === key || pending.revision <= next.revision)
        ownCameraUpdates.current.delete(pending);
    lastCamera.current = camera;
    appliedRevision.current = next.revision;
  };

  useEffect(() => {
    let disposed = false;
    let unsubscribe = () => {},
      unsubscribePreview = () => {},
      unsubscribeMeshPreview = () => {};
    const fail = (error: string) => {
      if (!disposed) perform(() => window.lattice.previewReady(asset.id, error));
    };
    try {
      const view = new SourceViewport(canvas.current!, overlay.current!, fail, (info) => {
        if (!disposed) setInteraction(info);
      });
      viewport.current = view;
      view.update(current.current);
      unsubscribePreview = window.lattice.onPreviewRequest(async (request) => {
        try {
          const stamp = await view.whenRendered(request.revision);
          return {
            id: request.id,
            result: {
              stamp,
              ...(request.options ? { images: view.renderModel(request.options) } : {}),
            },
          };
        } catch (error) {
          // contextBridge copies Error messages but drops custom fields; serialize here.
          return { id: request.id, error: operationError(error) };
        }
      });
      unsubscribeMeshPreview = subscribeMeshPreview(() => {
        const preview = getMeshPreview();
        view.setMeshPreview(preview?.documentId === asset.id ? preview : null);
      });
      // Schedule the canvas directly from IPC, without waiting for panel renders
      // and React's post-paint effects. The later React update has the same revision.
      unsubscribe = window.lattice.onState((next) => {
        acceptCamera.current(next);
        if (next.preview?.id === asset.id) view.update(next);
      });
      view
        .load(asset)
        .then(async (loaded) => {
          if (disposed || !loaded) return;
          const meshPreview = getMeshPreview();
          view.setMeshPreview(meshPreview?.documentId === asset.id ? meshPreview : null);
          if (fittedDocument.current !== current.current.document?.rootPartGuid) {
            fittedDocument.current = current.current.document?.rootPartGuid || null;
            const fitted = await window.lattice.command({
              type: 'view',
              value: { zoom: view.fitScale(), panX: 0, panY: 0 },
            });
            if (disposed) return;
            view.update(fitted);
          }
          await window.lattice.previewReady(asset.id, null);
        })
        .catch((error) => {
          if (!disposed && error?.name !== 'AbortError') fail(String(error));
        });
    } catch (error) {
      fail(String(error));
    }
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribePreview();
      unsubscribeMeshPreview();
      cameraGeneration.current++;
      wheelCommands.current!.cancel();
      ownCameraUpdates.current.clear();
      viewport.current?.dispose();
      viewport.current = null;
    };
  }, [asset.id]);
  useEffect(() => {
    acceptCamera.current(state);
    const drag = dragging.current;
    if (drag && drag.kind !== 'pan' && drag.kind !== 'mesh' && drag.revision !== state.revision)
      cancelRef.current();
    if (drag?.kind === 'mesh' && !getManualMeshSession()) cancelRef.current();
    if (pathDraft.current) {
      if (pathDraft.current.tool !== state.view.tool || pathDraft.current.context !== pathContext) {
        pathDraft.current = null;
        setPathCount(0);
        viewport.current?.setPathDraft([]);
      } else pathDraft.current.revision = state.revision;
    }
    viewport.current?.update(state);
  }, [state]);
  useEffect(() => {
    const fit = () => {
      wheelCommands.current!.cancel();
      cancelRef.current();
      viewport.current?.setCameraPreview(null);
      if (viewport.current)
        command({ type: 'view', value: { zoom: viewport.current.fitScale(), panX: 0, panY: 0 } });
    };
    const down = (event: KeyboardEvent) => {
      if (document.querySelector('[role=dialog][aria-modal=true]')) return;
      const mesh = getManualMeshSession();
      if (
        mesh &&
        event.code !== 'Space' &&
        !(event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey)
      ) {
        if (
          (event.target as HTMLElement).closest(
            'input:not([type=checkbox]),textarea,select,[contenteditable=true]',
          )
        )
          return;
        if (event.key === 'Tab') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (mesh.snapshot.busy) return;
        const key = event.key.toLowerCase(),
          modifier = event.ctrlKey || event.metaKey;
        if (modifier && key === 'z') {
          if (dragging.current?.kind === 'mesh') cancelRef.current();
          else if (event.shiftKey) mesh.redo();
          else mesh.undo();
        } else if (modifier && key === 'y') mesh.redo();
        else if (modifier && key === 'a') mesh.selectAll();
        else if (event.key === 'Escape') {
          if (dragging.current?.kind === 'mesh') cancelRef.current();
          else mesh.cancel();
        } else if (event.key === 'Enter') mesh.finish();
        else if (event.key === 'Delete' || event.key === 'Backspace') mesh.remove();
        else if (!modifier) {
          const tools = { v: 'select', l: 'lasso', a: 'add', e: 'erase', h: 'pan' } as const;
          if (key in tools) mesh.setTool(tools[key as keyof typeof tools]);
        }
        return;
      }
      if (getMeshPreview() && event.code !== 'Space' && event.key.toLowerCase() !== 'f') return;
      if (
        (event.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable=true],.parameter-panel,.parameter-menu',
        )
      )
        return;
      if (
        dragging.current &&
        dragging.current.kind !== 'pan' &&
        (event.key === 'Escape' ||
          ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelRef.current();
        return;
      }
      if (event.key === 'Enter' && pathDraft.current) {
        event.preventDefault();
        finishPathRef.current();
        return;
      }
      if (event.key === 'Escape' && pathDraft.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key === 'Escape') {
        cancelRef.current();
        command({ type: 'select', guid: null });
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (dragging.current && dragging.current.kind !== 'pan') cancelRef.current();
        setSpace(true);
        viewport.current?.setPointer(null);
      }
      if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) fit();
      if (['[', ']'].includes(event.key) && !dragging.current) {
        event.preventDefault();
        command({
          type: 'toolSettings',
          value: {
            size: Math.max(
              0.1,
              Math.min(10000, current.current.toolSettings.size * (event.key === '[' ? 0.8 : 1.25)),
            ),
          },
        });
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false);
    };
    const blur = () => {
      setSpace(false);
      wheelCommands.current!.flush();
      cancelRef.current();
    };
    window.addEventListener('lattice:fit', fit);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('lattice:fit', fit);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  useEffect(() => {
    const element = canvas.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (dragging.current || busy.current || !viewport.current) return;
      const rect = element.getBoundingClientRect(),
        view = viewport.current.camera();
      const x = event.clientX - rect.left - rect.width / 2,
        y = event.clientY - rect.top - rect.height / 2;
      const zoom = Math.max(0.05, Math.min(8, view.zoom * Math.exp(-event.deltaY * 0.0015))),
        ratio = zoom / view.zoom;
      const value = { zoom, panX: x - (x - view.panX) * ratio, panY: y - (y - view.panY) * ratio };
      viewport.current.setCameraPreview(value);
      wheelCommands.current!.queue(value);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy.current || !state.previewReady || (event.button !== 0 && event.button !== 1)) return;
    const meshSession = getManualMeshSession();
    if (getMeshPreview() && !meshSession && event.button !== 1 && !panMode) return;
    event.preventDefault();
    wheelCommands.current!.flush();
    stack.current?.focus({ preventScroll: true });
    const rect = canvas.current!.getBoundingClientRect();
    const screen: Point = [event.clientX - rect.left, event.clientY - rect.top],
      view = viewport.current!;
    if (event.button === 1 || panMode) {
      meshSession?.clearHover();
      viewport.current?.setPointer(null);
      cameraGeneration.current++;
      const camera = view.camera();
      dragging.current = {
        kind: 'pan',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        origin: camera,
        latest: camera,
      };
    } else if (meshSession) {
      if (
        !meshSession.pointerDown(
          screen,
          view.manualUvAt(...screen),
          view.manualPoints(),
          event.shiftKey,
          event.shiftKey && (event.ctrlKey || event.metaKey),
          { point: view.canvasPoint(...screen), edgesOnly: event.altKey },
        )
      )
        return;
      dragging.current = { kind: 'mesh', pointer: event.pointerId };
    } else if (
      state.view.tool === 'select' &&
      view.rotation() &&
      !view.rotation()!.locked &&
      [view.rotation()!.screenCenter, view.rotation()!.screenEnd].some(
        (p) => Math.hypot(p[0] - screen[0], p[1] - screen[1]) < 22,
      )
    ) {
      const rotation = view.rotation()!,
        point = view.canvasPoint(...screen),
        mode =
          Math.hypot(rotation.screenCenter[0] - screen[0], rotation.screenCenter[1] - screen[1]) <
          22
            ? 'move'
            : 'rotate';
      dragging.current = {
        kind: 'rotation',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        revision: state.revision,
        rotation,
        mode,
        preserveChildren: mode === 'move' && (event.ctrlKey || event.metaKey),
        startAngle: Math.atan2(point[1] - rotation.center[1], point[0] - rotation.center[0]),
        startLength: Math.hypot(point[0] - rotation.center[0], point[1] - rotation.center[1]),
        value: {},
        changed: false,
      };
    } else if (
      state.view.tool === 'select' &&
      view
        .beziers()
        .some((b) =>
          b.points.some(
            (p, i) =>
              ((i % b.grid.width) % 3 === 0 || Math.floor(i / b.grid.width) % 3 === 0) &&
              Math.hypot(p.screen[0] - screen[0], p.screen[1] - screen[1]) < 7,
          ),
        )
    ) {
      const warp = view
          .beziers()
          .find((b) =>
            b.points.some(
              (p, i) =>
                ((i % b.grid.width) % 3 === 0 || Math.floor(i / b.grid.width) % 3 === 0) &&
                Math.hypot(p.screen[0] - screen[0], p.screen[1] - screen[1]) < 7,
            ),
          )!,
        index = warp.points.findIndex(
          (p, i) =>
            ((i % warp.grid.width) % 3 === 0 || Math.floor(i / warp.grid.width) % 3 === 0) &&
            Math.hypot(p.screen[0] - screen[0], p.screen[1] - screen[1]) < 7,
        );
      dragging.current = {
        kind: 'bezier',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        revision: state.revision,
        warp,
        index,
        edits: [],
        changed: false,
      };
    } else if (
      ['select', 'deformPath'].includes(state.view.tool) &&
      view
        .controllers()
        .some((path) =>
          path.points.some((p) => Math.hypot(p.screen[0] - screen[0], p.screen[1] - screen[1]) < 8),
        )
    ) {
      const path = view
          .controllers()
          .find((path) =>
            path.points.some(
              (p) => Math.hypot(p.screen[0] - screen[0], p.screen[1] - screen[1]) < 8,
            ),
          )!,
        index = path.points.findIndex(
          (p) => Math.hypot(p.screen[0] - screen[0], p.screen[1] - screen[1]) < 8,
        );
      dragging.current = {
        kind: 'controller',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        revision: state.revision,
        path,
        index,
        edits: [],
        changed: false,
      };
    } else if (state.view.tool === 'artPath' || state.view.tool === 'deformPath') {
      if (
        state.view.tool === 'deformPath' &&
        !state.document?.objects.some((o) => o.guid === state.selectedGuid && o.kind === 'mesh')
      )
        return;
      const draft = pathDraft.current || {
        points: [],
        revision: state.revision,
        tool: state.view.tool,
        context: pathContext,
      };
      draft.points.push(view.canvasPoint(...screen));
      pathDraft.current = draft;
      setPathCount(draft.points.length);
      view.setPathDraft(draft.points);
      return;
    } else if (state.view.tool === 'rotationDraw') {
      const point = view.canvasPoint(...screen);
      dragging.current = {
        kind: 'rotationDraw',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        revision: state.revision,
        origin: point,
        end: point,
      };
    } else if (state.view.tool === 'glue' && view.glues().length) {
      dragging.current = {
        kind: 'glue',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        revision: state.revision,
        last: view.canvasPoint(...screen),
        groups: structuredClone(view.glues()),
        settings: { ...state.toolSettings },
        changed: false,
      };
      view.setPointer(screen);
    } else if (state.view.tool === 'lasso' || state.view.tool === 'brushSelect') {
      const weights = event.shiftKey ? structuredClone(state.pointSelection) : {};
      dragging.current = {
        kind: state.view.tool === 'lasso' ? 'region' : 'paint',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        revision: state.revision,
        path: [screen],
        canvasPath: [view.canvasPoint(...screen)],
        additive: event.shiftKey,
        points: view.points(!!state.selectedGuids.length),
        weights,
        initial: structuredClone(weights),
        subtract: event.shiftKey && (event.ctrlKey || event.metaKey),
        rectangle: false,
        settings: { ...state.toolSettings },
      };
      if (dragging.current.kind === 'paint')
        paintSelection(
          dragging.current.points,
          weights,
          dragging.current.canvasPath[0],
          dragging.current.canvasPath[0],
          dragging.current.settings,
          dragging.current.subtract,
        );
      view.setSelectionPreview(weights);
      view.setPointer(screen);
    } else if (state.view.tool === 'deformBrush') {
      if (!editable) return;
      const points = view.points(),
        edits = groupEdits(points),
        weights = structuredClone(state.pointSelection);
      dragging.current = {
        kind: 'brush',
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        revision: state.revision,
        last: view.canvasPoint(...screen),
        path: [view.canvasPoint(...screen)],
        stroke: new DeformationStroke(
          edits,
          (guid) => view.meshIndices(guid),
          state.toolSettings,
          weights,
        ),
        points,
        weights,
        settings: { ...state.toolSettings },
        edits,
        changed: false,
      };
      view.setPointer(screen);
    } else {
      const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset
        .handle as ResizeHandle | 'move' | undefined;
      const hit =
        viewport.current?.hitTest(event.clientX - rect.left, event.clientY - rect.top) || null;
      const vertex =
        state.view.editLevel === 1 ||
        state.document?.objects.some(
          (o) => state.selectedGuids.includes(o.guid) && o.kind === 'artpath',
        )
          ? view
              .points()
              .filter((p) => Math.hypot(p.sx - screen[0], p.sy - screen[1]) < 7)
              .sort(
                (a, b) =>
                  Math.hypot(a.sx - screen[0], a.sy - screen[1]) -
                  Math.hypot(b.sx - screen[0], b.sy - screen[1]),
              )[0]
          : null;
      if (
        editable &&
        selection &&
        (handle || vertex || (hit && state.selectedGuids.includes(hit) && !event.shiftKey))
      ) {
        let weights = structuredClone(state.pointSelection);
        if (vertex && !weights[vertex.guid]?.[vertex.index]) {
          if (!event.shiftKey) weights = {};
          weights[vertex.guid] = { ...weights[vertex.guid], [vertex.index]: 1 };
        } else if (vertex && event.shiftKey) {
          weights[vertex.guid] = { ...weights[vertex.guid], [vertex.index]: 0 };
          command({ type: 'selectMany', guids: state.selectedGuids, points: weights });
          return;
        }
        view.setSelectionPreview(weights);
        dragging.current = {
          kind: 'transform',
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          guid: selection.guid,
          revision: state.revision,
          zoom: state.view.zoom,
          bounds: selection.bounds,
          handle: vertex ? 'move' : handle || 'move',
          matrix: [...identityMatrix],
          changed: false,
          points: view.points(),
          weights,
          edits: [],
        };
        viewport.current?.setPointer(null);
      } else if (hit) {
        command(
          event.shiftKey
            ? {
                type: 'selectMany',
                guids: state.selectedGuids.includes(hit)
                  ? state.selectedGuids.filter((id) => id !== hit)
                  : [...state.selectedGuids, hit],
              }
            : { type: 'select', guid: hit },
        );
        return;
      } else {
        const weights = event.shiftKey ? structuredClone(state.pointSelection) : {};
        dragging.current = {
          kind: 'region',
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          revision: state.revision,
          path: [screen],
          canvasPath: [view.canvasPoint(...screen)],
          additive: event.shiftKey,
          points: view.points(false),
          weights,
          initial: structuredClone(weights),
          subtract: event.shiftKey && (event.ctrlKey || event.metaKey),
          rectangle: true,
          settings: { ...state.toolSettings },
        };
      }
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingNow(true);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    const meshSession = getManualMeshSession();
    if (meshSession && (!drag || (drag.kind === 'mesh' && drag.pointer === event.pointerId))) {
      if (panMode || !viewport.current) {
        meshSession.clearHover();
        return;
      }
      const rect = canvas.current!.getBoundingClientRect();
      const screen: Point = [event.clientX - rect.left, event.clientY - rect.top];
      meshSession.pointerMove(
        screen,
        meshSession.dragging || meshSession.snapshot.tool === 'add'
          ? viewport.current.manualUvAt(...screen)
          : null,
        viewport.current.manualPoints(),
        { point: viewport.current.canvasPoint(...screen), edgesOnly: event.altKey },
      );
      return;
    }
    if (drag && drag.pointer === event.pointerId) {
      if (drag.kind === 'mesh') return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (drag.kind === 'pan') {
        drag.latest = { ...drag.origin, panX: drag.origin.panX + dx, panY: drag.origin.panY + dy };
        viewport.current?.setCameraPreview(drag.latest);
      } else if (drag.kind === 'glue') {
        const rect = canvas.current!.getBoundingClientRect(),
          screen: Point = [event.clientX - rect.left, event.clientY - rect.top],
          point = viewport.current!.canvasPoint(...screen);
        for (const sample of strokeSamples(drag.last, point, drag.settings.size))
          for (const group of drag.groups)
            for (const p of group.points) {
              const nearA =
                  Math.hypot(p.a[0] - sample[0], p.a[1] - sample[1]) <=
                  Math.hypot(p.b[0] - sample[0], p.b[1] - sample[1]),
                target = nearA ? p.a : p.b,
                w = brushWeight(...target, sample, { ...drag.settings, strength: 1 });
              if (!w) continue;
              const pair = group.glue.pairs[p.index],
                key = nearA ? 'weightA' : 'weightB',
                other = nearA ? 'weightB' : 'weightA';
              pair[key] += (drag.settings.strength - pair[key]) * w;
              pair[other] = 1 - pair[key];
              drag.changed = true;
            }
        drag.last = point;
        viewport.current?.setGluePreview(
          new Map(drag.groups.map((g) => [g.glue.guid, g.glue.pairs])),
        );
        viewport.current?.setPointer(screen);
      } else if (drag.kind === 'bezier') {
        const b = drag.warp;
        drag.edits = [
          {
            guid: b.guid,
            points: moveBezierControl(
              b.positions,
              b.columns,
              b.rows,
              b.settings.columns,
              b.settings.rows,
              drag.index,
              [dx / state.view.zoom, dy / state.view.zoom],
            ),
          },
        ];
        drag.changed = Math.hypot(dx, dy) > 2;
        viewport.current?.setVerticesPreview(drag.edits);
      } else if (drag.kind === 'controller') {
        try {
          drag.edits = [
            {
              guid: drag.path.guid,
              points: controllerDisplacement(
                drag.path.controller,
                drag.path.positions,
                drag.index,
                [dx / state.view.zoom, dy / state.view.zoom],
              ),
            },
          ];
          drag.changed = Math.hypot(dx, dy) > 2;
          viewport.current?.setVerticesPreview(drag.edits);
        } catch (error) {
          cancelRef.current();
          perform(async () => {
            throw error;
          });
        }
      } else if (drag.kind === 'rotation') {
        const rect = canvas.current!.getBoundingClientRect(),
          point = viewport.current!.canvasPoint(
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
          r = drag.rotation;
        if (drag.mode === 'move') {
          const target: Point = [
              r.center[0] + dx / state.view.zoom,
              r.center[1] + dy / state.view.zoom,
            ],
            p = inversePoint(r.toCanvas, target, [r.form.x, r.form.y]);
          drag.value = { x: p[0], y: p[1] };
        } else if (event.altKey)
          drag.value = {
            scale: Math.max(
              0.001,
              (r.form.scale * Math.hypot(point[0] - r.center[0], point[1] - r.center[1])) /
                drag.startLength,
            ),
          };
        else {
          const delta =
            Math.atan2(point[1] - r.center[1], point[0] - r.center[0]) - drag.startAngle;
          let angle = r.form.angle + (Math.atan2(Math.sin(delta), Math.cos(delta)) * 180) / Math.PI;
          if (event.shiftKey) angle = Math.round(angle / 15) * 15;
          drag.value = { angle };
        }
        drag.changed = true;
        viewport.current!.setRotationPreview({
          guid: r.guid,
          value: drag.value,
          preserveChildren: drag.preserveChildren,
        });
      } else if (drag.kind === 'rotationDraw') {
        const rect = canvas.current!.getBoundingClientRect();
        drag.end = viewport.current!.canvasPoint(
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        viewport.current!.setGuide([
          [drag.x - rect.left, drag.y - rect.top],
          [event.clientX - rect.left, event.clientY - rect.top],
        ]);
      } else if (drag.kind === 'region' || drag.kind === 'paint') {
        const rect = canvas.current!.getBoundingClientRect(),
          screen: Point = [event.clientX - rect.left, event.clientY - rect.top];
        if (drag.kind === 'region') {
          if (drag.rectangle) {
            const start = drag.path[0];
            drag.path = [start, [screen[0], start[1]], screen, [start[0], screen[1]]];
          } else if (
            Math.hypot(screen[0] - drag.path.at(-1)![0], screen[1] - drag.path.at(-1)![1]) > 2
          )
            drag.path.push(screen);
          drag.canvasPath = drag.path.map((p) => viewport.current!.canvasPoint(...p));
          drag.weights = selectPointRegion(
            drag.points,
            drag.rectangle
              ? { type: 'rectangle', points: [drag.canvasPath[0], drag.canvasPath[2]] }
              : { type: 'lasso', points: drag.canvasPath },
            drag.initial,
            drag.settings,
            drag.subtract,
          );
          viewport.current!.setGuide(drag.path);
        } else {
          const from = drag.canvasPath.at(-1)!,
            to = viewport.current!.canvasPoint(...screen);
          paintSelection(drag.points, drag.weights, from, to, drag.settings, drag.subtract);
          drag.path.push(screen);
          drag.canvasPath.push(to);
          viewport.current!.setPointer(screen);
        }
        viewport.current!.setSelectionPreview(drag.weights);
      } else if (drag.kind === 'brush') {
        const rect = canvas.current!.getBoundingClientRect(),
          screen: Point = [event.clientX - rect.left, event.clientY - rect.top],
          to = viewport.current!.canvasPoint(...screen);
        if (Math.hypot(to[0] - drag.last[0], to[1] - drag.last[1]) < 0.0001) return;
        const changed = drag.stroke.move(drag.last, to);
        drag.changed ||= changed;
        drag.path.push(to);
        drag.last = to;
        if (changed) viewport.current!.setVerticesPreview(drag.edits);
        viewport.current!.setPointer(screen);
      } else if (drag.kind === 'transform') {
        if (!drag.changed && Math.hypot(dx, dy) < 3) return;
        drag.changed = true;
        if (drag.handle === 'move') {
          let x = dx / drag.zoom,
            y = dy / drag.zoom;
          if (event.shiftKey) {
            if (Math.abs(x) > Math.abs(y)) y = 0;
            else x = 0;
          }
          drag.matrix = [1, 0, 0, 1, x, y];
        } else
          drag.matrix = resizeMatrix(
            drag.bounds,
            drag.handle,
            dx / drag.zoom,
            dy / drag.zoom,
            event.shiftKey,
            event.altKey,
          );
        const partial = Object.values(drag.weights).some((points) =>
          Object.values(points).some((w) => w > 0),
        );
        drag.edits = groupEdits(
          drag.points.map((p) => {
            const target = applyMatrix(drag.matrix, p.x, p.y),
              w = partial ? drag.weights[p.guid]?.[p.index] || 0 : 1;
            return { ...p, x: p.x + (target[0] - p.x) * w, y: p.y + (target[1] - p.y) * w };
          }),
        );
        viewport.current?.setVerticesPreview(drag.edits);
      }
    } else if (!panMode && !busy.current) {
      const rect = canvas.current!.getBoundingClientRect();
      viewport.current?.setPointer([event.clientX - rect.left, event.clientY - rect.top]);
    }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragging.current = null;
    setDraggingNow(false);
    release(drag.pointer);
    viewport.current?.setGuide([]);
    if (drag.kind === 'mesh') {
      getManualMeshSession()?.pointerUp();
      return;
    }
    if (drag.kind === 'pan') {
      drag.latest = {
        ...drag.origin,
        panX: drag.origin.panX + event.clientX - drag.x,
        panY: drag.origin.panY + event.clientY - drag.y,
      };
      viewport.current?.setCameraPreview(drag.latest);
      commitPan(drag);
      return;
    }
    if (drag.kind === 'glue') {
      if (drag.changed)
        perform(async () => {
          try {
            await window.lattice.command({
              type: 'editGlueWeights',
              changes: drag.groups.map((group) => ({
                guid: group.glue.guid,
                weights: group.glue.pairs.map((p, index) => ({
                  index,
                  weightA: p.weightA,
                  weightB: p.weightB,
                })),
              })),
              expectedRevision: drag.revision,
            });
          } finally {
            viewport.current?.setGluePreview(null);
          }
        });
      return;
    }
    if (drag.kind === 'rotation') {
      if (drag.changed)
        perform(async () => {
          try {
            const result = await window.lattice.command({
              type: 'editRotation',
              guid: drag.rotation.guid,
              value: drag.value,
              preserveChildren: drag.preserveChildren,
              expectedRevision: drag.revision,
            });
            if (result.preview?.revision === asset.revision)
              viewport.current?.setRotationPreview(null);
          } catch (error) {
            viewport.current?.setRotationPreview(null);
            throw error;
          }
        });
      return;
    }
    if (drag.kind === 'rotationDraw') {
      const length = Math.hypot(drag.end[0] - drag.origin[0], drag.end[1] - drag.origin[1]);
      if (length < 2) return;
      perform(() =>
        window.lattice.command({
          type: 'createDeformer',
          expectedRevision: drag.revision,
          value: {
            kind: 'rotation',
            guids: state.selectedGuids,
            name: t('rotationKind'),
            placement: 'parent',
            columns: 5,
            rows: 5,
            bezierColumns: 2,
            bezierRows: 2,
            origin: drag.origin,
            handleLength: length,
            angle:
              (Math.atan2(drag.end[0] - drag.origin[0], drag.origin[1] - drag.end[1]) * 180) /
              Math.PI,
          },
        }),
      );
      return;
    }
    if (drag.kind === 'region' || drag.kind === 'paint') {
      perform(async () => {
        try {
          await window.lattice.command({
            type: 'selectRegion',
            guids: [...new Set(drag.points.map((p) => p.guid))],
            region: drag.rectangle
              ? {
                  type: 'rectangle',
                  points: [drag.canvasPath[0], drag.canvasPath[2] || drag.canvasPath[0]],
                }
              : { type: drag.kind === 'paint' ? 'brush' : 'lasso', points: drag.canvasPath },
            mode: drag.subtract ? 'subtract' : drag.additive ? 'add' : 'replace',
            settings: drag.settings,
            expectedRevision: drag.revision,
          });
        } finally {
          viewport.current?.setSelectionPreview(null);
        }
      });
      return;
    }
    if (
      drag.kind !== 'transform' &&
      drag.kind !== 'brush' &&
      drag.kind !== 'controller' &&
      drag.kind !== 'bezier'
    )
      return;
    if (!drag.changed) {
      if (drag.kind === 'transform')
        command({ type: 'selectMany', guids: state.selectedGuids, points: drag.weights });
      viewport.current?.setSelectionPreview(null);
      return;
    }
    busy.current = true;
    setCommitting(true);
    perform(async () => {
      try {
        const result = await window.lattice.command(
          drag.kind === 'brush'
            ? {
                type: 'deformBrush',
                guids: [...new Set(drag.points.map((p) => p.guid))],
                points: drag.path,
                settings: drag.settings,
                expectedRevision: drag.revision,
              }
            : {
                type: 'editVertices',
                edits: drag.edits,
                expectedRevision: drag.revision,
              },
        );
        if (result.preview?.revision === state.preview?.revision)
          viewport.current?.setVerticesPreview(null);
        if (drag.kind === 'transform')
          await window.lattice.command({
            type: 'selectMany',
            guids: state.selectedGuids,
            points: drag.weights,
          });
      } catch (error) {
        viewport.current?.setVerticesPreview(null);
        throw error;
      } finally {
        viewport.current?.setSelectionPreview(null);
        busy.current = false;
        setCommitting(false);
      }
    });
  };
  const box = selection?.screen;
  const hint = selection?.reason
    ? t(
        selection.reason === 'meshOnly'
          ? 'meshEditingOnly'
          : selection.reason === 'locked'
            ? 'lockedSelection'
            : 'keyformRequired',
      )
    : t('transformHint');
  return (
    <div
      ref={stack}
      tabIndex={0}
      className={
        'canvas-stack ' +
        (panMode ? 'panning ' : '') +
        (draggingNow ? 'dragging ' : '') +
        (committing ? 'committing' : '')
      }
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerLeave={() => {
        if (!dragging.current) viewport.current?.setPointer(null);
        getManualMeshSession()?.clearHover();
      }}
      onPointerCancel={() => cancelRef.current()}
      onLostPointerCapture={() => {
        if (dragging.current) cancelRef.current();
      }}
    >
      <canvas
        ref={canvas}
        aria-label={t('modelViewport')}
        data-testid="model-canvas"
        style={{
          cursor: panMode
            ? draggingNow
              ? 'grabbing'
              : 'grab'
            : manual
              ? manual.tool === 'add' || manual.tool === 'erase' || manual.tool === 'lasso'
                ? 'crosshair'
                : 'default'
              : editable && interaction.hover?.guid === selection?.guid
                ? 'move'
                : 'default',
        }}
      />
      <canvas
        ref={overlay}
        data-testid="mesh-overlay"
        className="mesh-overlay"
        aria-hidden="true"
      />
      <MeshEditBar />
      {!manual &&
        selection &&
        box &&
        !viewport.current?.rotation() &&
        state.view.tool === 'select' && (
          <div
            className={'selection-box ' + (editable ? 'editable' : 'readonly')}
            data-testid="selection-box"
            data-guid={selection.guid}
            data-editable={String(editable)}
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            aria-label={t('selectionBounds')}
          >
            {editable && box.width > 10 && box.height > 10 && !panMode && (
              <>
                {handles.map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    className={'transform-handle handle-' + handle}
                    data-handle={handle}
                    aria-label={t('resizeSelection') + ' ' + handle}
                    title={t('resizeSelection')}
                    style={{
                      left: handle.includes('w') ? '0%' : handle.includes('e') ? '100%' : '50%',
                      top: handle.includes('n') ? '0%' : handle.includes('s') ? '100%' : '50%',
                    }}
                  />
                ))}
                <button
                  type="button"
                  data-handle="move"
                  className="selection-pivot"
                  aria-label={t('moveSelection')}
                  title={t('moveSelection')}
                />
              </>
            )}
          </div>
        )}
      {pathCount > 0 && (
        <div className="path-actions" onPointerDown={(e) => e.stopPropagation()}>
          <span>{t('pathHint')}</span>
          <button disabled={pathCount < 2} onClick={finishPath}>
            {t('finishPath')} ↵
          </button>
          <button onClick={cancel}>{t('cancel')}</button>
        </div>
      )}
      {interaction.hover && !draggingNow && !panMode && !committing && (
        <div
          className="hover-label"
          data-testid="hover-label"
          style={{ left: interaction.hover.x, top: interaction.hover.y }}
        >
          {interaction.hover.name}
        </div>
      )}
      {selection && !panMode && (
        <div className="selection-hint" data-testid="selection-hint">
          {viewport.current?.rotation()
            ? viewport.current.rotation()!.locked
              ? t('lockedSelection')
              : t('rotationEditHint')
            : hint}
        </div>
      )}
    </div>
  );
}
