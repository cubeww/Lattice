import { z } from 'zod';

export const psdImportOptionsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('newModel') }),
  z.object({ mode: z.literal('addGroup') }),
  z.object({ mode: z.literal('replaceSource'), sourceKey: z.string().min(1).max(512) }),
]);
export type PsdImportOptions = z.infer<typeof psdImportOptionsSchema>;
