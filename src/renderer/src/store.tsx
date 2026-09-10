import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PsdImportDialog } from './files/PsdImportDialog';
import type { EditorCommand, EditorState } from '../../shared/types';
import { translate, type MessageKey } from './i18n';

interface Context {
  state: EditorState;
  command: (command: EditorCommand) => void;
  perform: (action: () => Promise<unknown>) => void;
  open: (path?: string) => void;
  t: (key: MessageKey) => string;
  error: string | null;
  dismissError: () => void;
}
const EditorContext = createContext<Context | null>(null);
export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [psdPath, setPsdPath] = useState<string | null>(null);
  const opening = useRef(false);
  useEffect(() => {
    const accept = (next: EditorState) =>
      setState((current) => {
        if (!current) return next;
        if (next.revision <= current.revision) return current;
        // IPC clones lose identity. Preserve unchanged documents so panel tree
        // indexes and parameter bindings remain cached during view/pose updates.
        if (next.documentRevision === current.documentRevision) {
          next.document = current.document;
          next.project = current.project;
        }
        if (
          next.preview?.id === current.preview?.id &&
          next.preview?.revision === current.preview?.revision
        )
          next.preview = current.preview;
        return next;
      });
    const unsubscribe = window.lattice.onState(accept);
    window.lattice
      .state()
      .then(accept)
      .catch((error) => setError(String(error)));
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (state) document.documentElement.lang = state.locale;
  }, [state?.locale]);
  const perform = useCallback((action: () => Promise<unknown>) => {
    void action().catch((error) =>
      setError(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : String(error),
      ),
    );
  }, []);
  const command = useCallback(
    (command: EditorCommand) => perform(() => window.lattice.command(command)),
    [perform],
  );
  const open = useCallback(
    (path?: string) => {
      if (opening.current || psdPath) return;
      opening.current = true;
      perform(async () => {
        try {
          const selected = path || (await window.lattice.chooseFile());
          if (!selected) return;
          if (/\.psd$/i.test(selected)) setPsdPath(selected);
          else await window.lattice.openDocument(selected);
        } finally {
          opening.current = false;
        }
      });
    },
    [perform, psdPath],
  );
  const t = useCallback(
    (key: MessageKey) => translate(state?.locale || 'zh-CN', key),
    [state?.locale],
  );
  if (!state) return <div className="boot">{error || 'Lattice'}</div>;
  return (
    <EditorContext.Provider
      value={{
        state,
        perform,
        open,
        command,
        t,
        error,
        dismissError: () => setError(null),
      }}
    >
      {children}
      {psdPath && <PsdImportDialog path={psdPath} close={() => setPsdPath(null)} />}
    </EditorContext.Provider>
  );
}
export function useEditor() {
  const value = useContext(EditorContext);
  if (!value) throw new Error('Editor context missing');
  return value;
}
