import { contextBridge, ipcRenderer } from 'electron';
import type { LatticeApi, EditorState } from '../shared/types';
import type { PreviewRequest } from '../shared/workflow';

const api: LatticeApi = {
  physicsFileDialog: (action, mode) =>
    ipcRenderer.invoke('lattice:physics-file-dialog', action, mode),
  state: () => ipcRenderer.invoke('lattice:get-state'),
  formClipboard: () => ipcRenderer.invoke('lattice:form-clipboard'),
  command: (command) => ipcRenderer.invoke('lattice:command', command),
  newDocument: () => ipcRenderer.invoke('lattice:new-document'),
  saveDocument: () => ipcRenderer.invoke('lattice:save-document'),
  chooseFile: () => ipcRenderer.invoke('lattice:choose-file'),
  openDocument: (path, psd, expectedRevision) =>
    ipcRenderer.invoke('lattice:open-document', path, psd, expectedRevision),
  saveDialog: () => ipcRenderer.invoke('lattice:save-dialog'),
  exportImageDialog: (key) => ipcRenderer.invoke('lattice:export-image-dialog', key),
  closeDocument: () => ipcRenderer.invoke('lattice:close-document'),
  openSample: () => ipcRenderer.invoke('lattice:open-sample'),
  previewReady: (id, error) => ipcRenderer.invoke('lattice:preview-ready', id, error),
  onPreviewRequest: (listener) => {
    const handler = async (_event: Electron.IpcRendererEvent, request: PreviewRequest) => {
      let reply;
      try {
        reply = await listener(request);
      } catch (error) {
        const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
        reply = {
          id: request.id,
          error: {
            code: e.code || 'PREVIEW_FAILED',
            message: e.message || String(error),
            details: e.details || {},
          },
        };
      }
      await ipcRenderer.invoke('lattice:preview-result', reply);
    };
    ipcRenderer.on('lattice:preview-request', handler);
    return () => ipcRenderer.removeListener('lattice:preview-request', handler);
  },
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: EditorState) => listener(state);
    ipcRenderer.on('lattice:state', handler);
    return () => {
      ipcRenderer.removeListener('lattice:state', handler);
    };
  },
};
contextBridge.exposeInMainWorld('lattice', api);
