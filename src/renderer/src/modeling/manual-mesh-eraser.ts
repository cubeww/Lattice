import type { Point } from '../../../core/model/evaluate';
import type { MeshDraft } from './manual-mesh-geometry';

export interface MeshEraserPoint {
  index: number;
  x: number;
  y: number;
}

function pointDistance(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    : 0;
  return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(
    pointDistance(a, c, d),
    pointDistance(b, c, d),
    pointDistance(c, a, b),
    pointDistance(d, a, b),
  );
}

/** Sweep the full brush segment so fast pointer movements cannot skip thin edges or vertices. */
export function hitEraser(
  draft: MeshDraft,
  points: MeshEraserPoint[],
  from: Point,
  to: Point,
  radius: number,
  edgesOnly: boolean,
) {
  const limit = radius * radius;
  const vertices = edgesOnly
    ? []
    : points.filter((p) => pointDistance([p.x, p.y], from, to) <= limit).map((p) => p.index);
  const edges = draft.edges
    .filter((edge) => {
      // Supplemental triangulation is derived, so erasing it alone would immediately recreate it.
      if (edge.priority === 10) return false;
      const a = points[edge.a],
        b = points[edge.b];
      return a && b && segmentDistance(from, to, [a.x, a.y], [b.x, b.y]) <= limit;
    })
    .map((edge) => `${Math.min(edge.a, edge.b)},${Math.max(edge.a, edge.b)}`);
  return { vertices, edges };
}
