import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ModelObject } from '../../../shared/types';
import { useEditor } from '../store';

function useDialogFocus(close: () => void) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const keyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    if (e.key === 'Tab') {
      const nodes = [
        ...ref.current!.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)'),
      ];
      if (e.shiftKey && document.activeElement === nodes[0]) {
        e.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
        e.preventDefault();
        nodes[0]?.focus();
      }
    }
  };
  return { ref, onKeyDown: keyDown };
}

export function MaskDialog({
  objects,
  selected,
  apply,
  close,
}: {
  objects: ModelObject[];
  selected: string[];
  apply: (guids: string[]) => void;
  close: () => void;
}) {
  const { t } = useEditor(),
    [query, setQuery] = useState(''),
    [guids, setGuids] = useState(new Set(selected));
  const focus = useDialogFocus(close);
  return createPortal(
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        {...focus}
        className="inspector-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('inspectorChooseMasks')}
      >
        <h2>{t('inspectorChooseMasks')}</h2>
        <input
          autoFocus
          aria-label={t('inspectorSearch')}
          placeholder={t('inspectorSearch')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="inspector-mask-list">
          {objects
            .filter((o) => `${o.name} ${o.id}`.toLowerCase().includes(query.toLowerCase()))
            .map((o) => (
              <label key={o.guid}>
                <input
                  type="checkbox"
                  checked={guids.has(o.guid)}
                  onChange={(e) =>
                    setGuids((previous) => {
                      const next = new Set(previous);
                      if (e.target.checked) next.add(o.guid);
                      else next.delete(o.guid);
                      return next;
                    })
                  }
                />
                <span>
                  {o.name || o.id}
                  <small>{o.name ? o.id : ''}</small>
                </span>
              </label>
            ))}
        </div>
        <footer>
          <button onClick={close}>{t('cancel')}</button>
          <button
            className="primary"
            onClick={() => {
              apply([...guids]);
              close();
            }}
          >
            {t('apply')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function ColorDialog({
  initial,
  apply,
  close,
}: {
  initial: string;
  apply: (color: string) => void;
  close: () => void;
}) {
  const { t } = useEditor(),
    [color, setColor] = useState(initial);
  const focus = useDialogFocus(close);
  return createPortal(
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        {...focus}
        className="inspector-dialog inspector-color-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('inspectorColor')}
      >
        <h2>{t('inspectorColor')}</h2>
        <input
          autoFocus
          type="color"
          aria-label={t('inspectorColor')}
          value={/^#[\da-f]{6}$/i.test(color) ? color : initial}
          onChange={(e) => setColor(e.target.value.toUpperCase())}
        />
        <input
          aria-label="RGB"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          maxLength={7}
        />
        <footer>
          <button onClick={close}>{t('cancel')}</button>
          <button
            className="primary"
            disabled={!/^#[\da-f]{6}$/i.test(color)}
            onClick={() => {
              apply(color);
              close();
            }}
          >
            {t('apply')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
