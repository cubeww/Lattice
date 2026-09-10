import { z } from 'zod';

const guid = z.string().min(1).max(512);
export const motionMirroringSchema = z
  .object({
    guids: z.array(guid).min(1).max(1000),
    parameterId: z.string().min(1).max(256),
    direction: z.enum(['horizontal', 'vertical']),
    axis: z.discriminatedUnion('type', [
      z.object({ type: z.literal('canvas') }).strict(),
      z.object({ type: z.literal('guide'), guid }).strict(),
      z.object({ type: z.literal('rotation'), guid }).strict(),
    ]),
  })
  .strict();
export type MotionMirroring = z.infer<typeof motionMirroringSchema>;

export interface ModelGuide {
  guid: string;
  number: number;
  direction: 'horizontal' | 'vertical';
  position: number;
}

export const motionMirroringErrors = {
  motionSelectParameter: 'Select one normal parameter and model objects.',
  motionLinkedParameter: 'Separate linked parameter controls before mirroring motion.',
  motionRepeatParameter: 'Motion Mirroring is unavailable for repeating parameters.',
  motionAtDefault: 'Move the parameter to a source key other than its default value.',
  motionOutsideRange:
    'The mirrored value is outside the parameter range. Adjust the parameter range first.',
  motionUnsupportedObject: 'Select ArtMeshes, warp deformers or rotation deformers.',
  motionLockedObject: 'Unlock the selected objects and their parents before mirroring motion.',
  motionMissingBinding: 'Every selected object must be bound to the selected parameter.',
  motionMissingSource:
    'Align all parameters with an existing source keyform on every selected object.',
  motionMissingDefault:
    'Add a keyform at the parameter default; keep the other parameters at their current keys.',
  motionMissingGuide: 'Select a guide perpendicular to the mirroring direction.',
  motionMissingRotation: 'Select an existing rotation deformer for the mirror axis.',
  motionMissingMesh: 'Complete the mesh triangulation before mirroring motion.',
  motionBlendShape: 'Motion Mirroring of objects with blend-shape targets is not supported yet.',
} as const;
export class MotionMirroringError extends Error {
  constructor(
    readonly code: keyof typeof motionMirroringErrors,
    readonly objectId?: string,
  ) {
    super(`${objectId ? objectId + ': ' : ''}${motionMirroringErrors[code]}`);
  }
}
