import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEditor } from '../store';

export function FormWindow({
  title,
  close,
  busy,
  children,
  palette = false,
}: {
  title: string;
  close: () => void;
  busy?: boolean;
  children: ReactNode;
  palette?: boolean;
}) {
  const { t } = useEditor(),
    element = useRef<HTMLElement>(null);
  const [position, setPosition] = useState(() => ({
    left: Math.max(
      12,
      (document.querySelector('[data-testid=model-canvas]')?.getBoundingClientRect().left || 410) -
        (palette ? 380 : 340),
    ),
    top: palette ? 110 : 170,
  }));
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const current = useRef({ close, busy });
  current.current = { close, busy };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (palette && document.querySelector('[data-form-edit-dialog]')))
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!current.current.busy) current.current.close();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [palette]);
  return (
    <section
      ref={element}
      className={`form-window ${palette ? 'form-special' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      data-form-edit-dialog={palette ? undefined : true}
      style={position}
    >
      <header
        onPointerDown={(event) => {
          if (event.button || (event.target as HTMLElement).closest('button')) return;
          event.preventDefault();
          drag.current = { x: event.clientX, y: event.clientY, ...position };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d) return;
          setPosition({
            left: Math.max(
              8,
              Math.min(
                window.innerWidth - (element.current?.offsetWidth || 380) - 8,
                d.left + event.clientX - d.x,
              ),
            ),
            top: Math.max(8, Math.min(window.innerHeight - 45, d.top + event.clientY - d.y)),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <h2>{title}</h2>
        <button type="button" aria-label={t('closeNotice')} disabled={busy} onClick={close}>
          <X size={16} />
        </button>
      </header>
      {children}
    </section>
  );
}
