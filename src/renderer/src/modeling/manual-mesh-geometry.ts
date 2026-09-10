import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import type { TopologyVertex } from '../../../shared/types';
import type { MeshEdge } from '../../../shared/scene';
import { meshConnections, surfacePoint, triangulate } from '../../../core/model/topology';

export interface MeshDraft {
  vertices: TopologyVertex[];
  indices: number[];
  edges: MeshEdge[];
  selected: number[];
}
const cross = (a: TopologyVertex, b: TopologyVertex, c: TopologyVertex) =>
  (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
const edgeKey = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;
function triangles(vertices: TopologyVertex[], indices: number[]) {
  const result: number[][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3);
    result.push(cross(vertices[a], vertices[b], vertices[c]) < 0 ? [a, c, b] : [a, b, c]);
  }
  return result;
}
function boundary(vertices: TopologyVertex[], indices: number[]) {
  const edges = new Map<string, [number, number] | null>();
  for (const t of triangles(vertices, indices))
    for (let j = 0; j < 3; j++) {
      const a = t[j],
        b = t[(j + 1) % 3],
        key = edgeKey(a, b);
      edges.set(key, edges.has(key) ? null : [a, b]);
    }
  return [...edges.values()].filter((e): e is [number, number] => e !== null);
}

/** Determine the editable region; adding outside a boundary extends it without filling holes. */
function insertionDomain(draft: MeshDraft, point: TopologyVertex): number[] {
  const { vertices: old, indices } = draft,
    vertices = [...old, point],
    n = old.length;
  if (!indices.length)
    return vertices.length < 3 ? [] : triangulate(vertices.flatMap((v) => [v.u, v.v]));
  const mapping = surfacePoint(
    old.flatMap((v) => [v.u, v.v]),
    indices,
    point.u,
    point.v,
  );
  if (mapping.weights.every((w) => w >= -1e-8)) {
    const edge = mapping.weights.findIndex((w) => Math.abs(w) < 1e-8);
    const edgeIds = edge < 0 ? [] : mapping.indices.filter((_, i) => i !== edge);
    const next = triangles(old, indices)
      .flatMap((t) => {
        if (edge >= 0 && edgeIds.every((id) => t.includes(id))) {
          const other = t.find((id) => !edgeIds.includes(id))!;
          return [
            [edgeIds[0], n, other],
            [n, edgeIds[1], other],
          ];
        }
        if (edge < 0 && mapping.indices.every((id) => t.includes(id)))
          return [
            [t[0], t[1], n],
            [t[1], t[2], n],
            [t[2], t[0], n],
          ];
        return [t];
      })
      .flat();
    return triangles(vertices, next).flat();
  }
  const edges = boundary(old, indices);
  const intersects = (a: TopologyVertex, b: TopologyVertex, c: TopologyVertex, d: TopologyVertex) =>
    cross(a, b, c) * cross(a, b, d) < -1e-16 && cross(c, d, a) * cross(c, d, b) < -1e-16;
  const added = edges
    .filter(([a, b]) => {
      if (cross(old[a], old[b], point) >= -1e-12) return false;
      return !edges.some(
        ([c, d]) =>
          intersects(point, old[a], old[c], old[d]) || intersects(point, old[b], old[c], old[d]),
      );
    })
    .flatMap(([a, b]) => [b, a, n]);
  return [...indices, ...added];
}

/** Only fixed edges constrain triangulation. All supplemental face edges remain automatic. */
export function withAutomaticEdges(indices: number[], fixed: MeshEdge[]): MeshEdge[] {
  const result = new Map(fixed.filter((e) => e.priority > 10).map((e) => [edgeKey(e.a, e.b), e]));
  for (const edge of meshConnections(indices, 10))
    if (!result.has(edgeKey(edge.a, edge.b))) result.set(edgeKey(edge.a, edge.b), edge);
  return [...result.values()];
}

function pointOnSegment(a: TopologyVertex, b: TopologyVertex, p: TopologyVertex) {
  const du = b.u - a.u,
    dv = b.v - a.v,
    length = du * du + dv * dv;
  const t = length ? ((p.u - a.u) * du + (p.v - a.v) * dv) / length : 0;
  return t > 1e-8 && t < 1 - 1e-8 && Math.abs(cross(a, b, p)) < 1e-9 * Math.sqrt(length) ? t : null;
}

function crosses(a: TopologyVertex, b: TopologyVertex, c: TopologyVertex, d: TopologyVertex) {
  return cross(a, b, c) * cross(a, b, d) < -1e-18 && cross(c, d, a) * cross(c, d, b) < -1e-18;
}

/** Pen strokes may replace automatic edges, but never cross fixed edges. */
export function canConnect(draft: MeshDraft, from: number, point: TopologyVertex, to?: number) {
  if (
    from === to ||
    Math.hypot(draft.vertices[from].u - point.u, draft.vertices[from].v - point.v) < 1e-9
  )
    return false;
  return !draft.edges.some(
    (edge) =>
      edge.priority > 10 &&
      ((edge.a === from && edge.b === to) ||
        (edge.b === from && edge.a === to) ||
        crosses(draft.vertices[from], point, draft.vertices[edge.a], draft.vertices[edge.b])),
  );
}

function penEdges(draft: MeshDraft, to: number): MeshEdge[] {
  const edges = draft.edges.filter((edge) => edge.priority > 10);
  for (const from of draft.selected) {
    if (!canConnect(draft, from, draft.vertices[to], to)) continue;
    const between = draft.vertices
      .flatMap((point, index) => {
        const t = pointOnSegment(draft.vertices[from], draft.vertices[to], point);
        return t === null ? [] : [{ index, t }];
      })
      .sort((a, b) => a.t - b.t);
    const chain = [from, ...between.map((p) => p.index), to];
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1],
        b = chain[i];
      if (!edges.some((edge) => edgeKey(edge.a, edge.b) === edgeKey(a, b)))
        edges.push({ a, b, priority: 30 });
    }
  }
  return edges;
}

function triangulateRegion(
  vertices: TopologyVertex[],
  fixed: MeshEdge[],
  outline: [number, number][],
) {
  if (vertices.length < 3) return [];
  const delaunay = new Delaunator(vertices.flatMap((v) => [v.u, v.v]));
  if (!delaunay.triangles.length) return [];
  const constraints = new Map(outline.map(([a, b]) => [edgeKey(a, b), [a, b] as [number, number]]));
  for (const { a, b, priority } of fixed) if (priority > 10) constraints.set(edgeKey(a, b), [a, b]);
  new Constrainautor(delaunay).constrainAll([...constraints.values()]);
  const inside = (u: number, v: number) => {
    if (!outline.length) return true;
    let odd = false;
    for (const [ia, ib] of outline) {
      const a = vertices[ia],
        b = vertices[ib];
      if (a.v > v !== b.v > v && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) odd = !odd;
    }
    return odd;
  };
  return triangles(vertices, Array.from(delaunay.triangles))
    .filter((t) =>
      inside(
        t.reduce((n, i) => n + vertices[i].u, 0) / 3,
        t.reduce((n, i) => n + vertices[i].v, 0) / 3,
      ),
    )
    .flat();
}

export function rebuildAutomaticEdges(draft: MeshDraft): MeshDraft {
  const indices = triangulateRegion(
    draft.vertices,
    draft.edges,
    boundary(draft.vertices, draft.indices),
  );
  return { ...draft, indices, edges: withAutomaticEdges(indices, draft.edges) };
}

export function insertVertex(draft: MeshDraft, point: TopologyVertex, additive = false): MeshDraft {
  if (draft.vertices.some((p) => Math.hypot(p.u - point.u, p.v - point.v) < 1e-9)) return draft;
  const n = draft.vertices.length,
    vertices = [...draft.vertices, point];
  const edges = draft.edges.flatMap((edge): MeshEdge[] =>
    pointOnSegment(vertices[edge.a], vertices[edge.b], point) === null
      ? [edge]
      : [
          { ...edge, b: n },
          { ...edge, a: n },
        ],
  );
  const next = { ...draft, vertices, edges, indices: insertionDomain(draft, point) };
  return rebuildAutomaticEdges({
    ...next,
    edges: penEdges(next, n),
    selected: additive ? [...draft.selected, n] : [n],
  });
}

export function connectVertex(draft: MeshDraft, to: number): MeshDraft {
  const edges = penEdges(draft, to);
  if (edges.length === draft.edges.filter((edge) => edge.priority > 10).length) return draft;
  return rebuildAutomaticEdges({ ...draft, edges });
}

/** Auto connect fixes the preview triangulation without discarding outlines or hand-drawn edges. */
export function autoConnect(draft: MeshDraft): MeshDraft {
  if (draft.edges.every((edge) => edge.priority >= 30)) return draft;
  return {
    ...draft,
    edges: draft.edges.map((edge) => (edge.priority >= 30 ? edge : { ...edge, priority: 30 })),
  };
}

/** Rebuild only within the edited boundaries, preserving transparent holes and islands. */
export function deleteVertices(draft: MeshDraft): MeshDraft {
  const removed = new Set(draft.selected),
    remap = new Map<number, number>();
  const vertices = draft.vertices.filter((_, i) => {
    if (removed.has(i)) return false;
    remap.set(i, remap.size);
    return true;
  });
  if (!removed.size) return draft;
  const remainingEdges = boundary(draft.vertices, draft.indices);
  const rings: number[][] = [];
  while (remainingEdges.length) {
    const [first, second] = remainingEdges.pop()!,
      ring = [first];
    let next = second;
    while (next !== first) {
      ring.push(next);
      const edge = remainingEdges.findIndex(([a]) => a === next);
      if (edge < 0) throw new Error('The mesh boundary is not closed.');
      next = remainingEdges.splice(edge, 1)[0][1];
    }
    const kept = ring.flatMap((i) => (remap.has(i) ? [remap.get(i)!] : []));
    if (kept.length >= 3) rings.push(kept);
  }
  const outline = rings.flatMap((ring) =>
    ring.map((a, i) => [a, ring[(i + 1) % ring.length]] as [number, number]),
  );
  const fixed = draft.edges
    .filter((e) => !removed.has(e.a) && !removed.has(e.b) && e.priority > 10)
    .map((e) => ({ ...e, a: remap.get(e.a)!, b: remap.get(e.b)! }));
  const indices = triangulateRegion(vertices, fixed, outline);
  return { vertices, indices, edges: withAutomaticEdges(indices, fixed), selected: [] };
}

/** Remove fixed connections and/or points, then regenerate only the supplemental triangulation. */
export function eraseMesh(draft: MeshDraft, vertices: Set<number>, edges: Set<string>): MeshDraft {
  const fixed = draft.edges.filter(
    (edge) => edge.priority > 10 && !edges.has(edgeKey(edge.a, edge.b)),
  );
  if (!vertices.size && fixed.length === draft.edges.filter((edge) => edge.priority > 10).length)
    return draft;
  const next = { ...draft, edges: fixed };
  return vertices.size
    ? deleteVertices({ ...next, selected: [...vertices] })
    : rebuildAutomaticEdges(next);
}

/** Four-way subdivision keeps the original outline and every existing triangle connection. */
export function subdivideMesh(draft: MeshDraft): MeshDraft {
  const vertices = [...draft.vertices],
    midpoints = new Map<string, number>();
  const midpoint = (a: number, b: number) => {
    const key = edgeKey(a, b);
    if (!midpoints.has(key)) {
      midpoints.set(key, vertices.length);
      vertices.push({
        u: (vertices[a].u + vertices[b].u) / 2,
        v: (vertices[a].v + vertices[b].v) / 2,
      });
    }
    return midpoints.get(key)!;
  };
  const indices = triangles(vertices, draft.indices).flatMap(([a, b, c]) => {
    const ab = midpoint(a, b),
      bc = midpoint(b, c),
      ca = midpoint(c, a);
    return [a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca];
  });
  const split = draft.edges.flatMap((edge) => {
    const mid = midpoints.get(edgeKey(edge.a, edge.b));
    return mid === undefined
      ? [edge]
      : [
          { ...edge, b: mid },
          { ...edge, a: mid },
        ];
  });
  // Subdivision is an explicit topology operation: the new triangle connections are fixed.
  const fixed = new Map(split.map((edge) => [edgeKey(edge.a, edge.b), edge]));
  const connections = new Map(
    meshConnections(indices).map((edge) => [edgeKey(edge.a, edge.b), edge]),
  );
  for (const [key, edge] of fixed) connections.set(key, edge);
  const edges = [...connections.values()];
  return { vertices, indices, edges, selected: draft.selected };
}

export function validMesh(draft: MeshDraft) {
  return (
    draft.vertices.length >= 3 &&
    draft.vertices.length <= 10000 &&
    draft.indices.length >= 3 &&
    draft.indices.length <= 60000 &&
    draft.indices.length % 3 === 0 &&
    draft.vertices.every(
      (p) =>
        Number.isFinite(p.u) && Number.isFinite(p.v) && Math.abs(p.u) <= 10 && Math.abs(p.v) <= 10,
    ) &&
    triangles(draft.vertices, draft.indices).every(
      ([a, b, c]) =>
        Math.abs(cross(draft.vertices[a], draft.vertices[b], draft.vertices[c])) > 1e-12,
    )
  );
}
