import type { SourceScene } from '../../../shared/scene';
import type { ModelObject } from '../../../shared/types';
import {
  OperationError,
  resolvePose,
  type RenderModelOptions,
  type RenderedModel,
} from '../../../shared/workflow';
import { ModelEvaluator } from '../../../core/model/evaluate';
import { boundsOf, related, type Bounds } from '../../../core/model/selection';
import type { MeshRenderer } from './webgl';

/** Reuse the viewport's uploaded textures; the caller restores its pose before yielding. */
export function captureModel(
  renderer: MeshRenderer,
  canvas: HTMLCanvasElement,
  scene: SourceScene,
  objects: Map<string, ModelObject>,
  currentParameters: Record<string, number>,
  options: RenderModelOptions,
): RenderedModel[] {
  const evaluator = new ModelEvaluator(scene);
  const poses = options.poses?.map((pose) => ({
    label: pose.label,
    parameters: resolvePose(scene.parameters, pose.parameters),
  })) || [{ parameters: { ...currentParameters }, label: undefined }];
  const selected = options.guids && new Set<string>();
  for (const guid of options.guids || []) {
    if (!objects.has(guid))
      throw new OperationError('OBJECT_NOT_FOUND', 'Framing object was not found.', { guid });
    for (const id of objects.keys()) if (related(objects, id, guid)) selected!.add(id);
  }
  let bounds: Bounds = options.bounds || { x: 0, y: 0, ...scene.canvas };
  if (selected) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const pose of poses) {
      const meshes = evaluator.evaluate(pose.parameters);
      for (const node of [...meshes, ...evaluator.evaluatedDeformers]) {
        if (!selected.has(node.source.guid) || !node.positions.length) continue;
        const b = boundsOf(node.positions);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite))
      throw new OperationError(
        'EMPTY_RENDER_BOUNDS',
        'The selected objects have no renderable bounds.',
        { guids: options.guids },
      );
    bounds = {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }
  // Shared framing across all poses makes motion and silhouette changes comparable.
  const { width, height, padding, background } = options;
  const scale =
    Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height)) *
    (1 - padding * 2);
  const x = width / 2 - (bounds.x + bounds.width / 2) * scale;
  const y = height / 2 - (bounds.y + bounds.height / 2) * scale;
  const visibleBounds = {
    x: -x / scale,
    y: -y / scale,
    width: width / scale,
    height: height / scale,
  };
  const output = document.createElement('canvas');
  output.width = canvas.width = width;
  output.height = canvas.height = height;
  const ctx = output.getContext('2d')!;
  return poses.map((pose) => {
    renderer.setPose(evaluator.evaluate(pose.parameters));
    renderer.draw([
      (2 * scale) / width,
      (-2 * scale) / height,
      (2 * x) / width - 1,
      1 - (2 * y) / height,
    ]);
    ctx.clearRect(0, 0, width, height);
    if (background !== 'transparent') {
      ctx.fillStyle = background === 'dark' ? '#282c34' : '#ffffff';
      ctx.fillRect(0, 0, width, height);
      if (background === 'checker') {
        ctx.fillStyle = '#e9edf1';
        for (let y = 0; y < height; y += 12)
          for (let x = 0; x < width; x += 12)
            if ((x / 12 + y / 12) % 2 === 0) ctx.fillRect(x, y, 12, 12);
      }
    }
    ctx.drawImage(canvas, 0, 0);
    return {
      ...pose,
      width,
      height,
      bounds: visibleBounds,
      data: output.toDataURL('image/png').split(',')[1],
    };
  });
}
