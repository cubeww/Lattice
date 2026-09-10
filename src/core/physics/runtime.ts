import type { PhysicsGroup, PhysicsRange, PhysicsSettings } from '../../shared/physics';

type Vec = { x: number; y: number };
export interface PhysicsParameter {
  id: string;
  min: number;
  max: number;
  default: number;
}
export interface PhysicsPeak {
  min: number;
  max: number;
  percent: number;
  clipped: boolean;
}
interface Particle {
  position: Vec;
  velocity: Vec;
  gravity: Vec;
}
interface Rig {
  particles: Particle[];
  previous: number[];
  current: number[];
  angle: number;
}
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const angleBetween = (from: Vec, to: Vec) =>
  Math.atan2(from.x * to.y - from.y * to.x, from.x * to.x + from.y * to.y);
const rotate = (p: Vec, angle: number): Vec => ({
  x: p.x * Math.cos(angle) - p.y * Math.sin(angle),
  y: p.x * Math.sin(angle) + p.y * Math.cos(angle),
});

/** Cubism input normalization is centered on the range midpoint, not the model's default pose. */
export function normalizePhysicsInput(
  value: number,
  p: PhysicsParameter,
  r: PhysicsRange,
  reflect: boolean,
) {
  const center = (p.min + p.max) / 2;
  value = clamp(value, p.min, p.max);
  const half = (p.max - p.min) / 2;
  const normalized = !half
    ? r.default
    : r.default +
      ((value - center) / half) * (value >= center ? r.max - r.default : r.default - r.min);
  return normalized * (reflect ? 1 : -1);
}

/** Stateful follow-the-leader pendulums. No renderer, IPC or SDK dependency. */
export class PhysicsRuntime {
  private rigs: Rig[] = [];
  private accumulator = 0;
  private previousInputs: Record<string, number> | null = null;
  private readonly parameters: Map<string, PhysicsParameter>;
  readonly peaks: Record<string, PhysicsPeak> = {};
  disabled = new Set<string>();
  collectPeaks = true;
  wind: Vec = { x: 0, y: 0 };
  constructor(
    readonly settings: PhysicsSettings,
    parameters: PhysicsParameter[],
    previous?: PhysicsRuntime,
  ) {
    this.parameters = new Map(parameters.map((p) => [p.id, p]));
    this.reset();
    if (previous) {
      this.previousInputs = previous.previousInputs && { ...previous.previousInputs };
      this.accumulator = Math.min(previous.accumulator, 1 / settings.fps);
      settings.groups.forEach((group, i) => {
        const oldIndex = previous.settings.groups.findIndex((g) => g.guid === group.guid);
        if (oldIndex < 0) return;
        const oldGroup = previous.settings.groups[oldIndex],
          oldRig = previous.rigs[oldIndex],
          rig = this.rigs[i];
        rig.angle = oldRig.angle;
        group.particles.forEach((p, index) => {
          const old = oldGroup.particles.findIndex((q) => q.guid === p.guid);
          if (old >= 0) rig.particles[index] = structuredClone(oldRig.particles[old]);
        });
        group.outputs.forEach((p, index) => {
          const old = oldGroup.outputs.findIndex(
            (q) =>
              q.guid === p.guid &&
              q.type === p.type &&
              oldGroup.particles[q.vertexIndex]?.guid === group.particles[p.vertexIndex]?.guid,
          );
          if (old >= 0) {
            const sign = oldGroup.outputs[old].reflect === p.reflect ? 1 : -1;
            rig.previous[index] = oldRig.previous[old] * sign;
            rig.current[index] = oldRig.current[old] * sign;
          }
        });
      });
    }
  }
  reset() {
    this.accumulator = 0;
    this.previousInputs = null;
    this.rigs = this.settings.groups.map((g) => {
      let y = 0;
      return {
        angle: 0,
        previous: g.outputs.map(() => 0),
        current: g.outputs.map(() => 0),
        particles: g.particles.map((p, i) => ({
          position: { x: 0, y: i ? (y += p.radius) : 0 },
          velocity: { x: 0, y: 0 },
          gravity: { x: 0, y: 1 },
        })),
      };
    });
    this.resetPeaks();
  }
  resetPeaks(guids?: string[]) {
    for (const guid of guids || Object.keys(this.peaks)) delete this.peaks[guid];
  }
  snapshot() {
    return this.settings.groups.map((g, i) => ({
      guid: g.guid,
      angle: this.rigs[i].angle,
      particles: this.rigs[i].particles.map((p) => ({ ...p.position })),
    }));
  }
  private base(values: Record<string, number>) {
    return Object.fromEntries(
      [...this.parameters.values()].map((p) => [
        p.id,
        clamp(values[p.id] ?? p.default, p.min, p.max),
      ]),
    );
  }
  private output(
    group: PhysicsGroup,
    values: Record<string, number>,
    raw: number[],
    record: boolean,
  ) {
    group.outputs.forEach((o, index) => {
      const p = this.parameters.get(o.parameterId);
      if (!p) return;
      const value = raw[index] * o.scale;
      if (record && this.collectPeaks) {
        const peak = (this.peaks[o.guid] ||= { min: 0, max: 0, percent: 0, clipped: false });
        peak.min = Math.min(peak.min, value);
        peak.max = Math.max(peak.max, value);
        const range = Math.max(Math.abs(p.min), Math.abs(p.max));
        peak.percent = range ? (Math.max(Math.abs(peak.min), Math.abs(peak.max)) / range) * 100 : 0;
        peak.clipped ||= value < p.min || value > p.max;
      }
      const weight = o.weight / 100;
      values[p.id] = values[p.id] * (1 - weight) + clamp(value, p.min, p.max) * weight;
    });
  }
  private step(base: Record<string, number>, dt: number) {
    const values = { ...base };
    this.settings.groups.forEach((g, index) => {
      if (this.disabled.has(g.guid)) return;
      const rig = this.rigs[index],
        particles = rig.particles;
      if (!particles.length) return;
      let x = 0,
        y = 0,
        angle = 0;
      for (const input of g.inputs) {
        const p = this.parameters.get(input.parameterId);
        if (!p) continue;
        const value =
          (normalizePhysicsInput(
            values[p.id],
            p,
            input.type === 'Angle' ? g.normalization.angle : g.normalization.position,
            input.reflect,
          ) *
            input.weight) /
          100;
        if (input.type === 'Angle') angle += value;
        else if (input.type === 'X') x += value;
        else y += value;
      }
      rig.angle = angle;
      const radians = (angle * Math.PI) / 180;
      particles[0].position = rotate({ x, y }, -radians);
      const gravity = { x: Math.sin(radians), y: Math.cos(radians) };
      for (let i = 1; i < particles.length; i++) {
        const p = particles[i],
          parent = particles[i - 1].position,
          definition = g.particles[i];
        const old = p.position;
        const direction = rotate(
          { x: old.x - parent.x, y: old.y - parent.y },
          angleBetween(p.gravity, gravity) / 5,
        );
        const delay = definition.delay * dt * 30;
        const dx =
          direction.x +
          p.velocity.x * delay +
          (gravity.x * definition.acceleration + this.wind.x) * delay * delay;
        const dy =
          direction.y +
          p.velocity.y * delay +
          (gravity.y * definition.acceleration + this.wind.y) * delay * delay;
        const length = Math.hypot(dx, dy);
        p.position =
          length > 1e-10
            ? {
                x: parent.x + (dx / length) * definition.radius,
                y: parent.y + (dy / length) * definition.radius,
              }
            : {
                x: parent.x + gravity.x * definition.radius,
                y: parent.y + gravity.y * definition.radius,
              };
        if (Math.abs(p.position.x) < 0.001 * Math.abs(g.normalization.position.max))
          p.position.x = 0;
        p.velocity =
          delay > 0
            ? {
                x: ((p.position.x - old.x) / delay) * definition.mobility,
                y: ((p.position.y - old.y) / delay) * definition.mobility,
              }
            : { x: 0, y: 0 };
        p.gravity = gravity;
      }
      rig.previous = rig.current;
      rig.current = g.outputs.map((o) => {
        const i = o.vertexIndex;
        if (!particles[i] || i < 1) return 0;
        const a = particles[i - 1].position,
          b = particles[i].position;
        const segment = { x: b.x - a.x, y: b.y - a.y };
        const parent =
          i > 1
            ? { x: a.x - particles[i - 2].position.x, y: a.y - particles[i - 2].position.y }
            : { x: 0, y: 1 };
        const raw =
          o.type === 'X' ? segment.x : o.type === 'Y' ? segment.y : angleBetween(parent, segment);
        return raw * (o.reflect ? -1 : 1);
      });
      this.output(g, values, rig.current, true);
    });
  }
  advance(deltaSeconds: number, input: Record<string, number>): Record<string, number> {
    const base = this.base(input);
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
      throw new Error('Invalid physics time step.');
    // Cap catch-up after a suspended window; normal frames use fixed simulation steps.
    const dt = Math.min(deltaSeconds, 0.25),
      step = 1 / this.settings.fps;
    const previous = this.previousInputs || base;
    this.accumulator += dt;
    while (this.accumulator + 1e-10 >= step) {
      const t = dt ? clamp((dt - this.accumulator + step) / dt, 0, 1) : 1;
      const values = Object.fromEntries(
        Object.entries(base).map(([id, v]) => {
          const from = previous[id] ?? v;
          return [id, from + (v - from) * t];
        }),
      );
      this.step(values, step);
      this.accumulator -= step;
    }
    this.accumulator = Math.max(0, this.accumulator);
    this.previousInputs = base;
    const values = { ...base },
      alpha = this.accumulator / step;
    this.settings.groups.forEach((g, i) => {
      if (this.disabled.has(g.guid)) return;
      const rig = this.rigs[i];
      this.output(
        g,
        values,
        rig.current.map((v, k) => rig.previous[k] + (v - rig.previous[k]) * alpha),
        false,
      );
    });
    return values;
  }
}
