import { z } from 'zod';
import type { EditorState } from './types';

const guid = z.string().min(1).max(512);
const coordinate = z.number().finite().min(-1e7).max(1e7);
export const poseSchema = z.record(z.string().min(1).max(256), coordinate);
export const boundsSchema = z.object({
  x: coordinate,
  y: coordinate,
  width: z.number().positive().max(1e7),
  height: z.number().positive().max(1e7),
});
export const keyformBatchSchema = z
  .array(
    z
      .object({
        parameters: poseSchema,
        edits: z
          .array(
            z
              .object({
                guid,
                space: z.enum(['canvas', 'local']).default('canvas'),
                points: z
                  .array(
                    z.object({
                      index: z.number().int().nonnegative(),
                      x: coordinate,
                      y: coordinate,
                    }),
                  )
                  .min(1)
                  .max(100000)
                  .optional(),
                rotation: z
                  .object({
                    x: coordinate.optional(),
                    y: coordinate.optional(),
                    angle: coordinate.optional(),
                    scale: z.number().min(0.0001).max(1000).optional(),
                  })
                  .strict()
                  .optional(),
                appearance: z
                  .object({
                    opacity: z.number().min(0).max(1).optional(),
                    drawOrder: z.number().int().min(0).max(1000).optional(),
                    multiply: z
                      .string()
                      .regex(/^#[0-9a-fA-F]{6}$/)
                      .optional(),
                    screen: z
                      .string()
                      .regex(/^#[0-9a-fA-F]{6}$/)
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .refine(
                (e) =>
                  !!e.points?.length ||
                  !!Object.keys(e.rotation || {}).length ||
                  !!Object.keys(e.appearance || {}).length,
                'Supply geometry, rotation or appearance.',
              ),
          )
          .min(1)
          .max(1000),
      })
      .strict(),
  )
  .min(1)
  .max(256)
  .refine(
    (frames) =>
      frames.reduce((n, f) => n + f.edits.reduce((s, e) => s + (e.points?.length || 0), 0), 0) <=
      200000,
    'Split batches larger than 200,000 vertices.',
  );
export type KeyformBatch = z.infer<typeof keyformBatchSchema>;

export const geometryQuerySchema = z.object({
  guids: z.array(guid).min(1).max(1000).optional(),
  parameters: poseSchema.optional(),
  fields: z
    .array(z.enum(['positions', 'topology', 'forms', 'controllers', 'appearance']))
    .default(['positions', 'topology', 'forms', 'controllers', 'appearance']),
});
export type GeometryQuery = z.input<typeof geometryQuerySchema>;
export const sceneQuerySchema = z.object({
  guids: z.array(guid).min(1).max(1000).optional(),
  include: z
    .array(z.enum(['objects', 'parameters', 'project', 'view', 'log']))
    .default(['objects', 'parameters', 'view']),
});
export const validationQuerySchema = z.object({
  poses: z.array(poseSchema).max(64).default([]),
  requireAtlas: z.boolean().default(false),
});
export const renderModelSchema = z
  .object({
    guids: z.array(guid).min(1).max(1000).optional(),
    bounds: boundsSchema.optional(),
    width: z.number().int().min(64).max(2048).default(800),
    height: z.number().int().min(64).max(2048).default(800),
    padding: z.number().min(0).max(0.4).default(0.08),
    background: z.enum(['transparent', 'checker', 'white', 'dark']).default('checker'),
    poses: z
      .array(z.object({ label: z.string().max(128).optional(), parameters: poseSchema }))
      .min(1)
      .max(16)
      .optional(),
  })
  .refine((o) => !(o.guids && o.bounds), 'Choose object framing or explicit bounds.')
  .refine(
    (o) => o.width * o.height * (o.poses?.length || 1) <= 16777216,
    'Limit the total render size to 16 megapixels.',
  );
export type RenderModelOptions = z.infer<typeof renderModelSchema>;
export interface RenderStamp {
  revision: number;
  previewId: string;
  sceneRevision: number;
}
export interface RenderedModel {
  data: string;
  width: number;
  height: number;
  bounds: z.infer<typeof boundsSchema>;
  parameters: Record<string, number>;
  label?: string;
}
export interface PreviewRequest {
  id: string;
  revision: number;
  options?: RenderModelOptions;
}
export interface PreviewResult {
  stamp: RenderStamp;
  images?: RenderedModel[];
}
export const waitForIdleSchema = z.object({
  afterRevision: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().min(100).max(45000).default(30000),
});
export type WaitForIdleOptions = z.input<typeof waitForIdleSchema>;
export type PreviewReply = { id: string } & (
  { result: PreviewResult } | { error: ReturnType<typeof operationError> }
);

export function assertRevision(expectedRevision: number, actualRevision: number) {
  if (expectedRevision !== actualRevision)
    throw new OperationError(
      'REVISION_CONFLICT',
      'The scene changed. Read the current state before retrying the edit.',
      { expectedRevision, actualRevision },
    );
}

export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OperationError';
  }
}
export function operationError(error: unknown) {
  if (error instanceof OperationError)
    return { code: error.code, message: error.message, details: error.details };
  if (error instanceof z.ZodError)
    return {
      code: 'INVALID_ARGUMENT',
      message: 'Invalid tool arguments.',
      details: { issues: error.issues },
    };
  return {
    code: 'OPERATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}
export function resolvePose(
  parameters: { id: string; min: number; max: number; default: number }[],
  values: Record<string, number>,
) {
  const result = Object.fromEntries(parameters.map((p) => [p.id, p.default]));
  for (const [id, value] of Object.entries(values)) {
    const p = parameters.find((p) => p.id === id);
    if (!p || !Number.isFinite(value) || value < p.min || value > p.max)
      throw new OperationError('INVALID_PARAMETER', `Invalid value for parameter ${id}.`, {
        parameterId: id,
        value,
        range: p ? [p.min, p.max] : null,
      });
    result[id] = value;
  }
  return result;
}
export function editorStatus(state: EditorState) {
  return {
    revision: state.revision,
    documentRevision: state.documentRevision,
    document: state.document
      ? {
          path: state.document.path,
          name: state.document.name,
          canvas: state.document.canvas,
          objectCount: state.document.objects.length,
          parameterCount: state.document.parameters.length,
        }
      : null,
    previewId: state.preview?.id || null,
    sceneRevision: state.preview?.revision ?? null,
    previewReady: state.previewReady,
    previewError: state.previewError,
    dirty: state.dirty,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    selectedGuid: state.selectedGuid,
    selectedGuids: state.selectedGuids,
    parameterValues: state.parameterValues,
  };
}
