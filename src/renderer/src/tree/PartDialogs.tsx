import { useEffect, useState } from 'react';
import type { CreatePart } from '../../../shared/parts';
import { partDescendants } from '../../../shared/parts';
import { TreeDialog } from './TreeMenu';
import { useEditor } from '../store';

type Dialog =
  | { kind: 'create'; guids: string[]; revision: number }
  | { kind: 'delete'; guids: string[]; mode: 'subtree' | 'partsOnly'; revision: number }
  | { kind: 'prune'; guids: string[]; parentGuid: string | null; revision: number };

function CreatePartForm({
  guids,
  revision,
  close,
}: {
  guids: string[];
  revision: number;
  close: () => void;
}) {
  const { state, t } = useEditor(),
    objects = state.document!.objects;
  const [value, setValue] = useState<CreatePart>(() => {
    let id = 'Part',
      n = 1;
    while (objects.some((o) => o.id === id)) id = 'Part' + ++n;
    return {
      name: `${t('partDefaultName')}${objects.filter((o) => o.kind === 'part').length}`,
      id,
      drawOrder: 500,
      guids,
      groupSelected: guids.length >= 2,
    };
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const duplicate = objects.some((o) => o.id === value.id);
  return (
    <TreeDialog
      title={t('partCreate')}
      close={() => {
        if (!busy) close();
      }}
      className="part-dialog"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || duplicate) return;
          setBusy(true);
          setError('');
          try {
            await window.lattice.command({ type: 'createPart', value, expectedRevision: revision });
            close();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="property">
          <span>{t('name')}</span>
          <input
            required
            maxLength={256}
            value={value.name}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
        </label>
        <label className="property">
          <span>{t('partId')}</span>
          <input
            required
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            maxLength={256}
            aria-invalid={duplicate}
            value={value.id}
            onChange={(e) => setValue({ ...value, id: e.target.value })}
          />
        </label>
        <label className="property">
          <span>{t('drawOrder')}</span>
          <input
            required
            type="number"
            min={0}
            max={1000}
            step={1}
            value={Number.isNaN(value.drawOrder) ? '' : value.drawOrder}
            onChange={(e) => setValue({ ...value, drawOrder: e.target.valueAsNumber })}
          />
        </label>
        <label className="radio-row">
          <input
            type="checkbox"
            checked={value.groupSelected}
            disabled={!guids.length}
            onChange={(e) => setValue({ ...value, groupSelected: e.target.checked })}
          />
          {t('partGroupSelection')}
        </label>
        <p className="muted">{t('partIdHint')}</p>
        {(error || duplicate) && (
          <p role="alert" className="part-error">
            {duplicate ? t('partDuplicateId') : error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            {t('cancel')}
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || duplicate || !value.name.trim()}
          >
            {t('create')}
          </button>
        </footer>
      </form>
    </TreeDialog>
  );
}

export function usePartDialogs() {
  const { state, t } = useEditor();
  const [dialog, setDialog] = useState<Dialog | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setDialog(null);
    setError('');
  }, [state.document?.rootPartGuid]);
  const open = (value: Dialog) => {
    setError('');
    setDialog(value);
  };
  let element = null;
  if (state.document && dialog?.kind === 'create')
    element = <CreatePartForm {...dialog} close={() => setDialog(null)} />;
  else if (state.document && dialog && dialog.kind !== 'create') {
    const current = dialog,
      objects = state.document?.objects || [];
    const ids =
      current.kind === 'delete' && current.mode === 'subtree'
        ? partDescendants(objects, current.guids)
        : current.guids;
    element = (
      <TreeDialog
        title={t(
          current.kind === 'prune'
            ? 'partPruneTitle'
            : current.mode === 'partsOnly'
              ? 'partDissolve'
              : 'partDelete',
        )}
        close={() => {
          if (!busy) setDialog(null);
        }}
      >
        <p>
          {t(
            current.kind === 'prune'
              ? 'partPruneHint'
              : current.mode === 'partsOnly'
                ? 'partDissolveHint'
                : 'partDeleteHint',
          )}
        </p>
        <ul>
          {ids.map((id) => {
            const object = objects.find((o) => o.guid === id);
            return <li key={id}>{object?.name || object?.id}</li>;
          })}
        </ul>
        {error && (
          <p role="alert" className="part-error">
            {error}
          </p>
        )}
        <footer>
          <button disabled={busy} onClick={() => setDialog(null)}>
            {t('cancel')}
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await window.lattice.command(
                  current.kind === 'prune'
                    ? {
                        type: 'pruneEmptyParts',
                        parentGuid: current.parentGuid,
                        expectedRevision: current.revision,
                      }
                    : {
                        type: 'deletePartObjects',
                        guids: current.guids,
                        mode: current.mode,
                        expectedRevision: current.revision,
                      },
                );
                setDialog(null);
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('partConfirmDelete')}
          </button>
        </footer>
      </TreeDialog>
    );
  }
  return {
    element,
    create: (guids: string[]) => open({ kind: 'create', guids, revision: state.revision }),
    remove: (guids: string[], mode: 'subtree' | 'partsOnly' = 'subtree') =>
      open({ kind: 'delete', guids, mode, revision: state.revision }),
    prune: (guids: string[], parentGuid: string | null) =>
      open({ kind: 'prune', guids, parentGuid, revision: state.revision }),
  };
}
