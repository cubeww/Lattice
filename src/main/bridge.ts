import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicWrite } from '../core/files';
import type { Editor } from '../core/editor';
import type { PreviewCoordinator } from './preview';
import { z } from 'zod';
import {
  editorStatus,
  operationError,
  OperationError,
  renderModelSchema,
  validationQuerySchema,
  geometryQuerySchema,
  waitForIdleSchema,
} from '../shared/workflow';

export async function startBridge(
  editor: Editor,
  connectionPath: string,
  preview: PreviewCoordinator,
) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const auth = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (
      request.headers.origin ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    ) {
      response.writeHead(403).end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    try {
      let result: unknown;
      let body: unknown;
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024)
            throw new OperationError('INVALID_ARGUMENT', 'Request exceeds 16 MiB.');
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new OperationError('INVALID_ARGUMENT', 'Request body must be valid JSON.');
        }
      }
      // Read after prior queued edits; callers never observe a half-applied transaction.
      if (request.url !== '/command') await editor.idle();
      if (request.method === 'GET' && request.url === '/status') result = editor.status();
      else if (request.method === 'POST' && request.url === '/scene')
        result = editor.sceneInfo(body);
      else if (request.method === 'GET' && request.url === '/atlases') result = editor.atlasInfo();
      else if (request.method === 'GET' && request.url === '/physics')
        result = editor.physicsInfo();
      else if (request.method === 'POST' && request.url === '/physics/simulate')
        result = editor.simulatePhysics(body);
      else if (request.method === 'POST' && request.url === '/geometry')
        result = editor.queryGeometry(geometryQuerySchema.parse(body));
      else if (request.method === 'POST' && request.url === '/validate')
        result = editor.validate(validationQuerySchema.parse(body));
      else if (request.method === 'POST' && request.url === '/wait')
        result = await preview.wait(waitForIdleSchema.parse(body));
      else if (request.method === 'POST' && request.url === '/render') {
        const { expectedRevision, ...options } = renderModelSchema
          .safeExtend({ expectedRevision: z.number().int().nonnegative().optional() })
          .parse(body);
        result = await preview.render(options, expectedRevision);
      } else if (request.method === 'GET' && request.url === '/form-clipboard')
        result = editor.formClipboard();
      else if (request.method === 'GET' && request.url?.startsWith('/inspector?')) {
        const guids = new URL(request.url, 'http://127.0.0.1').searchParams.getAll('guid');
        if (!guids.length || guids.length > 1000) throw new Error('Supply object GUIDs.');
        result = editor.inspect(guids);
      } else if (request.method === 'GET' && request.url === '/screenshot')
        result = await preview.screenshot();
      else if (request.method === 'POST' && request.url === '/command') {
        const state = await editor.dispatch(body);
        result = editorStatus(state);
        if ((body as { type: string }).type === 'copyForms')
          result = { ...(result as object), formClipboard: state.formClipboard };
        if (['open', 'new'].includes((body as { type: string }).type)) {
          try {
            result = await preview.wait();
          } catch (error) {
            if (error instanceof OperationError) error.details.commandCommitted = true;
            throw error;
          }
        }
      } else {
        response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      response.end(JSON.stringify(result));
    } catch (error) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: operationError(error), revision: editor.status().revision }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Unable to start the editor bridge.');
  try {
    await atomicWrite(
      connectionPath,
      JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token }),
    );
  } catch (error) {
    server.close();
    throw error;
  }
  editor.setBridge(address.port);
  return server;
}
