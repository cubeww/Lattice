import type {
  BrushSettings,
  PointSelection,
  SelectionRegion,
  VertexEdit,
} from '../../shared/types';
import type { Point } from './evaluate';
import type { ModelPoint } from './modeling-points';

export function insidePolygon(x: number, y: number, path: Point[]): boolean {
  if (path.length < 3) return false;
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i],
      b = path[j];
    // Boundary points belong to the region, including horizontal and vertical edges.
    const cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
    if (
      Math.abs(cross) < 1e-7 &&
      x >= Math.min(a[0], b[0]) &&
      x <= Math.max(a[0], b[0]) &&
      y >= Math.min(a[1], b[1]) &&
      y <= Math.max(a[1], b[1])
    )
      return true;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
export function brushWeight(x: number, y: number, center: Point, settings: BrushSettings): number {
  const angle = (-settings.angle * Math.PI) / 180,
    dx = x - center[0],
    dy = y - center[1];
  const u = dx * Math.cos(angle) - dy * Math.sin(angle),
    v = dx * Math.sin(angle) + dy * Math.cos(angle);
  const d =
    (settings.shape === 'circle' ? Math.hypot(u, v) : Math.max(Math.abs(u), Math.abs(v))) /
    (settings.size / 2);
  if (d >= 1) return 0;
  const t = d <= settings.hardness ? 1 : (1 - d) / (1 - settings.hardness);
  return t * t * (3 - 2 * t) * settings.strength;
}

/** Incremental selection paint; also used when replaying an MCP stroke. */
export function paintSelection(
  points: ModelPoint[],
  weights: PointSelection,
  from: Point,
  to: Point,
  settings: BrushSettings,
  subtract: boolean,
) {
  for (const sample of strokeSamples(from, to, settings.size)) {
    for (const p of points) {
      const w = brushWeight(p.x, p.y, sample, settings);
      if (!w) continue;
      const previous = weights[p.guid]?.[p.index] || 0;
      (weights[p.guid] ||= {})[p.index] = subtract
        ? previous * (1 - w)
        : previous + (1 - previous) * w;
    }
  }
}

export function selectPointRegion(
  points: ModelPoint[],
  region: SelectionRegion,
  initial: PointSelection,
  settings: BrushSettings,
  subtract: boolean,
): PointSelection {
  const weights = structuredClone(initial),
    path = region.points;
  if (region.type === 'brush') {
    validateBrushStroke(path, settings.size, points.length);
    paintSelection(points, weights, path[0], path[0], settings, subtract);
    for (let i = 1; i < path.length; i++)
      paintSelection(points, weights, path[i - 1], path[i], settings, subtract);
  } else {
    for (const p of points) {
      const inside =
        region.type === 'rectangle'
          ? p.x >= Math.min(path[0][0], path[1][0]) &&
            p.x <= Math.max(path[0][0], path[1][0]) &&
            p.y >= Math.min(path[0][1], path[1][1]) &&
            p.y <= Math.max(path[0][1], path[1][1])
          : insidePolygon(p.x, p.y, path);
      if (inside) (weights[p.guid] ||= {})[p.index] = subtract ? 0 : 1;
    }
  }
  return weights;
}

/** A local draft. Construct once per stroke and replay the same segments in the core. */
export class DeformationStroke {
  private neighbors = new Map<string, Map<number, Set<number>>>();
  private partial: boolean;
  constructor(
    readonly edits: VertexEdit[],
    indices: (guid: string) => number[],
    private settings: BrushSettings,
    private weights: PointSelection,
  ) {
    this.partial = edits.some((edit) => Object.keys(weights[edit.guid] || {}).length > 0);
    if (settings.brushMode !== 'smooth') return;
    for (const edit of edits) {
      const adjacency = new Map<number, Set<number>>(),
        triangles = indices(edit.guid);
      for (let i = 0; i < triangles.length; i += 3) {
        const triangle = triangles.slice(i, i + 3);
        for (const a of triangle)
          for (const b of triangle)
            if (a !== b) {
              const neighbors = adjacency.get(a) || new Set<number>();
              neighbors.add(b);
              adjacency.set(a, neighbors);
            }
      }
      this.neighbors.set(edit.guid, adjacency);
    }
  }
  move(from: Point, to: Point): boolean {
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.0001) return false;
    let changed = false,
      last = from;
    for (const sample of strokeSamples(from, to, this.settings.size)) {
      const dx = sample[0] - last[0],
        dy = sample[1] - last[1],
        distance = Math.hypot(dx, dy);
      for (const edit of this.edits) {
        const previous =
          this.settings.brushMode === 'smooth'
            ? new Map(edit.points.map((p) => [p.index, { ...p }]))
            : null;
        for (const p of edit.points) {
          const w =
            brushWeight(p.x, p.y, last, this.settings) *
            (this.partial ? this.weights[edit.guid]?.[p.index] || 0 : 1);
          if (!w) continue;
          const x = p.x,
            y = p.y;
          if (this.settings.brushMode === 'move') {
            p.x += dx * w;
            p.y += dy * w;
          } else if (this.settings.brushMode === 'inflate') {
            const u = p.x - last[0],
              v = p.y - last[1],
              length = Math.hypot(u, v);
            if (length > 1e-5) {
              p.x += (u / length) * distance * w * 0.35;
              p.y += (v / length) * distance * w * 0.35;
            }
          } else {
            const neighbors = [...(this.neighbors.get(edit.guid)?.get(p.index) || [])]
              .map((id) => previous!.get(id))
              .filter((p) => !!p);
            if (neighbors.length) {
              const amount = Math.min(1, (distance / this.settings.size) * 4) * w;
              p.x += (neighbors.reduce((s, p) => s + p.x, 0) / neighbors.length - p.x) * amount;
              p.y += (neighbors.reduce((s, p) => s + p.y, 0) / neighbors.length - p.y) * amount;
            }
          }
          changed ||= p.x !== x || p.y !== y;
        }
      }
      last = sample;
    }
    return changed;
  }
}
export function strokeSamples(from: Point, to: Point, size: number): Point[] {
  const count = Math.max(
    1,
    Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(1, size * 0.12)),
  );
  if (count > 20000) throw new Error('Brush segment is too long. Split it into shorter strokes.');
  return Array.from({ length: count }, (_, i) => [
    from[0] + ((to[0] - from[0]) * (i + 1)) / count,
    from[1] + ((to[1] - from[1]) * (i + 1)) / count,
  ]);
}

export function validateBrushStroke(path: Point[], size: number, pointCount: number) {
  let samples = 1;
  for (let i = 1; i < path.length; i++)
    samples += Math.max(
      1,
      Math.ceil(
        Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]) /
          Math.max(1, size * 0.12),
      ),
    );
  if (samples > 20000 || samples * pointCount > 20000000)
    throw new Error(
      'Brush stroke is too large. Use fewer objects or split it into shorter strokes.',
    );
}
