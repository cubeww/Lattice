import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  physicsSettingsSchema,
  physicsTypeSchema,
  type PhysicsSettings,
} from '../../shared/physics';

const n = z.number().finite();
const vector = z.object({ X: n, Y: n });
const reference = z.object({ Target: z.literal('Parameter'), Id: z.string().min(1).max(512) });
const range = z.object({ Minimum: n, Maximum: n, Default: n });
const format = z.object({
  Version: z.literal(3),
  Meta: z.object({
    Fps: z.number().int().min(1).max(240).optional(),
    EffectiveForces: z.object({ Gravity: vector, Wind: vector }),
    PhysicsDictionary: z.array(z.object({ Id: z.string(), Name: z.string() })).default([]),
  }),
  PhysicsSettings: z
    .array(
      z.object({
        Id: z.string().min(1),
        Input: z.array(
          z.object({ Source: reference, Weight: n, Type: physicsTypeSchema, Reflect: z.boolean() }),
        ),
        Output: z.array(
          z.object({
            Destination: reference,
            VertexIndex: z.number().int(),
            Scale: n,
            Weight: n,
            Type: physicsTypeSchema,
            Reflect: z.boolean(),
          }),
        ),
        Vertices: z.array(
          z.object({ Position: vector, Mobility: n, Delay: n, Acceleration: n, Radius: n }),
        ),
        Normalization: z.object({ Position: range, Angle: range }),
      }),
    )
    .max(256),
});

export function exportPhysics3(settings: PhysicsSettings) {
  physicsSettingsSchema.parse(settings);
  return {
    Version: 3,
    Meta: {
      PhysicsSettingCount: settings.groups.length,
      TotalInputCount: settings.groups.reduce((s, g) => s + g.inputs.length, 0),
      TotalOutputCount: settings.groups.reduce((s, g) => s + g.outputs.length, 0),
      VertexCount: settings.groups.reduce((s, g) => s + g.particles.length, 0),
      Fps: settings.fps,
      EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } },
      PhysicsDictionary: settings.groups.map((g) => ({ Id: g.id, Name: g.name })),
    },
    PhysicsSettings: settings.groups.map((g) => ({
      Id: g.id,
      Input: g.inputs.map((p) => ({
        Source: { Target: 'Parameter', Id: p.parameterId },
        Weight: p.weight,
        Type: p.type,
        Reflect: p.reflect,
      })),
      Output: g.outputs.map((p) => ({
        Destination: { Target: 'Parameter', Id: p.parameterId },
        VertexIndex: p.vertexIndex,
        Scale: p.scale,
        Weight: p.weight,
        Type: p.type,
        Reflect: p.reflect,
      })),
      Vertices: g.particles.map((p) => ({
        Position: { X: p.position.x, Y: p.position.y },
        Mobility: p.mobility,
        Delay: p.delay,
        Acceleration: p.acceleration,
        Radius: p.radius,
      })),
      Normalization: Object.fromEntries(
        (['Position', 'Angle'] as const).map((key) => {
          const r = g.normalization[key === 'Position' ? 'position' : 'angle'];
          return [key, { Minimum: r.min, Maximum: r.max, Default: r.default }];
        }),
      ),
    })),
  };
}

export function importPhysics3(json: unknown): PhysicsSettings {
  const data = format.parse(json),
    forces = data.Meta.EffectiveForces;
  if (
    forces.Gravity.X !== 0 ||
    forces.Gravity.Y !== -1 ||
    forces.Wind.X !== 0 ||
    forces.Wind.Y !== 0
  )
    throw new Error(
      'CMO3 physics uses default gravity and wind. This file contains custom runtime forces.',
    );
  const names = new Map(data.Meta.PhysicsDictionary.map((p) => [p.Id, p.Name]));
  return physicsSettingsSchema.parse({
    fps: data.Meta.Fps ?? 60,
    groups: data.PhysicsSettings.map((g) => ({
      guid: randomUUID(),
      id: g.Id,
      name: names.get(g.Id) || g.Id,
      inputs: g.Input.map((p) => ({
        guid: randomUUID(),
        parameterId: p.Source.Id,
        type: p.Type,
        weight: p.Weight,
        reflect: p.Reflect,
      })),
      outputs: g.Output.map((p) => ({
        guid: randomUUID(),
        parameterId: p.Destination.Id,
        type: p.Type,
        weight: p.Weight,
        reflect: p.Reflect,
        vertexIndex: p.VertexIndex,
        scale: p.Scale,
      })),
      particles: g.Vertices.map((p) => ({
        guid: randomUUID(),
        position: { x: p.Position.X, y: p.Position.Y },
        radius: p.Radius,
        mobility: p.Mobility,
        delay: p.Delay,
        acceleration: p.Acceleration,
      })),
      normalization: Object.fromEntries(
        (['Position', 'Angle'] as const).map((key) => {
          const r = g.Normalization[key];
          return [key.toLowerCase(), { min: r.Minimum, max: r.Maximum, default: r.Default }];
        }),
      ),
    })),
  });
}
