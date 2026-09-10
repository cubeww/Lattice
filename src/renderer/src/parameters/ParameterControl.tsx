import { useRef, useState, type PointerEvent } from 'react';
import type { Parameter } from '../../../shared/types';
import { useEditor } from '../store';
import { useParameterGesture } from './useParameterGesture';

const adjustmentKeys = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export const parameterKeys = (p: Parameter, guids: string[]) =>
  [...new Set(guids.flatMap((id) => p.bindings[id] || []))].sort((a, b) => a - b);
export const ratio = (p: Parameter, value: number) => (value - p.min) / (p.max - p.min || 1);
const near = (a: number, b: number) => Math.abs(a - b) < 0.00001;
function snapped(p: Parameter, value: number, keys: number[], enabled: boolean) {
  value = Math.max(p.min, Math.min(p.max, value));
  const key = keys.reduce<number | undefined>(
    (best, k) => (best === undefined || Math.abs(k - value) < Math.abs(best - value) ? k : best),
    undefined,
  );
  return enabled && key !== undefined && Math.abs(key - value) <= (p.max - p.min) * 0.025
    ? key
    : value;
}

export function ParameterNumber({
  parameter: p,
  select,
}: {
  parameter: Parameter;
  select: () => void;
}) {
  const { state, command, t } = useEditor();
  const [draft, setDraft] = useState<string | null>(null),
    canceled = useRef(false);
  const value = state.parameterValues[p.id] ?? p.default;
  return (
    <input
      className={`parameter-number mono${near(value, p.default) ? '' : ' changed'}`}
      type="number"
      aria-label={`${p.name} ${t('parameters')}`}
      min={p.min}
      max={p.max}
      step="any"
      disabled={!state.preview}
      value={draft ?? Number(value.toFixed(Math.max(0, Math.min(6, p.decimalPlaces))))}
      onFocus={() => {
        setDraft(String(value));
        select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!canceled.current && draft?.trim() && Number.isFinite(Number(draft)))
          command({
            type: 'setParameter',
            id: p.id,
            value: Math.max(p.min, Math.min(p.max, Number(draft))),
          });
        canceled.current = false;
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          canceled.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function ParameterSlider({
  parameter: p,
  select,
}: {
  parameter: Parameter;
  select: () => void;
}) {
  const { state, command, t } = useEditor(),
    shift = useRef(false),
    keyboard = useRef(false),
    slider = useRef<HTMLInputElement>(null);
  const gesture = useParameterGesture([p.id]);
  const active = parameterKeys(p, state.selectedGuids),
    value = state.parameterValues[p.id] ?? p.default;
  const change = (value: number) => command({ type: 'setParameter', id: p.id, value });
  return (
    <div
      className="parameter-track"
      title={`${p.min} … ${p.max}`}
      onDoubleClick={() => change(p.default)}
    >
      <input
        ref={slider}
        type="range"
        aria-label={p.name}
        data-param={p.id}
        min={p.min}
        max={p.max}
        step="any"
        value={value}
        disabled={!state.preview || p.min >= p.max}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          keyboard.current = false;
          shift.current = e.shiftKey;
          select();
          gesture.begin();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          shift.current = e.shiftKey;
        }}
        onKeyDown={(e) => {
          keyboard.current = true;
          shift.current = e.shiftKey;
          if (e.key === 'Escape' && gesture.finish(true)) {
            e.preventDefault();
            e.stopPropagation();
          } else if (e.ctrlKey || e.metaKey) {
            gesture.finish();
          } else if (adjustmentKeys.has(e.key)) {
            gesture.begin();
            // Native key repeats must start at the latest input, including values
            // waiting for the next frame or a main-process acknowledgement.
            e.currentTarget.value = String(gesture.value(p.id, value));
          }
        }}
        onKeyUp={(e) => {
          if (adjustmentKeys.has(e.key)) gesture.finish();
        }}
        onPointerUp={() => gesture.finish()}
        onPointerCancel={() => gesture.finish(true)}
        onLostPointerCapture={() => gesture.finish()}
        onBlur={() => gesture.finish()}
        onChange={(e) =>
          gesture.update({
            [p.id]: snapped(
              p,
              Number(e.target.value),
              active.length ? active : p.keys,
              state.parameterPanel.snap && !keyboard.current && !shift.current,
            ),
          })
        }
      />
      <span className="parameter-default" style={{ left: `${ratio(p, p.default) * 100}%` }} />
      <div className="parameter-keys">
        {p.keys.map((key) => (
          <button
            key={key}
            type="button"
            aria-label={`${p.name} · ${t('parameterKeyValue')} ${key}`}
            title={String(key)}
            className={`key${active.some((v) => near(v, key)) ? ' bound' : ''}${near(value, key) ? ' current' : ''}`}
            style={{ left: `${ratio(p, key) * 100}%` }}
            disabled={!state.preview}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              slider.current?.focus({ preventScroll: true });
              select();
              gesture.begin();
              gesture.update({ [p.id]: key });
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId) || !slider.current) return;
              const rect = slider.current.getBoundingClientRect();
              gesture.update({
                [p.id]: snapped(
                  p,
                  p.min + ((e.clientX - rect.left) / rect.width) * (p.max - p.min),
                  active.length ? active : p.keys,
                  state.parameterPanel.snap && !e.shiftKey,
                ),
              });
            }}
            onPointerUp={() => gesture.finish()}
            onPointerCancel={() => gesture.finish(true)}
            onLostPointerCapture={() => gesture.finish()}
            onClick={(e) => {
              // Pointer clicks are committed by the gesture; retain keyboard activation.
              if (e.detail === 0) {
                select();
                change(key);
              }
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ))}
      </div>
      <span
        className={`parameter-cursor${p.keys.length ? ' keyed' : ''}`}
        style={{ left: `${ratio(p, value) * 100}%` }}
      />
    </div>
  );
}

export function ParameterXY({ x, y, select }: { x: Parameter; y: Parameter; select: () => void }) {
  const { state, command, t } = useEditor();
  const gesture = useParameterGesture([x.id, y.id]);
  const xv = state.parameterValues[x.id] ?? x.default,
    yv = state.parameterValues[y.id] ?? y.default;
  const xkeys = parameterKeys(x, state.selectedGuids),
    ykeys = parameterKeys(y, state.selectedGuids);
  const apply = (a: number, b: number, snap = false, dragging = false) => {
    const values = {
      [x.id]: snapped(x, a, xkeys.length ? xkeys : x.keys, snap),
      [y.id]: snapped(y, b, ykeys.length ? ykeys : y.keys, snap),
    };
    if (dragging) gesture.update(values);
    else command({ type: 'setParameters', values });
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    apply(
      x.min + ((e.clientX - rect.left) / rect.width) * (x.max - x.min),
      y.min + (1 - (e.clientY - rect.top) / rect.height) * (y.max - y.min),
      state.parameterPanel.snap && !e.shiftKey,
      true,
    );
  };
  return (
    <div
      className="parameter-xy"
      role="group"
      aria-label={`${t('parameterXY')} · ${x.name} / ${y.name}`}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0 || !state.preview) return;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        select();
        gesture.begin();
        move(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
      }}
      onPointerUp={(e) => {
        gesture.finish();
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => gesture.finish(true)}
      onLostPointerCapture={() => gesture.finish()}
      onBlur={() => gesture.finish()}
      onDoubleClick={() => apply(x.default, y.default)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && gesture.finish(true)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          gesture.finish();
          return;
        }
        const steps = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, 1],
          ArrowDown: [0, -1],
        }[e.key];
        if (steps) {
          e.preventDefault();
          e.stopPropagation();
          gesture.begin();
          apply(
            gesture.value(x.id, xv) + (steps[0] * (x.max - x.min)) / (e.shiftKey ? 1000 : 100),
            gesture.value(y.id, yv) + (steps[1] * (y.max - y.min)) / (e.shiftKey ? 1000 : 100),
            false,
            true,
          );
        }
        if (e.key === 'Home') {
          e.preventDefault();
          gesture.begin();
          apply(x.default, y.default, false, true);
        }
      }}
      onKeyUp={(e) => {
        if (adjustmentKeys.has(e.key)) gesture.finish();
      }}
    >
      <span className="xy-default-x" style={{ left: `${ratio(x, x.default) * 100}%` }} />
      <span className="xy-default-y" style={{ top: `${(1 - ratio(y, y.default)) * 100}%` }} />
      {x.keys.map((a) =>
        y.keys.map((b) => (
          <span
            key={`${a}:${b}`}
            className={`xy-key${xkeys.includes(a) && ykeys.includes(b) ? ' bound' : ''}`}
            style={{ left: `${ratio(x, a) * 100}%`, top: `${(1 - ratio(y, b)) * 100}%` }}
          />
        )),
      )}
      <span
        className="xy-cursor"
        style={{ left: `${ratio(x, xv) * 100}%`, top: `${(1 - ratio(y, yv)) * 100}%` }}
      />
    </div>
  );
}
