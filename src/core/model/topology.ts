import Delaunator from 'delaunator';
import type { MeshEdge } from '../../shared/scene';
export interface SurfacePoint {
  indices: [number, number, number];
  weights: [number, number, number];
}
/** Barycentric lookup also extrapolates through the nearest triangle at mesh edges. */
export function surfacePoint(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  x: number,
  y: number,
): SurfacePoint {
  let best: SurfacePoint | undefined,
    score = Infinity;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 2,
      b = indices[i + 1] * 2,
      c = indices[i + 2] * 2;
    const det =
      (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) -
      (positions[c] - positions[a]) * (positions[b + 1] - positions[a + 1]);
    if (Math.abs(det) < 1e-14) continue;
    const u =
        ((x - positions[a]) * (positions[c + 1] - positions[a + 1]) -
          (y - positions[a + 1]) * (positions[c] - positions[a])) /
        det,
      v =
        ((positions[b] - positions[a]) * (y - positions[a + 1]) -
          (positions[b + 1] - positions[a + 1]) * (x - positions[a])) /
        det;
    const weights: [number, number, number] = [1 - u - v, u, v],
      outside = weights.reduce((sum, w) => sum + Math.max(0, -w), 0);
    if (outside < score) {
      best = { indices: [indices[i], indices[i + 1], indices[i + 2]], weights };
      score = outside;
      if (outside < 1e-8) break;
    }
  }
  if (!best) throw new Error('Mesh has no usable triangles.');
  return best;
}
export function sampleSurface(positions: ArrayLike<number>, point: SurfacePoint): [number, number] {
  return [
    point.indices.reduce((s, id, i) => s + positions[id * 2] * point.weights[i], 0),
    point.indices.reduce((s, id, i) => s + positions[id * 2 + 1] * point.weights[i], 0),
  ];
}
export function triangulate(positions: number[]): number[] {
  const result = Array.from(new Delaunator(positions).triangles);
  for (let i = 0; i < result.length; i += 3) {
    const [a, b, c] = result.slice(i, i + 3).map((n) => n * 2);
    if (
      (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) -
        (positions[c] - positions[a]) * (positions[b + 1] - positions[a + 1]) <
      0
    )
      [result[i + 1], result[i + 2]] = [result[i + 2], result[i + 1]];
  }
  return result;
}
export function meshEdges(indices: number[]) {
  const edges = new Map<string, [number, number]>();
  for (let i = 0; i < indices.length; i += 3)
    for (let j = 0; j < 3; j++) {
      const a = indices[i + j],
        b = indices[i + ((j + 1) % 3)];
      edges.set([a, b].sort((x, y) => x - y).join(','), [a, b]);
    }
  return [...edges.values()].flat();
}

export function meshConnections(
  indices: number[],
  priority: MeshEdge['priority'] = 30,
): MeshEdge[] {
  const pairs = meshEdges(indices),
    edges: MeshEdge[] = [];
  for (let i = 0; i < pairs.length; i += 2) edges.push({ a: pairs[i], b: pairs[i + 1], priority });
  return edges;
}
