import type { Point } from './evaluate';
/** Chord-length Hermite spline with local cubic derivatives (Cubism LCNS). */
export function curveSamples(
  points: Point[],
  divisions = 20,
  closed = false,
  corners: boolean[] = [],
): Point[] {
  if (points.length < 2) return points;
  const n = points.length,
    at = (i: number) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  const lengths = Array.from({ length: closed ? n : n - 1 }, (_, i) =>
    Math.max(1e-5, Math.hypot(at(i + 1)[0] - at(i)[0], at(i + 1)[1] - at(i)[1])),
  );
  const tangents: Point[] = points.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return [0, 0];
    const before = at(i - 1),
      after = at(i + 1),
      a = lengths[(i - 1 + lengths.length) % lengths.length],
      b = lengths[i % lengths.length];
    return [
      ((b * (p[0] - before[0])) / a + (a * (after[0] - p[0])) / b) / (a + b),
      ((b * (p[1] - before[1])) / a + (a * (after[1] - p[1])) / b) / (a + b),
    ];
  });
  if (!closed) {
    for (const axis of [0, 1]) {
      tangents[0][axis] =
        (2 * (points[1][axis] - points[0][axis])) / lengths[0] - tangents[1][axis];
      tangents[n - 1][axis] =
        (2 * (points[n - 1][axis] - points[n - 2][axis])) / lengths[n - 2] - tangents[n - 2][axis];
    }
  }
  const result: Point[] = [];
  for (let i = 0; i < lengths.length; i++)
    for (let step = 0; step < divisions; step++) {
      const t = step / divisions,
        t2 = t * t,
        t3 = t2 * t,
        a = at(i),
        b = at(i + 1),
        m0 = tangents[i],
        m1 = tangents[(i + 1) % n],
        h = lengths[i];
      result.push(
        corners[i] && corners[(i + 1) % n]
          ? [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
          : ([0, 1].map(
              (axis) =>
                (2 * t3 - 3 * t2 + 1) * a[axis] +
                (t3 - 2 * t2 + t) * m0[axis] * h +
                (-2 * t3 + 3 * t2) * b[axis] +
                (t3 - t2) * m1[axis] * h,
            ) as Point),
      );
    }
  result.push(closed ? points[0] : points[n - 1]);
  return result;
}
export function strokeMesh(
  points: Point[],
  widths: number[],
  divisions = 20,
  closed = false,
  corners: boolean[] = [],
) {
  const curve = curveSamples(points, divisions, closed, corners),
    positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (let i = 0; i < curve.length; i++) {
    const before = curve[Math.max(0, i - 1)],
      after = curve[Math.min(curve.length - 1, i + 1)],
      dx = after[0] - before[0],
      dy = after[1] - before[1],
      length = Math.hypot(dx, dy) || 1,
      index = Math.min(widths.length - 1, Math.floor(i / divisions)),
      t = (i % divisions) / divisions;
    // Native ArtPath width is the offset on each side of the centerline.
    const radius = widths[index] * (1 - t) + widths[(index + 1) % widths.length] * t;
    positions.push(
      curve[i][0] - (dy / length) * radius,
      curve[i][1] + (dx / length) * radius,
      curve[i][0] + (dy / length) * radius,
      curve[i][1] - (dx / length) * radius,
    );
    uvs.push(0.5, 0.5, 0.5, 0.5);
    if (i) indices.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
  }
  return { positions, uvs, indices };
}
