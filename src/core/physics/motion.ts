import { z } from 'zod';

const motionSchema = z.object({
  Version: z.literal(3),
  Meta: z.object({ Duration: z.number().positive().max(3600) }),
  Curves: z
    .array(
      z.object({
        Target: z.string(),
        Id: z.string(),
        Segments: z.array(z.number().finite()).min(2).max(200000),
      }),
    )
    .max(1000),
});
interface Segment {
  type: number;
  start: [number, number];
  points: [number, number][];
}
export interface PhysicsMotion {
  id: string;
  name: string;
  duration: number;
  curves: { id: string; segments: Segment[]; initial: [number, number] }[];
}
export function readPhysicsMotion(raw: unknown, name: string): PhysicsMotion {
  const json = motionSchema.parse(raw);
  return {
    id: crypto.randomUUID(),
    name,
    duration: json.Meta.Duration,
    curves: json.Curves.filter((c) => c.Target === 'Parameter').map((c) => {
      const a = c.Segments,
        initial: [number, number] = [a[0], a[1]],
        segments: Segment[] = [];
      let start = initial;
      for (let i = 2; i < a.length;) {
        const type = a[i++],
          count = type === 1 ? 3 : 1;
        if (![0, 1, 2, 3].includes(type) || i + count * 2 > a.length)
          throw new Error(`Invalid motion segment: ${c.Id}`);
        const points = Array.from({ length: count }, () => [a[i++], a[i++]] as [number, number]);
        const end = points.at(-1)!;
        if (
          end[0] <= start[0] ||
          (type === 1 &&
            (points[0][0] < start[0] || points[1][0] > end[0] || points[0][0] > points[1][0]))
        )
          throw new Error(`Motion time coordinates must increase: ${c.Id}`);
        segments.push({ type, start, points });
        start = end;
      }
      return { id: c.Id, initial, segments };
    }),
  };
}
const cubic = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
export function evaluatePhysicsMotion(motion: PhysicsMotion, time: number) {
  return Object.fromEntries(
    motion.curves.map((c) => {
      const segment = c.segments.find((s) => s.points.at(-1)![0] >= time);
      if (!segment) return [c.id, c.segments.at(-1)?.points.at(-1)![1] ?? c.initial[1]];
      const { type, start, points } = segment,
        end = points.at(-1)!;
      if (time <= start[0]) return [c.id, start[1]];
      if (time >= end[0]) return [c.id, end[1]];
      if (type === 2) return [c.id, start[1]];
      if (type === 3) return [c.id, end[1]];
      if (type === 0)
        return [c.id, start[1] + ((end[1] - start[1]) * (time - start[0])) / (end[0] - start[0])];
      let lo = 0,
        hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (cubic(start[0], points[0][0], points[1][0], end[0], mid) < time) lo = mid;
        else hi = mid;
      }
      return [c.id, cubic(start[1], points[0][1], points[1][1], end[1], (lo + hi) / 2)];
    }),
  );
}
