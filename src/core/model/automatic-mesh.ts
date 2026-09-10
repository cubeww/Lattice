import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { contours } from 'd3-contour';
import { signedDistance } from './distance-field';
import { applyMatrix } from './selection';
import {
  automaticMeshFields,
  type AutomaticMeshInput,
  type AutomaticMeshSettings,
  type GeneratedMesh,
} from '../../shared/automatic-mesh';

type Point = [number, number];
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
    );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function simplify(points: Point[], tolerance: number): Point[] {
  const keep = new Uint8Array(points.length),
    stack = [[0, points.length - 1]];
  keep[0] = keep[points.length - 1] = 1;
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let max = tolerance,
      split = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > max) {
        max = d;
        split = i;
      }
    }
    if (split !== -1) {
      keep[split] = 1;
      stack.push([first, split], [split, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
function sampleRing(
  ring: number[][],
  interval: number,
  minimum: number,
  tolerance: number,
): Point[] {
  // Split a closed ring into two open arcs before simplifying, so a small island
  // can never collapse to a line just because its endpoints coincide.
  const points = ring.slice(0, -1) as Point[];
  if (points.length < 3) return [];
  let opposite = 1;
  for (let i = 2; i < points.length; i++)
    if (distance(points[0], points[i]) > distance(points[0], points[opposite])) opposite = i;
  const simplified = [
    ...simplify(points.slice(0, opposite + 1), tolerance).slice(0, -1),
    ...simplify([...points.slice(opposite), points[0]], tolerance).slice(0, -1),
  ];
  const perimeter = simplified.reduce(
      (n, p, i) => n + distance(p, simplified[(i + 1) % simplified.length]),
      0,
    ),
    step = Math.min(interval, perimeter / minimum),
    result: Point[] = [];
  if (simplified.length < 3 || step < 1e-6) return [];
  for (let i = 0; i < simplified.length; i++) {
    const a = simplified[i],
      b = simplified[(i + 1) % simplified.length],
      count = Math.ceil(distance(a, b) / step);
    for (let j = 0; j < count; j++)
      result.push([a[0] + ((b[0] - a[0]) * j) / count, a[1] + ((b[1] - a[1]) * j) / count]);
  }
  return result;
}
function inRing(x: number, y: number, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

/** Alpha contours and a constrained Delaunay mesh, shared by the UI worker and MCP. */
export function generateAutomaticMesh(
  input: AutomaticMeshInput,
  alpha: Uint8Array,
  settings: AutomaticMeshSettings,
): GeneratedMesh {
  for (const [key, { min, max }] of Object.entries(automaticMeshFields)) {
    const value = settings[key as keyof AutomaticMeshSettings];
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`Invalid automatic mesh setting: ${key}.`);
  }
  const { width: imageWidth, height: imageHeight } = input.image;
  if (alpha.length !== imageWidth * imageHeight)
    throw new Error('Source image dimensions do not match.');
  let minX = imageWidth,
    minY = imageHeight,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < imageHeight; y++)
    for (let x = 0; x < imageWidth; x++)
      if (alpha[y * imageWidth + x] > settings.alphaThreshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
  if (maxX < minX) throw new Error('No pixels remain above the alpha threshold.');
  const margin = Math.max(settings.outsideMargin, settings.minimumMargin),
    padding = Math.ceil(margin) + 3,
    originX = minX - padding,
    originY = minY - padding,
    width = maxX - minX + 1 + padding * 2,
    height = maxY - minY + 1 + padding * 2;
  if (width * height > 20_000_000)
    throw new Error('The source image is too large for automatic meshing (20 million pixels).');
  const mask = new Uint8Array(width * height);
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++)
      mask[(y - originY) * width + x - originX] = Number(
        alpha[y * imageWidth + x] > settings.alphaThreshold,
      );
  const field = signedDistance(mask, width, height),
    contour = contours().size([width, height]),
    outer = contour.contour(field as unknown as number[], -margin - 0.5),
    tolerance = Math.max(0.2, margin - settings.minimumMargin),
    polygons = outer.coordinates
      .map((polygon) =>
        polygon
          .map((ring) =>
            sampleRing(ring, settings.outsideInterval, settings.minimumBoundaryPoints, tolerance),
          )
          .filter((r) => r.length >= 3),
      )
      .filter((p) => p.length);
  if (!polygons.length) throw new Error('No usable image boundary was found.');
  const inside = (x: number, y: number) =>
      polygons.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((r) => inRing(x, y, r))),
    points: Point[] = [],
    sourceIndices = new Map<number, number>(),
    constraints: [number, number][] = [],
    boundaryLoops: number[][] = [],
    buckets = new Map<string, number[]>(),
    bucketSize = Math.min(settings.insideInterval, settings.outsideInterval),
    exact = new Map<string, number>();
  const add = (point: Point, separation = 0) => {
    const key = point.map((v) => v.toFixed(7)).join(','),
      existing = exact.get(key);
    if (existing !== undefined) return existing;
    const bx = Math.floor(point[0] / bucketSize),
      by = Math.floor(point[1] / bucketSize),
      range = Math.ceil(separation / bucketSize);
    if (separation)
      for (let y = by - range; y <= by + range; y++)
        for (let x = bx - range; x <= bx + range; x++)
          if (buckets.get(`${x},${y}`)?.some((i) => distance(points[i], point) < separation))
            return -1;
    if (points.length >= 10000)
      throw new Error('Use a larger vertex interval (maximum 10,000 vertices per mesh).');
    const id = points.length,
      cell = `${bx},${by}`;
    points.push(point);
    exact.set(key, id);
    const list = buckets.get(cell) || [];
    list.push(id);
    buckets.set(cell, list);
    return id;
  };
  for (const polygon of polygons)
    for (const ring of polygon) {
      const ids = ring.map((p) => add(p));
      boundaryLoops.push(ids);
      for (let i = 0; i < ids.length; i++)
        if (ids[i] !== ids[(i + 1) % ids.length])
          constraints.push([ids[i], ids[(i + 1) % ids.length]]);
    }
  for (const anchor of input.anchors) {
    const p: Point = [anchor.x - originX, anchor.y - originY];
    // Glue is persistent topology. Never silently remove an attached vertex.
    if (
      !inside(...p) &&
      !constraints.some(([a, b]) => segmentDistance(p, points[a], points[b]) < 1e-6)
    )
      throw new Error(
        'A glued vertex lies outside the generated outline. Increase the boundary margin or edit the glue first.',
      );
    const id = add(p);
    if (sourceIndices.has(id) && sourceIndices.get(id) !== anchor.sourceIndex)
      throw new Error('Coincident glued vertices cannot be remeshed.');
    sourceIndices.set(id, anchor.sourceIndex);
  }
  const farFromBoundary = (p: Point, gap: number) =>
    !constraints.some(([a, b]) => segmentDistance(p, points[a], points[b]) < gap);
  const inner = contour.contour(field as unknown as number[], settings.insideMargin + 0.5),
    gap = Math.max(1, Math.min(settings.insideInterval * 0.3, margin + settings.insideMargin));
  for (const polygon of inner.coordinates)
    for (const ring of polygon)
      for (const p of sampleRing(
        ring,
        settings.insideInterval,
        3,
        Math.max(0.5, settings.insideInterval * 0.035),
      ))
        if (inside(...p) && farFromBoundary(p, 0.5)) add(p, gap);
  const step = settings.insideInterval,
    rowStep = (step * Math.sqrt(3)) / 2;
  for (let row = 0, y = padding + rowStep / 2; y < height - padding; row++, y += rowStep)
    for (let x = padding + step * (row % 2 ? 0.5 : 1); x < width - padding; x += step) {
      const p: Point = [x, y],
        at = field[Math.floor(y) * width + Math.floor(x)];
      if (at >= settings.insideMargin && inside(x, y) && farFromBoundary(p, gap))
        add(p, step * 0.6);
    }
  // Split constraints at retained anchors lying exactly on an edge.
  const edges: [number, number][] = [];
  for (const [a, b] of constraints) {
    const between = [...sourceIndices.keys()].filter(
      (i) => i !== a && i !== b && segmentDistance(points[i], points[a], points[b]) < 1e-7,
    );
    const ids = [
      a,
      ...between.sort((i, j) => distance(points[a], points[i]) - distance(points[a], points[j])),
      b,
    ];
    for (let i = 1; i < ids.length; i++) edges.push([ids[i - 1], ids[i]]);
  }
  const delaunay = Delaunator.from(points);
  new Constrainautor(delaunay).constrainAll(edges);
  const indices: number[] = [];
  for (let i = 0; i < delaunay.triangles.length; i += 3) {
    const a = delaunay.triangles[i],
      b = delaunay.triangles[i + 1],
      c = delaunay.triangles[i + 2],
      p = points[a],
      q = points[b],
      r = points[c];
    if (!inside((p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3)) continue;
    const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if (Math.abs(cross) < 1e-8) continue;
    indices.push(a, cross > 0 ? b : c, cross > 0 ? c : b);
  }
  if (!indices.length) throw new Error('No usable triangles were generated.');
  const used = new Set(indices);
  if ([...sourceIndices.keys()].some((i) => !used.has(i)))
    throw new Error('The generated mesh would detach a glued vertex.');
  const remap = new Map([...used].sort((a, b) => a - b).map((id, i) => [id, i]));
  return {
    guid: input.guid,
    vertices: [...remap.keys()].map((i) => {
      const [u, v] = applyMatrix(input.toTexture, points[i][0] + originX, points[i][1] + originY);
      return { u, v, ...(sourceIndices.has(i) ? { sourceIndex: sourceIndices.get(i)! } : {}) };
    }),
    indices: indices.map((i) => remap.get(i)!),
    boundaryLoops: boundaryLoops.map((ring) =>
      ring.filter((i) => remap.has(i)).map((i) => remap.get(i)!),
    ),
  };
}
