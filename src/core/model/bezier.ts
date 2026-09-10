import { warpPoint, type Point } from './evaluate';

const bernstein = (t: number) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
const interpolate = (p: Point[]) => [
  p[0],
  [0, 1].map((i) => (-5 * p[0][i] + 18 * p[1][i] - 9 * p[2][i] + 2 * p[3][i]) / 6) as Point,
  [0, 1].map((i) => (2 * p[0][i] - 9 * p[1][i] + 18 * p[2][i] - 5 * p[3][i]) / 6) as Point,
  p[3],
];

/** Fit tensor Bézier controls to the evaluated warp; edits apply only their displacement field. */
export function bezierControls(
  positions: ArrayLike<number>,
  columns: number,
  rows: number,
  bezierColumns: number,
  bezierRows: number,
) {
  const width = bezierColumns * 3 + 1,
    height = bezierRows * 3 + 1,
    result: Point[] = Array(width * height);
  for (let r = 0; r < bezierRows; r++)
    for (let c = 0; c < bezierColumns; c++) {
      const samples = Array.from({ length: 4 }, (_, j) =>
        interpolate(
          Array.from({ length: 4 }, (_, i) =>
            warpPoint(
              positions,
              columns,
              rows,
              true,
              (c + i / 3) / bezierColumns,
              (r + j / 3) / bezierRows,
            ),
          ),
        ),
      );
      for (let i = 0; i < 4; i++) {
        const curve = interpolate(samples.map((row) => row[i]));
        for (let j = 0; j < 4; j++) result[(r * 3 + j) * width + c * 3 + i] = curve[j];
      }
    }
  return { width, height, points: result };
}
export function moveBezierControl(
  positions: ArrayLike<number>,
  columns: number,
  rows: number,
  bezierColumns: number,
  bezierRows: number,
  index: number,
  delta: Point,
) {
  const width = bezierColumns * 3 + 1,
    c = index % width,
    r = Math.floor(index / width),
    anchor = c % 3 === 0 && r % 3 === 0;
  return Array.from({ length: positions.length / 2 }, (_, i) => {
    const u = ((i % (columns + 1)) / columns) * bezierColumns,
      v = (Math.floor(i / (columns + 1)) / rows) * bezierRows,
      cellX = Math.min(bezierColumns - 1, Math.floor(u)),
      cellY = Math.min(bezierRows - 1, Math.floor(v)),
      bx = bernstein(u - cellX),
      by = bernstein(v - cellY);
    let weight = 0;
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++)
        if (
          anchor
            ? Math.abs(cellX * 3 + k - c) <= 1 && Math.abs(cellY * 3 + j - r) <= 1
            : cellX * 3 + k === c && cellY * 3 + j === r
        )
          weight += bx[k] * by[j];
    return {
      index: i,
      x: positions[i * 2] + delta[0] * weight,
      y: positions[i * 2 + 1] + delta[1] * weight,
    };
  });
}
