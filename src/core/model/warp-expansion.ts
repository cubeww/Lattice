import type { Point } from './evaluate';

/** Cubism's edge-similarity extension: extrapolate boundary endpoints, fit each
 * new edge to the old edge, and complete corners as parallelograms. */
export function expandedWarpPositions(
  positions: number[],
  columns: number,
  rows: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
) {
  const nc = columns + left + right,
    nr = rows + top + bottom;
  const points: Point[][] = Array.from({ length: nr + 1 }, () => Array(nc + 1));
  const x0 = left,
    x1 = left + columns,
    y0 = top,
    y1 = top + rows;
  for (let y = 0; y <= rows; y++)
    for (let x = 0; x <= columns; x++)
      points[y + y0][x + x0] = [
        positions[(y * (columns + 1) + x) * 2],
        positions[(y * (columns + 1) + x) * 2 + 1],
      ];
  const extend = (x: number, y: number, dx: number, dy: number, divisions: number) => {
    const a = points[y - dy][x - dx],
      b = points[y - dy * 2][x - dx * 2],
      c = divisions > 1 ? points[y - dy * 3][x - dx * 3] : null;
    points[y][x] = [0, 1].map((i) => (c ? 3 * a[i] - 3 * b[i] + c[i] : 2 * a[i] - b[i])) as Point;
  };
  for (let x = x0 - 1; x >= 0; x--) for (const y of [y0, y1]) extend(x, y, -1, 0, columns);
  for (let x = x1 + 1; x <= nc; x++) for (const y of [y0, y1]) extend(x, y, 1, 0, columns);
  for (let y = y0 - 1; y >= 0; y--) for (const x of [x0, x1]) extend(x, y, 0, -1, rows);
  for (let y = y1 + 1; y <= nr; y++) for (const x of [x0, x1]) extend(x, y, 0, 1, rows);
  for (let y = 0; y <= nr; y++)
    if (y < y0 || y > y1)
      for (let x = 0; x <= nc; x++)
        if (x < x0 || x > x1) {
          const edgeX = x < x0 ? x0 : x1,
            edgeY = y < y0 ? y0 : y1;
          points[y][x] = [0, 1].map(
            (i) => points[y][edgeX][i] + points[edgeY][x][i] - points[edgeY][edgeX][i],
          ) as Point;
        }
  const fit = (edge: Point[], a: Point, b: Point): Point[] => {
    const start = edge[0],
      end = edge.at(-1)!,
      u: Point = [end[0] - start[0], end[1] - start[1]],
      v: Point = [b[0] - a[0], b[1] - a[1]];
    const length = u[0] * u[0] + u[1] * u[1];
    if (length < 1e-16)
      return edge.map((_, i) => [
        a[0] + (v[0] * i) / (edge.length - 1),
        a[1] + (v[1] * i) / (edge.length - 1),
      ]);
    const real = (u[0] * v[0] + u[1] * v[1]) / length,
      imaginary = (u[0] * v[1] - u[1] * v[0]) / length;
    return edge.map((p) => [
      a[0] + real * (p[0] - start[0]) - imaginary * (p[1] - start[1]),
      a[1] + imaginary * (p[0] - start[0]) + real * (p[1] - start[1]),
    ]);
  };
  for (const [boundary, from, to] of [
    [x0, 0, x0 - 1],
    [x1, x1 + 1, nc],
  ]) {
    const edge = points.slice(y0, y1 + 1).map((row) => row[boundary]);
    for (let x = from; x <= to; x++) {
      const fitted = fit(edge, points[y0][x], points[y1][x]);
      for (let y = y0 + 1; y < y1; y++) points[y][x] = fitted[y - y0];
    }
  }
  for (const [boundary, from, to] of [
    [y0, 0, y0 - 1],
    [y1, y1 + 1, nr],
  ]) {
    const edge = points[boundary].slice(x0, x1 + 1);
    for (let y = from; y <= to; y++) {
      const fitted = fit(edge, points[y][x0], points[y][x1]);
      for (let x = x0 + 1; x < x1; x++) points[y][x] = fitted[x - x0];
    }
  }
  return points.flat(2);
}
