import { useState } from 'react';
import { useEditor } from '../store';
import { PhysicsModal } from './fields';

export function ParameterPicker({
  output,
  excluded,
  close,
  accept,
}: {
  output: boolean;
  excluded: string[];
  close: () => void;
  accept: (ids: string[]) => void;
}) {
  const { state, t } = useEditor(),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<string[]>([]);
  const groups = new Map(state.document!.parameterGroups.map((g) => [g.guid, g.name]));
  const available = state.document!.parameters.filter((p) => !excluded.includes(p.id));
  const filtered = available.filter((p) =>
    `${p.id} ${p.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <PhysicsModal title={t(output ? 'phAddOutputs' : 'phAddInputs')} close={close}>
      <input
        autoFocus
        placeholder={t('phFind')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="physics-actions">
        <button
          onClick={() => setSelected([...new Set([...selected, ...filtered.map((p) => p.id)])])}
        >
          {t('phAll')}
        </button>
        <button onClick={() => setSelected([])}>{t('phClear')}</button>
      </div>
      <div className="physics-picker-list">
        {filtered.map((p, index) => (
          <div key={p.id}>
            {(index === 0 || filtered[index - 1].groupGuid !== p.groupGuid) && (
              <div className="physics-param-group">
                {groups.get(p.groupGuid) || t('phParameters')}
              </div>
            )}
            <label>
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id),
                  )
                }
              />
              <span>
                {p.name}
                <small>
                  {p.id} · {p.min} … {p.max}
                </small>
              </span>
              {output && !p.keys.length && (
                <small className="physics-muted">{t('phUnbound')}</small>
              )}
            </label>
          </div>
        ))}
      </div>
      <div className="physics-dialog-footer">
        <button onClick={close}>{t('phCancel')}</button>
        <button
          className="primary"
          disabled={!selected.length}
          onClick={() => {
            accept(selected);
            close();
          }}
        >
          {t('phAdd')} ({selected.length})
        </button>
      </div>
    </PhysicsModal>
  );
}
