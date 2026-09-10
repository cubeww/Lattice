import type { Point } from './evaluate';
import type { SourceController } from '../../shared/scene';
import { sampleSurface } from './topology';
import { curveSamples } from './curves';

export function controllerPoints(
  controller: SourceController,
  positions: ArrayLike<number>,
): Point[] {
  return controller.points.map((p) => sampleSurface(positions, p));
}

export function closestOnCurve(point: Point, points: Point[]) {
  let distance = Infinity,
    totalT = 0,
    closest: Point = points[0];
  const samples = curveSamples(points, 20);
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i],
      b = samples[i + 1];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
    );
    const p: Point = [a[0] + dx * t, a[1] + dy * t],
      d = Math.hypot(point[0] - p[0], point[1] - p[1]);
    if (d < distance) {
      distance = d;
      totalT = (i + t) / 20;
      closest = p;
    }
  }
  return { distance, totalT, closest };
}

/** A curve handle moves a smooth neighborhood, while its mesh attachment stays exact. */
export function controllerDisplacement(
  controller: SourceController,
  positions: ArrayLike<number>,
  index: number,
  delta: Point,
) {
  const controls = controllerPoints(controller, positions);
  const weights = Array.from({ length: positions.length / 2 }, (_, i) => {
    const p: Point = [positions[i * 2], positions[i * 2 + 1]];
    const inverse = controls.map(
      (c) => 1 / Math.max(0.01, Math.hypot(c[0] - p[0], c[1] - p[1])) ** 3,
    );
    const distance = closestOnCurve(p, controls).distance;
    const edge = Math.max(1, controller.width / 2),
      hard = edge * controller.hardness;
    const t = Math.max(0, Math.min(1, (edge - distance) / Math.max(0.001, edge - hard)));
    return (inverse[index] / inverse.reduce((a, b) => a + b, 0)) * t * t * (3 - 2 * t);
  });
  const attachment = controller.points[index];
  const response = attachment.indices.reduce(
    (sum, vertex, i) => sum + weights[vertex] * attachment.weights[i],
    0,
  );
  if (Math.abs(response) < 1e-6)
    throw new Error('The path handle is outside its influence region. Increase the path width.');
  return Array.from({ length: positions.length / 2 }, (_, i) => ({
    index: i,
    x: positions[i * 2] + (delta[0] * weights[i]) / response,
    y: positions[i * 2 + 1] + (delta[1] * weights[i]) / response,
  }));
}
