import type { ModelObject } from '../../shared/types';
import type { SourceNode, Affine } from '../../shared/scene';
import type { Point, Transform } from './evaluate';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const handles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const identityMatrix: Affine = [1, 0, 0, 1, 0, 0];
export const applyMatrix = (m: Affine, x: number, y: number): Point => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
export function boundsOf(positions: ArrayLike<number>): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    minX = Math.min(minX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxX = Math.max(maxX, positions[i]);
    maxY = Math.max(maxY, positions[i + 1]);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
export function related(objects: Map<string, ModelObject>, guid: string, target: string): boolean {
  const todo = [guid],
    seen = new Set<string>();
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    if (id === target) return true;
    seen.add(id);
    const n = objects.get(id);
    if (n?.parentGuid) todo.push(n.parentGuid);
    if (n?.deformerGuid) todo.push(n.deformerGuid);
  }
  return false;
}
export function locked(objects: Map<string, ModelObject>, guid: string): boolean {
  return [...objects.values()].some((n) => n.locked && related(objects, guid, n.guid));
}
export function keyformAt(node: SourceNode, values: Record<string, number>) {
  const keys = node.bindings.map((binding) =>
    binding.keys.length === 1
      ? 0
      : binding.keys.findIndex((key) => Math.abs(key - values[binding.parameterId]) < 1e-6),
  );
  return keys.includes(-1)
    ? null
    : node.forms.find((form) => form.keys.every((key, i) => key === keys[i])) || null;
}
export function resizeMatrix(
  bounds: Bounds,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  uniform: boolean,
  centered: boolean,
): Affine {
  const horizontal = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const vertical = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const multiplier = centered ? 2 : 1;
  let sx = horizontal
    ? Math.max(0.01, (bounds.width + horizontal * dx * multiplier) / bounds.width)
    : 1;
  let sy = vertical
    ? Math.max(0.01, (bounds.height + vertical * dy * multiplier) / bounds.height)
    : 1;
  if (uniform) {
    const s = !horizontal ? sy : !vertical ? sx : Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    sx = s;
    sy = s;
  }
  const ox = bounds.x + bounds.width * (centered || !horizontal ? 0.5 : horizontal < 0 ? 1 : 0);
  const oy = bounds.y + bounds.height * (centered || !vertical ? 0.5 : vertical < 0 ? 1 : 0);
  return [sx, 0, 0, sy, ox * (1 - sx), oy * (1 - sy)];
}

/** Invert the evaluated parent field near the original local vertex. This
 * keeps edits in native deformer coordinates, including nested warp chains.
 * Singular/folded regions that cannot reach the target are rejected atomically. */
export function inversePoint(forward: Transform, target: Point, seed: Point): Point {
  let [x, y] = seed;
  for (let iteration = 0; iteration < 32; iteration++) {
    const p = forward(x, y),
      ex = target[0] - p[0],
      ey = target[1] - p[1],
      error = Math.hypot(ex, ey);
    if (error < 1e-4) return [x, y];
    const h = Math.max(1e-5, Math.abs(x) * 1e-7, Math.abs(y) * 1e-7),
      px = forward(x + h, y),
      py = forward(x, y + h);
    const a = (px[0] - p[0]) / h,
      b = (py[0] - p[0]) / h,
      c = (px[1] - p[1]) / h,
      d = (py[1] - p[1]) / h,
      det = a * d - b * c;
    if (Math.abs(det) < 1e-12) break;
    const dx = (d * ex - b * ey) / det,
      dy = (a * ey - c * ex) / det;
    let step = 1,
      accepted = false;
    for (let attempt = 0; attempt < 12; attempt++, step *= 0.5) {
      const next = forward(x + dx * step, y + dy * step);
      if (Math.hypot(target[0] - next[0], target[1] - next[1]) < error) {
        x += dx * step;
        y += dy * step;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  throw new Error('The parent deformer cannot represent this edit at the current pose.');
}
