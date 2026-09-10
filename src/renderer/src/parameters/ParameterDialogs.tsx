import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2 } from 'lucide-react';
import type { EditorCommand, Parameter } from '../../../shared/types';
import {
  parameterDescendants,
  type ParameterDefinition,
  type ParameterKeyEdit,
} from '../../../shared/parameters';
import { IconButton } from '../components';
import { useEditor } from '../store';
import { parameterKeys } from './ParameterControl';

// Selection updates can finish after a double-click opens a dialog. Only a
// changed source model invalidates its draft; preview/selection changes do not.
function useParameterRevision() {
  const { state } = useEditor();
  const [base] = useState({ model: state.documentRevision, revision: state.revision });
  return base.model === state.documentRevision ? state.revision : base.revision;
}

export function Dialog({
  title,
  close,
  children,
  action,
  valid = true,
  submit,
  formatError,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  action: string;
  valid?: boolean;
  submit: () => Promise<unknown>;
  formatError?: (error: unknown) => string;
}) {
  const { t } = useEditor(),
    form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (form.current?.querySelector('[autofocus],input,button') as HTMLElement | null)?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' && !busy) {
          e.preventDefault();
          close();
        }
        if (e.key === 'Tab') {
          const nodes = [
            ...form.current!.querySelectorAll<HTMLElement>(
              'input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled),[tabindex="0"]',
            ),
          ];
          if (e.shiftKey && document.activeElement === nodes[0]) {
            e.preventDefault();
            nodes.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
            e.preventDefault();
            nodes[0]?.focus();
          }
        }
      }}
    >
      <form
        ref={form}
        className="modeling-dialog parameter-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          setError('');
          void submit()
            .then(close)
            .catch((e) =>
              setError(
                formatError
                  ? formatError(e)
                  : e instanceof Error
                    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
                    : String(e),
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        <h2>{title}</h2>
        <fieldset disabled={busy}>{children}</fieldset>
        {error && (
          <p className="parameter-validation" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            {t('cancel')}
          </button>
          <button type="submit" className="primary" disabled={!valid || busy}>
            {action}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

export function ParameterDialog({
  parameter,
  groupGuid,
  close,
}: {
  parameter?: Parameter;
  groupGuid: string;
  close: () => void;
}) {
  const { state, t } = useEditor(),
    revision = useParameterRevision();
  const [value, setValue] = useState<ParameterDefinition>(() => {
    let id = 'Param',
      i = 1;
    while (state.document!.parameters.some((p) => p.id === id)) id = 'Param' + i++;
    return parameter
      ? { ...parameter }
      : { id, name: t('newParameter'), min: -30, max: 30, default: 0, description: '' };
  });
  const [parent, setParent] = useState(groupGuid);
  const set = (patch: Partial<ParameterDefinition>) => setValue({ ...value, ...patch });
  const invalidRange =
    ![value.min, value.max, value.default].every(Number.isFinite) ||
    !(
      Math.fround(value.min) < Math.fround(value.max) &&
      value.default >= value.min &&
      value.default <= value.max
    );
  const invalidId =
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.id) ||
    state.document!.parameters.some((p) => p.guid !== parameter?.guid && p.id === value.id);
  const invalidKeys = parameter?.keys.some((k) => k < value.min || k > value.max);
  return (
    <Dialog
      title={t(parameter ? 'parameterSettings' : 'newParameter')}
      close={close}
      action={t(parameter ? 'parameterSave' : 'create')}
      valid={!!value.name.trim() && !invalidRange && !invalidId && !invalidKeys}
      submit={() =>
        window.lattice.command(
          parameter
            ? { type: 'editParameter', guid: parameter.guid, value, expectedRevision: revision }
            : { type: 'createParameter', value, groupGuid: parent, expectedRevision: revision },
        )
      }
    >
      <label className="property">
        <span>{t('name')}</span>
        <input
          autoFocus
          required
          maxLength={256}
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label className="property">
        <span>ID</span>
        <input
          required
          maxLength={256}
          value={value.id}
          onChange={(e) => set({ id: e.target.value })}
        />
      </label>
      <p className="parameter-dialog-hint">{t('parameterIdHint')}</p>
      <div className="parameter-range-fields">
        {(['min', 'default', 'max'] as const).map((field, i) => (
          <label key={field}>
            <span>
              {t((['parameterMinimum', 'parameterDefault', 'parameterMaximum'] as const)[i])}
            </span>
            <input
              type="number"
              required
              step="any"
              min={-1e7}
              max={1e7}
              value={Number.isNaN(value[field]) ? '' : value[field]}
              onChange={(e) =>
                set({ [field]: e.target.value === '' ? NaN : Number(e.target.value) })
              }
            />
          </label>
        ))}
      </div>
      {!parameter && (
        <label className="property">
          <span>{t('parameterFolder')}</span>
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            {state.document!.parameterGroups.map((g) => (
              <option key={g.guid} value={g.guid}>
                {g.parentGuid ? g.name : t('parameterRoot')}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="property">
        <span>{t('parameterDescription')}</span>
        <textarea
          rows={2}
          maxLength={4096}
          value={value.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      {(invalidRange || invalidId || invalidKeys) && (
        <p className="parameter-validation">
          {t(
            invalidId
              ? 'parameterIdError'
              : invalidRange
                ? 'parameterRangeError'
                : 'parameterKeysRangeError',
          )}
        </p>
      )}
    </Dialog>
  );
}

export function FolderDialog({ guid, close }: { guid: string; close: () => void }) {
  const { state, t } = useEditor(),
    revision = useParameterRevision(),
    [name, setName] = useState(state.document!.parameterGroups.find((g) => g.guid === guid)!.name);
  return (
    <Dialog
      title={t('renameParameterFolder')}
      close={close}
      action={t('parameterSave')}
      valid={!!name.trim()}
      submit={() =>
        window.lattice.command({
          type: 'renameParameterGroup',
          guid,
          name,
          expectedRevision: revision,
        })
      }
    >
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
    </Dialog>
  );
}

export function KeyDialog({ parameter: p, close }: { parameter: Parameter; close: () => void }) {
  const { state, t } = useEditor(),
    revision = useParameterRevision(),
    [guids] = useState(state.selectedGuids);
  const [keys, setKeys] = useState(() =>
      parameterKeys(p, guids).map((value, uid) => ({
        uid,
        previous: value as number | undefined,
        value: String(value),
      })),
    ),
    nextId = useRef(keys.length);
  const [newValue, setNewValue] = useState(String(state.parameterValues[p.id] ?? p.default));
  const values = keys.map((k) => Number(k.value)).sort((a, b) => a - b);
  const valid =
    keys.every((k) => k.value.trim() && Number.isFinite(Number(k.value))) &&
    values.every(
      (n, i) =>
        n >= p.min && n <= p.max && (!i || Math.fround(n) - Math.fround(values[i - 1]) >= 0.0001),
    );
  const add = (values: number[]) =>
    setKeys((old) => [
      ...old,
      ...values
        .filter((v) => !old.some((k) => Math.abs(Number(k.value) - v) < 0.0001))
        .map((v) => ({ uid: nextId.current++, previous: undefined, value: String(v) })),
    ]);
  return (
    <Dialog
      title={`${t('editParameterKeys')} · ${p.name}`}
      close={close}
      action={t('parameterSave')}
      valid={valid && keys.length <= 101}
      submit={() =>
        window.lattice.command({
          type: 'editParameterKeys',
          guids,
          edits: [
            {
              parameterGuid: p.guid,
              keys: keys.map((k) => ({ value: Number(k.value), previous: k.previous })),
            },
          ],
          expectedRevision: revision,
        })
      }
    >
      <p className="parameter-dialog-hint">{t('parameterKeysHint')}</p>
      <div className="parameter-key-preview">
        <span />
        {keys
          .filter((k) => Number.isFinite(Number(k.value)))
          .map((k) => (
            <i
              key={k.uid}
              style={{
                left: `${Math.max(0, Math.min(100, ((Number(k.value) - p.min) / (p.max - p.min)) * 100))}%`,
              }}
            />
          ))}
      </div>
      <div className="parameter-key-list">
        {keys.map((key, index) => (
          <label key={key.uid} className="parameter-key-entry">
            <span>{index + 1}</span>
            <input
              aria-label={`${t('parameterKeyValue')} ${index + 1}`}
              type="number"
              required
              step="any"
              min={p.min}
              max={p.max}
              value={key.value}
              onChange={(e) =>
                setKeys(keys.map((k) => (k.uid === key.uid ? { ...k, value: e.target.value } : k)))
              }
            />
            <IconButton
              icon={Trash2}
              label={`${t('removeParameterKey')} ${index + 1}`}
              onClick={() => setKeys(keys.filter((k) => k.uid !== key.uid))}
            />
          </label>
        ))}
      </div>
      <div className="parameter-key-actions">
        <input
          aria-label={t('parameterKeyValue')}
          type="number"
          min={p.min}
          max={p.max}
          step="any"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <IconButton
          icon={Plus}
          label={t('addParameterKey')}
          disabled={
            !newValue.trim() ||
            !Number.isFinite(Number(newValue)) ||
            Number(newValue) < p.min ||
            Number(newValue) > p.max ||
            keys.length >= 101
          }
          onClick={() => add([Number(newValue)])}
        />
        <button type="button" onClick={() => add([p.min, p.max])}>
          {t('addTwoKeys')}
        </button>
        <button type="button" onClick={() => add([p.min, (p.min + p.max) / 2, p.max])}>
          {t('addThreeKeys')}
        </button>
      </div>
      {!valid && <p className="parameter-validation">{t('parameterKeysError')}</p>}
    </Dialog>
  );
}

export function ParameterConfirm({ kind, close }: { kind: 'delete' | 'keys'; close: () => void }) {
  const { state, t } = useEditor(),
    revision = useParameterRevision(),
    [selection] = useState(() =>
      kind === 'delete'
        ? parameterDescendants(state.document!.parameterGroups, state.parameterPanel.selection)
        : state.parameterPanel.selection,
    ),
    [objects] = useState(state.selectedGuids);
  const names = [...state.document!.parameters, ...state.document!.parameterGroups].filter((p) =>
    selection.includes(p.guid),
  );
  const edits: ParameterKeyEdit[] = state
    .document!.parameters.filter((p) => selection.includes(p.guid))
    .map((p) => ({ parameterGuid: p.guid, keys: [] }));
  const command: EditorCommand =
    kind === 'delete'
      ? { type: 'deleteParameterEntries', guids: selection, expectedRevision: revision }
      : { type: 'editParameterKeys', guids: objects, edits, expectedRevision: revision };
  return (
    <Dialog
      title={t(kind === 'delete' ? 'parameterDelete' : 'removeParameterKeys')}
      close={close}
      action={t('parameterDeleteAction')}
      submit={() => window.lattice.command(command)}
    >
      <p className="parameter-dialog-hint">
        {t(kind === 'delete' ? 'parameterDeleteHint' : 'parameterKeysRemoveHint')}
      </p>
      <ul className="parameter-delete-list">
        {names.map((p) => (
          <li key={p.guid}>{p.name}</li>
        ))}
      </ul>
    </Dialog>
  );
}
