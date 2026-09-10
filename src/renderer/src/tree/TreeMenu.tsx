import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TreeMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  separator?: boolean;
}

export function TreeMenu({
  x,
  y,
  label,
  items,
  close,
}: {
  x: number;
  y: number;
  label: string;
  items: TreeMenuItem[];
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!,
      previous = document.activeElement as HTMLElement;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) close();
    };
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('pointerdown', outside);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="tree-context-menu"
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          close();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          const buttons = [
            ...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          disabled={item.disabled}
          className={item.separator ? 'tree-menu-separator' : ''}
          onClick={() => {
            close();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function TreeDialog({
  title,
  close,
  children,
  className = '',
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div className="modal-backdrop">
      <section
        ref={ref}
        className={`modeling-dialog tree-prune-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
          if (e.key === 'Tab') {
            const buttons = [
              ...ref.current!.querySelectorAll<HTMLElement>(
                'input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)',
              ),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLElement);
            e.preventDefault();
            buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
          }
        }}
      >
        <h2>{title}</h2>
        {children}
      </section>
    </div>,
    document.body,
  );
}
