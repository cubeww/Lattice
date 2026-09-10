import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEditor } from '../store';

export function PhysicsNumber({
  value,
  onCommit,
  min = -100000,
  max = 100000,
  step = 0.1,
  title,
  disabled = false,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  title?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value)),
    focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  const commit = () => {
    focused.current = false;
    const v = Number(text);
    if (!text.trim() || !Number.isFinite(v)) {
      setText(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, v));
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      type="number"
      value={text}
      step={step}
      min={min}
      max={max}
      title={title}
      aria-label={title}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(String(value));
          focused.current = false;
          e.stopPropagation();
        }
      }}
    />
  );
}
export function PhysicsText({
  value,
  onCommit,
  label,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      aria-label={label}
      maxLength={256}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text.trim();
        if (next && next !== value) onCommit(next);
        else setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value);
          e.stopPropagation();
        }
      }}
    />
  );
}
export function PhysicsModal({
  title,
  close,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useEditor();
  return (
    <div
      className="physics-submodal-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <section
        className={`physics-submodal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="physics-submodal-title">
          <strong>{title}</strong>
          <button aria-label={t('phClose')} onClick={close}>
            <X size={16} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function reorder<T>(values: T[], index: number, delta: number) {
  const next = [...values],
    dest = index + delta;
  if (index < 0 || dest < 0 || dest >= next.length) return next;
  [next[index], next[dest]] = [next[dest], next[index]];
  return next;
}
