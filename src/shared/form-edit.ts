import { z } from 'zod';
import type { SourceForm } from './scene';

export const formKinds = ['mesh', 'artpath', 'rotation', 'warp', 'part'] as const;
export type FormKind = (typeof formKinds)[number];
export const pasteProperties = [
  'vertices',
  'opacity',
  'drawOrder',
  'multiply',
  'screen',
  'angle',
  'scale',
  'pathWidth',
  'pathColor',
  'pathOpacity',
  'pathCorner',
] as const;
export type PasteProperty = (typeof pasteProperties)[number];
export const propertiesForKind: Record<FormKind, PasteProperty[]> = {
  mesh: ['opacity', 'drawOrder', 'multiply', 'screen', 'vertices'],
  artpath: [
    'opacity',
    'drawOrder',
    'multiply',
    'screen',
    'vertices',
    'pathWidth',
    'pathColor',
    'pathOpacity',
    'pathCorner',
  ],
  rotation: ['opacity', 'multiply', 'screen', 'angle', 'vertices', 'scale'],
  warp: ['opacity', 'multiply', 'screen', 'vertices'],
  part: ['opacity', 'drawOrder'],
};
export const pasteOptionsSchema = z
  .object({
    properties: z.array(z.enum(pasteProperties)),
    mirror: z.enum(['none', 'horizontal', 'vertical']),
    center: z.union([z.literal('canvas'), z.number().finite().min(-1e7).max(1e7)]),
    reverseAngle: z.boolean(),
  })
  .strict();
export type PasteOptions = z.infer<typeof pasteOptionsSchema>;
export type PasteSettings = Record<FormKind, PasteOptions>;
export const defaultPasteSettings = (): PasteSettings =>
  Object.fromEntries(
    formKinds.map((kind) => [
      kind,
      {
        properties: [...propertiesForKind[kind]],
        mirror: 'none',
        center: 'canvas',
        reverseAngle: false,
      },
    ]),
  ) as PasteSettings;

export interface CopiedForm {
  guid: string;
  id: string;
  name: string;
  kind: FormKind;
  /** Geometry is in canvas coordinates; appearance belongs to the object itself. */
  form: SourceForm;
  weights: number[];
  columns?: number;
  rows?: number;
}
export interface FormClipboard {
  serial: number;
  items: CopiedForm[];
}
export const pasteTargetSchema = z
  .object({ sourceGuid: z.string().min(1), targetGuid: z.string().min(1) })
  .strict();
export type PasteTarget = z.infer<typeof pasteTargetSchema>;
export const formEditSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('paste'),
      clipboardSerial: z.number().int().nonnegative(),
      targets: z.array(pasteTargetSchema).min(1).max(1000),
      weight: z.number().finite().min(0).max(1),
      settings: z.record(z.enum(formKinds), pasteOptionsSchema).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('flip'),
      guids: z.array(z.string().min(1)).min(1).max(1000),
      horizontal: z.boolean(),
      vertical: z.boolean(),
      parameterIds: z.array(z.string()).max(100),
      flipRotationPosition: z.boolean(),
      keepCulling: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('scale'),
      guids: z.array(z.string().min(1)).min(1).max(1000),
      factor: z.number().finite().min(0.0001).max(100),
      currentOnly: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.enum(['reshapeWarp', 'expandWarp', 'revert', 'updateOriginal']),
      guids: z.array(z.string().min(1)).min(1).max(1000),
      editLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    })
    .strict(),
  z.object({ action: z.literal('deleteOriginals') }).strict(),
]);
export type FormEdit = z.infer<typeof formEditSchema>;
