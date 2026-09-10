import { z } from 'zod';

const id = z.string().min(1).max(512);
const guid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Use a native UUID.');
const number = z.number().finite();
export const physicsTypeSchema = z.enum(['X', 'Y', 'Angle']);
export const physicsRangeSchema = z
  .object({
    min: number.min(-10000).max(10000),
    default: number.min(-10000).max(10000),
    max: number.min(-10000).max(10000),
  })
  .refine(
    (v) => v.min < v.max && v.default >= v.min && v.default <= v.max,
    'Normalization must satisfy minimum ≤ center ≤ maximum, with a nonzero range.',
  );
export const physicsInputSchema = z.object({
  guid,
  parameterId: id,
  type: physicsTypeSchema,
  weight: number.min(0).max(100),
  reflect: z.boolean(),
});
export const physicsOutputSchema = physicsInputSchema.extend({
  vertexIndex: z.number().int().min(1).max(99),
  scale: number.min(-100000).max(100000),
});
export const physicsParticleSchema = z.object({
  guid,
  position: z.object({ x: number, y: number }),
  radius: number.min(0).max(10000),
  mobility: number.min(0).max(1),
  delay: number.min(0).max(10),
  acceleration: number.min(0).max(100),
});
export const physicsGroupSchema = z
  .object({
    guid,
    id,
    name: z.string().max(256),
    inputs: z.array(physicsInputSchema).max(256),
    outputs: z.array(physicsOutputSchema).max(256),
    particles: z.array(physicsParticleSchema).max(100),
    normalization: z.object({ position: physicsRangeSchema, angle: physicsRangeSchema }),
  })
  .superRefine((v, ctx) => {
    if (
      (v.particles.length > 0 && v.particles[0].radius !== 0) ||
      v.particles.slice(1).some((p) => p.radius <= 0)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'The root radius must be zero; pendulum durations must be positive.',
      });
    if (v.outputs.some((o) => o.vertexIndex >= v.particles.length))
      ctx.addIssue({ code: 'custom', message: 'An output refers to a missing pendulum.' });
    const ids = [...v.inputs, ...v.outputs, ...v.particles].map((p) => p.guid);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Physics data GUIDs must be unique.' });
  });
export const physicsSettingsSchema = z
  .object({
    fps: z.number().int().min(1).max(240),
    groups: z.array(physicsGroupSchema).max(256),
  })
  .superRefine((v, ctx) => {
    const guids = v.groups.flatMap((g) => [
      g.guid,
      ...[...g.inputs, ...g.outputs, ...g.particles].map((p) => p.guid),
    ]);
    if (new Set(guids).size !== guids.length)
      ctx.addIssue({ code: 'custom', message: 'Physics GUIDs must be unique across all groups.' });
    for (const key of ['guid', 'id'] as const)
      if (new Set(v.groups.map((g) => g[key])).size !== v.groups.length)
        ctx.addIssue({ code: 'custom', message: `Physics group ${key}s must be unique.` });
  });
export type PhysicsType = z.infer<typeof physicsTypeSchema>;
export type PhysicsInput = z.infer<typeof physicsInputSchema>;
export type PhysicsOutput = z.infer<typeof physicsOutputSchema>;
export type PhysicsParticle = z.infer<typeof physicsParticleSchema>;
export type PhysicsGroup = z.infer<typeof physicsGroupSchema>;
export type PhysicsSettings = z.infer<typeof physicsSettingsSchema>;
export type PhysicsRange = z.infer<typeof physicsRangeSchema>;

// Group updates are complete, atomic replacements. The same transaction is used by UI and MCP.
export const physicsEditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('setFps'), fps: physicsSettingsSchema.shape.fps }),
  z.object({ action: z.literal('putGroup'), group: physicsGroupSchema }),
  z.object({ action: z.literal('deleteGroup'), guid: id }),
  z.object({ action: z.literal('reorderGroups'), guids: z.array(id).max(256) }),
  z.object({ action: z.literal('replace'), settings: physicsSettingsSchema }),
]);
export type PhysicsEdit = z.infer<typeof physicsEditSchema>;

export const physicsSimulationSchema = z
  .object({
    frames: z
      .array(
        z.object({
          duration: number.positive().max(30),
          parameters: z.record(id, number),
        }),
      )
      .min(1)
      .max(100),
    sampleFps: z.number().int().min(1).max(60).default(15),
    disabledGroups: z.array(id).default([]),
  })
  .refine(
    (v) => v.frames.reduce((sum, f) => sum + f.duration, 0) <= 120,
    'A simulation may contain at most 120 seconds.',
  );

export function applyPhysicsEdits(
  settings: PhysicsSettings,
  edits: PhysicsEdit[],
): PhysicsSettings {
  let next = structuredClone(settings);
  for (const edit of edits) {
    if (edit.action === 'setFps') next.fps = edit.fps;
    else if (edit.action === 'replace') next = structuredClone(edit.settings);
    else if (edit.action === 'putGroup') {
      const index = next.groups.findIndex((g) => g.guid === edit.group.guid);
      if (index < 0) next.groups.push(structuredClone(edit.group));
      else next.groups[index] = structuredClone(edit.group);
    } else if (edit.action === 'deleteGroup') {
      if (!next.groups.some((g) => g.guid === edit.guid))
        throw new Error('Physics group not found.');
      next.groups = next.groups.filter((g) => g.guid !== edit.guid);
    } else {
      if (
        edit.guids.length !== next.groups.length ||
        new Set(edit.guids).size !== next.groups.length ||
        edit.guids.some((guid) => !next.groups.some((g) => g.guid === guid))
      )
        throw new Error('Supply every physics group GUID exactly once.');
      next.groups = edit.guids.map((guid) => next.groups.find((g) => g.guid === guid)!);
    }
  }
  return physicsSettingsSchema.parse(next);
}

export function duplicatePhysicsGroup(
  group: PhysicsGroup,
  groups: PhysicsGroup[],
  uuid = () => crypto.randomUUID(),
): PhysicsGroup {
  let index = 1;
  while (groups.some((g) => g.id === `PhysicsSetting${index}`)) index++;
  return {
    ...structuredClone(group),
    guid: uuid(),
    id: `PhysicsSetting${index}`,
    inputs: group.inputs.map((p) => ({ ...p, guid: uuid() })),
    outputs: group.outputs.map((p) => ({ ...p, guid: uuid() })),
    particles: group.particles.map((p) => ({ ...p, position: { ...p.position }, guid: uuid() })),
  };
}
