import { useRef, useState } from 'react';
import { useEditor } from '../store';

/** Drafts commit once on Enter/blur. The parent key discards drafts on selection/pose changes. */
export function PropertyInput({
  label,
  value,
  commit,
  disabled,
  min,
  max,
  step,
  pattern,
  maxLength,
  multiline = false,
  unit,
}: {
  label: string;
  value: string | number | undefined;
  commit: (value: string) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  pattern?: string;
  maxLength?: number;
  multiline?: boolean;
  unit?: string;
}) {
  const { t, command } = useEditor();
  const [draft, setDraft] = useState<string | null>(null),
    [invalid, setInvalid] = useState(false);
  const canceled = useRef(false);
  const numeric = min !== undefined;
  const props = {
    'aria-label': label,
    'aria-invalid': invalid || undefined,
    title: invalid ? t('inspectorInvalid') : undefined,
    value: draft ?? value ?? '',
    placeholder: value === undefined ? t('inspectorMixed') : '',
    disabled,
    maxLength,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      setInvalid(false);
    },
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!canceled.current && draft !== null && draft !== String(value ?? '')) {
        if (
          event.target.validity.valid &&
          (!numeric || (draft.trim() !== '' && Number.isFinite(Number(draft))))
        ) {
          commit(draft);
          setDraft(null);
        } else setInvalid(true);
      } else setDraft(null);
      canceled.current = false;
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && ['o', 's'].includes(event.key.toLowerCase())) return;
      event.stopPropagation();
      if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey))
        event.currentTarget.blur();
      if (event.key === 'Escape') {
        canceled.current = true;
        setDraft(null);
        setInvalid(false);
        event.currentTarget.blur();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        ['z', 'y'].includes(event.key.toLowerCase()) &&
        draft === null
      ) {
        event.preventDefault();
        event.currentTarget.blur();
        command({ type: event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo' });
      }
    },
  };
  return (
    <label className={`inspector-property${multiline ? ' inspector-multiline' : ''}`}>
      <span title={label}>{label}</span>
      {multiline ? (
        <textarea {...props} rows={3} />
      ) : (
        <input
          {...props}
          type={numeric ? 'number' : 'text'}
          min={min}
          max={max}
          step={step ?? 'any'}
          pattern={pattern}
        />
      )}
      {unit && <small className="inspector-unit">{unit}</small>}
    </label>
  );
}

export function PropertyCheck({
  label,
  value,
  disabled,
  commit,
}: {
  label: string;
  value: boolean | undefined;
  disabled: boolean;
  commit: (value: boolean) => void;
}) {
  return (
    <label className="inspector-check">
      <input
        type="checkbox"
        aria-label={label}
        checked={value ?? false}
        disabled={disabled}
        ref={(node) => {
          if (node) node.indeterminate = value === undefined;
        }}
        onChange={(e) => commit(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
