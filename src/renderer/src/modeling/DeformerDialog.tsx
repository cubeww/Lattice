import { useState } from 'react';
import { useEditor } from '../store';
export function DeformerDialog({ kind, close }: { kind: 'warp' | 'rotation'; close: () => void }) {
  const { state, t, perform } = useEditor();
  const [name, setName] = useState(t(kind === 'warp' ? 'warpKind' : 'rotationKind')),
    [placement, setPlacement] = useState<'parent' | 'child'>('parent'),
    [columns, setColumns] = useState(5),
    [rows, setRows] = useState(5),
    [bezierColumns, setBezierColumns] = useState(2),
    [bezierRows, setBezierRows] = useState(2),
    [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop">
      <form
        className="modeling-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(kind === 'warp' ? 'createWarp' : 'createRotation')}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          perform(async () => {
            try {
              await window.lattice.command({
                type: 'createDeformer',
                expectedRevision: state.revision,
                value: {
                  kind,
                  name,
                  placement,
                  guids: state.selectedGuids,
                  columns,
                  rows,
                  bezierColumns,
                  bezierRows,
                },
              });
              close();
            } finally {
              setBusy(false);
            }
          });
        }}
      >
        <h2>{t(kind === 'warp' ? 'createWarp' : 'createRotation')}</h2>
        <label className="property">
          <span>{t('name')}</span>
          <input
            autoFocus
            required
            maxLength={256}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name="placement"
            checked={placement === 'parent'}
            onChange={() => setPlacement('parent')}
          />
          {t('parentOfSelection')}
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name="placement"
            checked={placement === 'child'}
            onChange={() => setPlacement('child')}
            disabled={
              state.selectedGuids.length !== 1 ||
              !state.document?.objects.some(
                (o) => o.guid === state.selectedGuid && ['warp', 'rotation'].includes(o.kind),
              )
            }
          />
          {t('childOfSelection')}
        </label>
        {kind === 'warp' && (
          <>
            <label className="property">
              <span>{t('warpDivisions')}</span>
              <div className="number-pair">
                <input
                  aria-label={t('columns')}
                  type="number"
                  min={1}
                  max={32}
                  value={columns}
                  onChange={(e) => setColumns(Number(e.target.value))}
                />
                <span>×</span>
                <input
                  aria-label={t('rows')}
                  type="number"
                  min={1}
                  max={32}
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                />
              </div>
            </label>
            <label className="property">
              <span>{t('bezierDivisions')}</span>
              <div className="number-pair">
                <input
                  aria-label={t('bezierColumns')}
                  type="number"
                  min={1}
                  max={8}
                  value={bezierColumns}
                  onChange={(e) => setBezierColumns(Number(e.target.value))}
                />
                <span>×</span>
                <input
                  aria-label={t('bezierRows')}
                  type="number"
                  min={1}
                  max={8}
                  value={bezierRows}
                  onChange={(e) => setBezierRows(Number(e.target.value))}
                />
              </div>
            </label>
          </>
        )}
        <footer>
          <button type="button" onClick={close} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {t('create')}
          </button>
        </footer>
      </form>
    </div>
  );
}
