import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from 'electron';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { Editor } from '../core/editor';
import { atomicWrite, exists } from '../core/files';
import { startBridge } from './bridge';
import { PreviewCoordinator } from './preview';
import { psdImportOptionsSchema } from '../shared/psd';

app.setName('Lattice');
if (process.env.LATTICE_USER_DATA) app.setPath('userData', resolve(process.env.LATTICE_USER_DATA));
protocol.registerSchemesAsPrivileged([
  { scheme: 'lattice', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'lattice-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const here = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let editor: Editor;
let closing = false;
let closePrompt = false;
let fileActionPending = false;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => {
    window?.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('Lattice', String(error));
      app.quit();
    });
}

async function start() {
  const userData = app.getPath('userData');
  await mkdir(userData, { recursive: true });
  const settingsPath = join(userData, 'settings.json');
  const connectionPath = join(userData, 'bridge.json');
  const schema = z.object({
    locale: z.enum(['en', 'zh-CN', 'ja']).optional(),
    recentFiles: z.array(z.string()).max(8).optional(),
  });
  let settings: z.infer<typeof schema> = {};
  try {
    settings = schema.parse(JSON.parse(await readFile(settingsPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('Could not load editor preferences:', error);
  }
  const sampleDirectory = resolve(app.getAppPath(), 'references/Models/simple_ja');
  const sampleAvailable = await exists(join(sampleDirectory, 'simple_t01.cmo3'));
  editor = new Editor({ ...settings, sampleAvailable });
  const rendererPath = resolve(here, '../renderer');
  protocol.handle('lattice', (request) => {
    const url = new URL(request.url);
    const file = resolve(rendererPath, `.${decodeURIComponent(url.pathname)}`);
    const rel = relative(rendererPath, file);
    if (url.hostname !== 'app' || rel.startsWith('..') || isAbsolute(rel))
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  protocol.handle('lattice-asset', (request) => {
    const url = new URL(request.url);
    const asset = url.hostname === 'source' ? editor.assets?.read(url.pathname.slice(1)) : null;
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(asset.bytes), {
      headers: {
        'Content-Type': asset.mime,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  });
  function createWindow() {
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1000,
      minHeight: 650,
      show: false,
      title: 'Lattice',
      backgroundColor: '#f4f5f7',
      webPreferences: {
        preload: join(here, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.once('ready-to-show', () => window?.show());
    window.on('close', (event) => {
      if (!closing && editor.snapshot().dirty) {
        event.preventDefault();
        if (!closePrompt) {
          closePrompt = true;
          void fileAction(mayReplace)
            .then((ok) => {
              if (ok !== false) {
                closing = true;
                window?.close();
              }
            })
            .catch((error) => dialog.showErrorBox('Lattice', String(error)))
            .finally(() => {
              closePrompt = false;
            });
        }
      }
    });
    window.on('closed', () => {
      window = null;
      closing = false;
    });
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadURL('lattice://app/index.html');
  }
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          {
            label: 'Lattice',
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
          },
          { role: 'editMenu' },
        ])
      : null,
  );
  createWindow();

  let savePreferences: Promise<unknown> = Promise.resolve();
  let lastPreferences = '';
  editor.on('change', (state) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('lattice:state', state);
      const title = `${state.dirty ? '• ' : ''}${state.document ? `${state.document.name} — ` : ''}Lattice`;
      if (window.getTitle() !== title) window.setTitle(title);
    }
    const json = JSON.stringify({ locale: state.locale, recentFiles: state.recentFiles });
    if (json !== lastPreferences) {
      lastPreferences = json;
      savePreferences = savePreferences
        .then(() => atomicWrite(settingsPath, json))
        .catch((error) => console.error('Preference save failed:', error));
    }
  });
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Invalid IPC sender.');
      return fn(...args);
    });
  };
  handle('lattice:get-state', () => editor.snapshot());
  handle('lattice:form-clipboard', () => editor.formClipboard());
  handle('lattice:physics-file-dialog', (rawAction, rawMode) =>
    fileAction(async () => {
      const action = z.enum(['import', 'export']).parse(rawAction);
      const mode = z.enum(['replace', 'append']).default('replace').parse(rawMode);
      const state = editor.snapshot();
      if (!state.document) throw new Error('Open a model first.');
      if (action === 'import') {
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openFile'],
          filters: [{ name: 'Physics (.physics3.json)', extensions: ['json'] }],
        });
        if (!result.canceled && result.filePaths[0])
          await editor.dispatch({
            type: 'importPhysics',
            path: result.filePaths[0],
            mode,
            expectedRevision: state.revision,
          });
      } else {
        const name =
          state.document.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 150) || 'model';
        const result = await dialog.showSaveDialog(window!, {
          defaultPath: join(
            state.document.path ? dirname(state.document.path) : app.getPath('documents'),
            `${name}.physics3.json`,
          ),
          filters: [{ name: 'Physics', extensions: ['physics3.json'] }],
        });
        if (!result.canceled && result.filePath)
          await editor.dispatch({
            type: 'exportPhysics',
            path: result.filePath,
            expectedRevision: state.revision,
          });
      }
    }),
  );
  handle('lattice:command', (command) => editor.dispatch(command));
  handle('lattice:new-document', () =>
    fileAction(async () => {
      const consent = await mayReplace();
      if (consent !== false) await editor.dispatch({ type: 'new' }, consent);
    }),
  );
  handle('lattice:save-document', () => fileAction(() => saveDocument()));
  handle('lattice:choose-file', () =>
    fileAction(async () => {
      const result = await dialog.showOpenDialog(window!, {
        properties: ['openFile'],
        filters: [
          { name: 'Cubism / Photoshop', extensions: ['cmo3', 'psd'] },
          { name: 'Cubism project', extensions: ['cmo3'] },
          { name: 'Photoshop document', extensions: ['psd'] },
        ],
      });
      return result.canceled ? null : result.filePaths[0] || null;
    }),
  );
  handle('lattice:open-document', (rawPath, rawPsd, rawRevision) =>
    fileAction(async () => {
      const path = z.string().min(1).max(32768).parse(rawPath);
      const psd = psdImportOptionsSchema.optional().parse(rawPsd);
      const expectedRevision = z.number().int().nonnegative().optional().parse(rawRevision);
      if (expectedRevision !== undefined && expectedRevision !== editor.snapshot().revision)
        throw new Error('The project changed. Open the PSD import dialog again.');
      if (psd && psd.mode !== 'newModel') {
        await editor.dispatch({ type: 'open', path, psd, expectedRevision });
      } else {
        const consent = await mayReplace();
        if (consent !== false) await editor.dispatch({ type: 'open', path, psd }, consent);
      }
    }),
  );
  handle('lattice:save-dialog', () => fileAction(() => saveDocument(true)));
  handle('lattice:close-document', () =>
    fileAction(async () => {
      const consent = await mayReplace();
      if (consent !== false) await editor.dispatch({ type: 'close' }, consent);
    }),
  );
  handle('lattice:export-image-dialog', async (rawKey) => {
    const key = z.string().max(512).parse(rawKey),
      state = editor.snapshot();
    const resource = state.project?.resources.find((r) => r.key === key);
    if (!resource?.image || !state.document) throw new Error('Choose an image to export.');
    const filename =
      resource.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 150) || 'image';
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: join(
        state.document.path ? dirname(state.document.path) : app.getPath('documents'),
        `${filename}.png`,
      ),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (!result.canceled && result.filePath)
      await editor.dispatch({
        type: 'exportProjectImage',
        key,
        path: result.filePath,
        expectedRevision: state.revision,
      });
  });
  handle('lattice:open-sample', () =>
    fileAction(async () => {
      const base = sampleDirectory;
      if (!(await exists(join(base, 'simple_t01.cmo3'))))
        throw new Error(
          'The reference sample is available in the development checkout. Use Open Project for your own model.',
        );
      const consent = await mayReplace();
      if (consent !== false)
        await editor.dispatch({ type: 'open', path: join(base, 'simple_t01.cmo3') }, consent);
    }),
  );
  handle('lattice:preview-ready', (id, error) =>
    editor.previewReady(
      z.string().uuid().parse(id),
      error === null ? null : z.string().max(3000).parse(error),
    ),
  );
  const preview = new PreviewCoordinator(editor, () => window);
  handle('lattice:preview-result', (reply) => preview.reply(reply));
  const bridge = await startBridge(editor, connectionPath, preview);
  app.on('before-quit', () => {
    if (!editor.snapshot().dirty) closing = true;
  });
  app.on('will-quit', () => {
    bridge.close();
    void rm(connectionPath, { force: true });
  });
  app.on('activate', () => {
    if (!window) createWindow();
  });
}

async function fileAction<T>(action: () => Promise<T>): Promise<T | false> {
  if (fileActionPending) return false;
  fileActionPending = true;
  try {
    return await action();
  } finally {
    fileActionPending = false;
  }
}

async function saveDocument(saveAs = false): Promise<boolean> {
  const state = editor.snapshot(),
    document = state.document;
  if (!document) return false;
  let path = document.path;
  if (saveAs || !path) {
    const filename =
      document.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 150) || 'Model';
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: path || join(app.getPath('documents'), `${filename}.cmo3`),
      filters: [{ name: 'Cubism project', extensions: ['cmo3'] }],
    });
    if (result.canceled || !result.filePath) return false;
    path = result.filePath;
  }
  await editor.dispatch({ type: 'save', path }, state.revision);
  return true;
}

async function mayReplace(): Promise<number | false | undefined> {
  const state = editor.snapshot();
  if (!state.dirty) return undefined;
  const text = {
    'zh-CN': ['保存项目更改？', '保存', '不保存', '取消'],
    en: ['Save changes to the project?', 'Save', 'Discard', 'Cancel'],
    ja: ['プロジェクトの変更を保存しますか？', '保存', '保存しない', 'キャンセル'],
  }[state.locale];
  const result = await dialog.showMessageBox(window!, {
    type: 'question',
    message: text[0],
    buttons: text.slice(1),
    defaultId: 0,
    cancelId: 2,
  });
  if (result.response === 2) return false;
  if (editor.snapshot().revision !== state.revision)
    throw new Error('The project changed while the file dialog was open. Try again.');
  if (result.response === 0) return (await saveDocument()) ? undefined : false;
  // Consent is scoped to this revision; replacement stays atomic if loading fails.
  return state.revision;
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
