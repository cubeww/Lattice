import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import type { PsdImportOptions } from '../../../shared/psd';

export function PsdImportDialog({ path, close }: { path: string; close: () => void }) {
  const { state, t } = useEditor();
  const [initial] = useState(() => ({
    documentRevision: state.documentRevision,
    previewId: state.preview?.id,
  }));
  const [mode, setMode] = useState<PsdImportOptions['mode']>('newModel');
  const sources = [...(state.project?.resources || [])]
    .filter((r) => r.kind === 'sourceImage')
    .reverse();
  const [sourceKey, setSourceKey] = useState(
    () => sources.find((r) => !r.replaced)?.key || sources[0]?.key || '',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const changed =
    initial.documentRevision !== state.documentRevision || initial.previewId !== state.preview?.id;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    form.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="modal-backdrop">
      <form
        ref={form}
        className="modeling-dialog psd-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('psdImport')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            event.preventDefault();
            if (!busy) close();
          }
          if (event.key === 'Tab') {
            const controls = [
              ...form.current!.querySelectorAll<HTMLElement>(
                'input:checked:not(:disabled),select:not(:disabled),button:not(:disabled)',
              ),
            ];
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || changed) return;
          setBusy(true);
          setError('');
          try {
            await window.lattice.openDocument(
              path,
              mode === 'replaceSource' ? { mode, sourceKey } : { mode },
              state.revision,
            );
            close();
          } catch (error) {
            setError(
              (error as Error).message.replace(
                /^Error invoking remote method '[^']+': Error: /,
                '',
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{t('psdImport')}</h2>
        <p className="psd-import-file" title={path}>
          {path.split(/[\\/]/).pop()}
        </p>
        {state.document && (
          <p className="psd-import-target">
            {t('psdCurrentModel')}：{state.document.name}
          </p>
        )}
        <fieldset disabled={busy || changed}>
          {(
            [
              ['newModel', 'psdNew', 'psdNewHint', false],
              ['addGroup', 'psdAdd', 'psdAddHint', !state.document || !state.previewReady],
              [
                'replaceSource',
                'psdReplace',
                'psdReplaceHint',
                !state.document || !state.previewReady || !sources.length,
              ],
            ] as const
          ).map(([value, label, hint, disabled]) => (
            <label key={value} className={`psd-import-option ${mode === value ? 'selected' : ''}`}>
              <input
                type="radio"
                name="psd-import-mode"
                value={value}
                checked={mode === value}
                disabled={disabled}
                onChange={() => setMode(value)}
              />
              <span>
                <strong>{t(label)}</strong>
                <small>{t(hint)}</small>
              </span>
            </label>
          ))}
          {mode === 'replaceSource' && (
            <label className="psd-source-choice">
              {t('psdTarget')}
              <select value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
                {sources.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                    {r.replaced ? ` (${t('psdPrevious')})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {(error || changed) && (
          <p role="alert" className="psd-import-error">
            {changed ? t('psdProjectChanged') : error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            {t('cancel')}
          </button>
          <button
            className="primary"
            disabled={busy || changed || (mode === 'replaceSource' && !sourceKey)}
          >
            {t(busy ? 'psdImporting' : 'psdImportApply')}
          </button>
        </footer>
      </form>
    </div>
  );
}
