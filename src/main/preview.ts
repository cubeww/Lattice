import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Editor } from '../core/editor';
import {
  assertRevision,
  OperationError,
  waitForIdleSchema,
  type WaitForIdleOptions,
  type PreviewResult,
  type RenderModelOptions,
} from '../shared/workflow';

const replySchema = z.object({
  id: z.string().uuid(),
  result: z
    .object({
      stamp: z.object({
        revision: z.number().int().nonnegative(),
        previewId: z.string().uuid(),
        sceneRevision: z.number().int().nonnegative(),
      }),
      images: z
        .array(
          z.object({
            data: z.string().max(24 * 1024 * 1024),
            width: z.number(),
            height: z.number(),
            bounds: z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }),
            parameters: z.record(z.string(), z.number()),
            label: z.string().optional(),
          }),
        )
        .max(16)
        .optional(),
    })
    .optional(),
  error: z
    .object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()) })
    .optional(),
});

/** Render acknowledgements never publish editor state or create another revision. */
export class PreviewCoordinator {
  private requests = new Map<
    string,
    {
      resolve: (result: PreviewResult) => void;
      reject: (error: Error) => void;
    }
  >();
  constructor(
    private editor: Editor,
    private window: () => BrowserWindow | null,
  ) {}

  reply(raw: unknown) {
    const reply = replySchema.parse(raw),
      pending = this.requests.get(reply.id);
    if (!pending) return; // A timed-out request can finish later.
    if (reply.error)
      pending.reject(
        new OperationError(reply.error.code, reply.error.message, reply.error.details),
      );
    else if (reply.result) pending.resolve(reply.result);
    else pending.reject(new OperationError('PREVIEW_FAILED', 'The renderer returned no frame.'));
  }

  private ready(afterRevision: number, deadline: number) {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.editor.off('change', check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const state = this.editor.status();
        if (state.previewError) finish(new OperationError('PREVIEW_FAILED', state.previewError));
        else if (state.revision >= afterRevision && (!state.document || state.previewReady))
          finish();
      };
      const timer = setTimeout(
        () =>
          finish(
            new OperationError(
              'PREVIEW_TIMEOUT',
              'The editor did not become ready before the timeout.',
              { afterRevision },
            ),
          ),
        Math.max(0, deadline - Date.now()),
      );
      this.editor.on('change', check);
      check();
    });
  }

  private frame(revision: number, deadline: number, options?: RenderModelOptions) {
    const window = this.window();
    if (!window || window.isDestroyed())
      throw new OperationError('PREVIEW_UNAVAILABLE', 'The editor window is closed.');
    return new Promise<PreviewResult>((resolve, reject) => {
      const id = randomUUID(),
        previewId = this.editor.status().previewId;
      const finish = (error?: Error, result?: PreviewResult) => {
        clearTimeout(timer);
        this.requests.delete(id);
        window.off('closed', closed);
        this.editor.off('change', changed);
        if (error) reject(error);
        else resolve(result!);
      };
      const closed = () =>
        finish(new OperationError('PREVIEW_UNAVAILABLE', 'The editor window was closed.'));
      const changed = () => {
        const state = this.editor.status();
        if (state.previewId !== previewId)
          finish(
            new OperationError(
              'PREVIEW_REPLACED',
              'The model changed while waiting for its frame.',
            ),
          );
        else if (state.previewError)
          finish(new OperationError('PREVIEW_FAILED', state.previewError));
      };
      const timer = setTimeout(
        () =>
          finish(
            new OperationError(
              'PREVIEW_TIMEOUT',
              'The viewport did not acknowledge the requested revision.',
              { revision },
            ),
          ),
        Math.max(0, deadline - Date.now()),
      );
      this.requests.set(id, {
        resolve: (result) => finish(undefined, result),
        reject: (error) => finish(error),
      });
      window.once('closed', closed);
      this.editor.on('change', changed);
      window.webContents.send('lattice:preview-request', { id, revision, options });
    });
  }

  private async settled(
    deadline: number,
    afterRevision = 0,
    options?: RenderModelOptions,
    expectedRevision?: number,
  ) {
    while (Date.now() < deadline) {
      await this.editor.idle();
      await this.ready(afterRevision, deadline);
      const before = this.editor.status();
      if (expectedRevision !== undefined) assertRevision(expectedRevision, before.revision);
      if (!before.document || !before.previewId) {
        if (options) throw new OperationError('NO_PROJECT', 'Open a model before rendering.');
        return { ...before, rendered: null, images: undefined };
      }
      const result = await this.frame(before.revision, deadline, options);
      await this.editor.idle();
      const after = this.editor.status();
      if (expectedRevision !== undefined) assertRevision(expectedRevision, after.revision);
      if (after.previewId !== before.previewId)
        throw new OperationError(
          'PREVIEW_REPLACED',
          'The model changed while waiting for its frame.',
        );
      if (
        result.stamp.revision === after.revision &&
        result.stamp.previewId === after.previewId &&
        result.stamp.sceneRevision === after.sceneRevision
      )
        return { ...after, rendered: result.stamp, images: result.images };
    }
    throw new OperationError(
      'PREVIEW_TIMEOUT',
      'The editor kept changing while waiting for a complete frame.',
    );
  }

  async wait(raw: WaitForIdleOptions = {}) {
    const options = waitForIdleSchema.parse(raw);
    const { images: _images, ...status } = await this.settled(
      Date.now() + options.timeoutMs,
      options.afterRevision,
    );
    return status;
  }
  async render(options: RenderModelOptions, expectedRevision?: number) {
    const result = await this.settled(Date.now() + 30000, 0, options, expectedRevision);
    return {
      revision: result.revision,
      documentRevision: result.documentRevision,
      rendered: result.rendered,
      images: result.images!,
    };
  }
  async screenshot() {
    const status = await this.wait();
    const window = this.window();
    if (!window || window.isDestroyed())
      throw new OperationError('PREVIEW_UNAVAILABLE', 'The editor window is closed.');
    const pixels = await window.webContents.capturePage();
    assertRevision(status.revision, this.editor.status().revision);
    return {
      revision: status.revision,
      rendered: status.rendered,
      data: pixels.toPNG().toString('base64'),
      mimeType: 'image/png',
    };
  }
}
