import { useEffect, useRef, useState, type RefObject } from 'react';
import { Scan, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { PhysicsRuntime } from '../../../core/physics/runtime';
import { evaluatePhysicsMotion, type PhysicsMotion } from '../../../core/physics/motion';
import type { PhysicsSettings } from '../../../shared/physics';
import type { SourceScene } from '../../../shared/scene';
import { ModelEvaluator } from '../../../core/model/evaluate';
import { MeshRenderer } from '../viewport/webgl';
import { useEditor } from '../store';
import { IconButton } from '../components';

export interface PhysicsPlayback {
  playing: boolean;
  simulate: boolean;
  pattern: string;
  speed: number;
  loop: boolean;
  interval: number;
  fade: number;
  fading: boolean;
  track: boolean;
}
export interface PhysicsPreviewHandle {
  runtime: PhysicsRuntime;
  reset: () => void;
  resetParameters: () => void;
  resetTime: () => void;
  pauseMotion: () => void;
}
export function PhysicsPreview({
  settings,
  disabled,
  collectPeaks,
  playback,
  motions,
  handle,
  stop,
  next,
}: {
  settings: PhysicsSettings;
  disabled: string[];
  collectPeaks: boolean;
  playback: PhysicsPlayback;
  motions: PhysicsMotion[];
  handle: RefObject<PhysicsPreviewHandle | null>;
  stop: () => void;
  next: () => void;
}) {
  const { state, t } = useEditor();
  const document = state.document!,
    descriptor = state.preview!;
  const canvas = useRef<HTMLCanvasElement>(null),
    panel = useRef<HTMLDivElement>(null),
    view = useRef<HTMLDivElement>(null);
  const current = useRef({ playback, stop, next, motions });
  current.current = { playback, stop, next, motions };
  const values = useRef({ ...state.parameterValues }),
    lastInputs = useRef({ ...state.parameterValues }),
    time = useRef(0),
    lastPose = useRef({ ...state.parameterValues });
  const runtime = useRef<PhysicsRuntime>(null!);
  if (!runtime.current) runtime.current = new PhysicsRuntime(settings, document.parameters);
  const params = useRef(document.parameters);
  params.current = document.parameters;
  const camera = useRef({ scale: 0, x: 0, y: 0 });
  const [error, setError] = useState(''),
    [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const defaults = () => Object.fromEntries(params.current.map((p) => [p.id, p.default]));
  useEffect(() => {
    runtime.current = new PhysicsRuntime(settings, params.current, runtime.current);
    handle.current = {
      runtime: runtime.current,
      reset: () => runtime.current.reset(),
      resetTime: () => {
        time.current = 0;
      },
      pauseMotion: () => {
        values.current = { ...lastInputs.current };
      },
      resetParameters: () => {
        values.current = defaults();
        time.current = 0;
        runtime.current.reset();
      },
    };
    return () => {
      handle.current = null;
    };
  }, [settings, handle]);
  useEffect(() => {
    runtime.current.disabled = new Set(disabled);
    runtime.current.collectPeaks = collectPeaks;
  }, [disabled, collectPeaks, settings]);
  useEffect(() => {
    time.current = 0;
  }, [playback.pattern]);
  useEffect(() => {
    const abort = new AbortController();
    let renderer: MeshRenderer | null = null,
      frame = 0,
      previousTime = 0,
      lastMetrics = 0;
    const start = async () => {
      try {
        const response = await fetch(descriptor.sceneUrl, { signal: abort.signal });
        if (!response.ok) throw new Error('Could not read the preview scene.');
        const scene: SourceScene = await response.json();
        if (abort.signal.aborted) return;
        const evaluator = new ModelEvaluator(scene);
        renderer = new MeshRenderer(canvas.current!, setError);
        await renderer.load(scene, abort.signal);
        if (abort.signal.aborted) return;
        const tick = (now: number) => {
          if (abort.signal.aborted) return;
          const dt = previousTime ? Math.min(0.1, (now - previousTime) / 1000) : 0;
          previousTime = now;
          const control = current.current.playback;
          let input = { ...values.current };
          if (control.playing && control.pattern !== 'manual') {
            const motion = current.current.motions.find((m) => m.id === control.pattern);
            const duration = motion?.duration || 8;
            time.current += dt * control.speed;
            const poseTime = Math.min(time.current, duration),
              s = (poseTime / duration) * Math.PI * 2;
            const v = motion
              ? evaluatePhysicsMotion(motion, poseTime)
              : control.pattern === 'B'
                ? { ParamAngleY: Math.sin(s) * 30, ParamAngleZ: Math.sin(s * 2) * 25 }
                : control.pattern === 'C'
                  ? { ParamBodyAngleX: Math.sin(s) * 10, ParamBodyAngleZ: Math.sin(s * 2) * 10 }
                  : control.pattern === 'sweep'
                    ? Object.fromEntries(
                        runtime.current.settings.groups
                          .flatMap((g) => g.inputs)
                          .map((p) => {
                            const param = params.current.find((q) => q.id === p.parameterId);
                            return [
                              p.parameterId,
                              param
                                ? (param.max + param.min) / 2 +
                                  (Math.sin(s) * (param.max - param.min)) / 2
                                : 0,
                            ];
                          }),
                      )
                    : {
                        ParamAngleX: Math.sin(s) * 30,
                        ParamAngleZ: Math.sin(s * 2) * 15,
                        ParamBodyAngleX: Math.sin(s) * 5,
                      };
            const f = control.fade / 1000;
            const envelope =
              control.fading && f > 0
                ? Math.max(0, Math.min(1, poseTime / f, (duration - poseTime) / f))
                : 1;
            for (const [id, value] of Object.entries(v))
              if (id in input) input[id] += (value - input[id]) * envelope;
            if (time.current >= duration + control.interval / 1000) {
              if (control.loop) {
                time.current = 0;
                if (motion && current.current.motions.length > 1) current.current.next();
              } else {
                lastInputs.current = input;
                values.current = { ...input };
                current.current.stop();
              }
            }
          }
          lastInputs.current = input;
          const pose = control.simulate ? runtime.current.advance(dt, input) : input;
          lastPose.current = pose;
          renderer!.setPose(evaluator.evaluate(pose));
          const target = canvas.current!,
            w = Math.max(1, target.clientWidth),
            h = Math.max(1, target.clientHeight),
            dpr = window.devicePixelRatio;
          const width = Math.round(w * dpr),
            height = Math.round(h * dpr);
          if (target.width !== width || target.height !== height) {
            target.width = width;
            target.height = height;
          }
          const fit = Math.min(w / scene.canvas.width, h / scene.canvas.height) * 0.94;
          const scale = camera.current.scale || fit;
          const x = w / 2 + camera.current.x - (scene.canvas.width * scale) / 2,
            y = h / 2 + camera.current.y - (scene.canvas.height * scale) / 2;
          renderer!.draw([(2 * scale) / w, (-2 * scale) / h, (2 * x) / w - 1, 1 - (2 * y) / h]);
          view.current!.dataset.zoom = String(Math.round(scale * 100));
          if (now - lastMetrics > 80) {
            lastMetrics = now;
            panel.current
              ?.querySelectorAll<HTMLInputElement>('[data-physics-parameter]')
              .forEach((el) => {
                if (el === window.document.activeElement && el.type === 'number') return;
                const value = pose[el.dataset.physicsParameter!];
                if (value !== undefined)
                  el.value = el.type === 'range' ? String(value) : String(Number(value.toFixed(3)));
              });
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      } catch (e) {
        if (!abort.signal.aborted) setError(String(e));
      }
    };
    void start();
    return () => {
      abort.abort();
      cancelAnimationFrame(frame);
      renderer?.dispose();
    };
    // Physics edits do not invalidate the geometry or uploaded texture resources.
  }, [descriptor.id, descriptor.revision]);
  const zoom = (factor: number) => {
    const box = view.current!.getBoundingClientRect();
    const fit =
      Math.min(box.width / document.canvas.width, box.height / document.canvas.height) * 0.94;
    camera.current.scale = Math.min(8, Math.max(0.01, (camera.current.scale || fit) * factor));
  };
  const drag = useRef<{ id: number; x: number; y: number; pan: boolean } | null>(null);
  const change = (id: string, value: number) => {
    const p = params.current.find((p) => p.id === id)!;
    current.current.stop();
    values.current[id] = Math.min(p.max, Math.max(p.min, value));
  };
  const filtered = document.parameters.filter((p) =>
    `${p.name} ${p.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <section className="physics-parameters" ref={panel}>
        <button
          className="physics-reset-parameters"
          onClick={() => {
            current.current.stop();
            handle.current?.resetParameters();
          }}
        >
          {t('phResetParameters')}
        </button>
        <input
          placeholder={t('phFind')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="physics-parameter-scroll">
          {filtered.map((p, i) => {
            const group = document.parameterGroups.find((g) => g.guid === p.groupGuid);
            return (
              <div key={p.id}>
                {(i === 0 || filtered[i - 1].groupGuid !== p.groupGuid) && (
                  <button
                    className="physics-param-group"
                    onClick={() =>
                      setCollapsed(
                        collapsed.includes(p.groupGuid)
                          ? collapsed.filter((id) => id !== p.groupGuid)
                          : [...collapsed, p.groupGuid],
                      )
                    }
                  >
                    {collapsed.includes(p.groupGuid) ? '▸' : '▾'} {group?.name || t('phParameters')}
                  </button>
                )}
                {(!collapsed.includes(p.groupGuid) || !!search) && (
                  <div className="physics-parameter-row" title={p.id}>
                    <span onDoubleClick={() => change(p.id, p.default)}>{p.name}</span>
                    <input
                      type="range"
                      data-physics-parameter={p.id}
                      aria-label={p.name}
                      min={p.min}
                      max={p.max}
                      step={(p.max - p.min) / 1000 || 0.001}
                      defaultValue={values.current[p.id] ?? p.default}
                      onChange={(e) => change(p.id, e.target.valueAsNumber)}
                    />
                    <input
                      type="number"
                      data-physics-parameter={p.id}
                      aria-label={`${p.name} ${t('phCenter')}`}
                      min={p.min}
                      max={p.max}
                      step={0.01}
                      defaultValue={values.current[p.id] ?? p.default}
                      onChange={(e) => {
                        if (Number.isFinite(e.target.valueAsNumber))
                          change(p.id, e.target.valueAsNumber);
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="physics-preview">
        <div
          className="physics-model-view"
          ref={view}
          title={t('phTrackHint')}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => zoom(Math.exp(-e.deltaY * 0.001))}
          onPointerDown={(e) => {
            if (e.button === 0 && !playback.track) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button !== 0 };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            if (d.pan) {
              camera.current.x += e.clientX - d.x;
              camera.current.y += e.clientY - d.y;
            } else {
              const box = e.currentTarget.getBoundingClientRect(),
                x = Math.max(-1, Math.min(1, ((e.clientX - box.left) / box.width) * 2 - 1)),
                y = Math.max(-1, Math.min(1, 1 - ((e.clientY - box.top) / box.height) * 2));
              current.current.stop();
              for (const [id, v] of [
                ['ParamAngleX', x],
                ['ParamAngleY', y],
                ['ParamAngleZ', x * y * -0.5],
                ['ParamBodyAngleX', x * 0.3],
              ] as [string, number][]) {
                const p = params.current.find((p) => p.id === id);
                if (p)
                  values.current[id] =
                    p.default + v * (v >= 0 ? p.max - p.default : p.default - p.min);
              }
            }
            d.x = e.clientX;
            d.y = e.clientY;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            drag.current = null;
          }}
        >
          <canvas ref={canvas} />
          {error && <div className="physics-preview-error">{error}</div>}
        </div>
        <div className="physics-view-tools">
          <IconButton
            icon={Scan}
            label={t('phFit')}
            onClick={() => {
              camera.current = { scale: 0, x: 0, y: 0 };
            }}
          />
          <IconButton icon={ZoomOut} label={t('phZoomOut')} onClick={() => zoom(1 / 1.2)} />
          <IconButton icon={ZoomIn} label={t('phZoomIn')} onClick={() => zoom(1.2)} />
        </div>
      </section>
    </>
  );
}

export function PendulumView({
  handle,
  guid,
}: {
  handle: RefObject<PhysicsPreviewHandle | null>;
  guid: string;
}) {
  const { t } = useEditor(),
    canvas = useRef<HTMLCanvasElement>(null),
    camera = useRef({ scale: 1, angle: 0 });
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = canvas.current!;
      const w = el.clientWidth,
        h = el.clientHeight,
        ratio = window.devicePixelRatio;
      if (el.width !== Math.round(w * ratio) || el.height !== Math.round(h * ratio)) {
        el.width = Math.round(w * ratio);
        el.height = Math.round(h * ratio);
      }
      const ctx = el.getContext('2d')!;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#e5e9ed';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      const rig = handle.current?.runtime.snapshot().find((g) => g.guid === guid);
      const group = handle.current?.runtime.settings.groups.find((g) => g.guid === guid);
      if (rig?.particles.length && group) {
        const length = group.particles.reduce((n, p) => n + p.radius, 0);
        const scale =
          Math.min(w / Math.max(20, length * 1.6), h / Math.max(10, length * 1.5)) *
          camera.current.scale;
        const root = rig.particles[0];
        const points = rig.particles.map((p) => {
          const x = p.x - root.x,
            y = p.y - root.y,
            a = camera.current.angle;
          return [
            w / 2 + (x * Math.cos(a) - y * Math.sin(a)) * scale,
            h * 0.22 + (x * Math.sin(a) + y * Math.cos(a)) * scale,
          ];
        });
        ctx.strokeStyle = '#367bbb';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        points.forEach(([x, y], i) => {
          ctx.fillStyle = i ? '#367bbb' : '#39424d';
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
          if (i) ctx.fillText(String(i), x + 8, y + 3);
        });
        ctx.fillStyle = '#677788';
        ctx.font = '11px Segoe UI';
        ctx.fillText(`${t('phAngle')}: ${rig.angle.toFixed(1)}°`, 8, 15);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [handle, guid, t]);
  return (
    <div className="physics-pendulum-view">
      <canvas ref={canvas} />
      <div className="physics-view-tools">
        <IconButton
          icon={Scan}
          label={t('phFit')}
          onClick={() => {
            camera.current = { scale: 1, angle: 0 };
          }}
        />
        <IconButton
          icon={ZoomOut}
          label={t('phZoomOut')}
          onClick={() => {
            camera.current.scale = Math.max(0.2, camera.current.scale / 1.2);
          }}
        />
        <IconButton
          icon={ZoomIn}
          label={t('phZoomIn')}
          onClick={() => {
            camera.current.scale = Math.min(10, camera.current.scale * 1.2);
          }}
        />
        <IconButton
          icon={RotateCcw}
          label={t('phRotate')}
          onClick={() => {
            camera.current.angle -= Math.PI / 4;
          }}
        />
      </div>
    </div>
  );
}
