import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useEditor } from '../store';
import {
  automaticMeshFields,
  automaticMeshPresets,
  type AutomaticMeshSettings,
  type MeshGenerationWorkspace,
} from '../../../shared/automatic-mesh';
import type { SourceScene } from '../../../shared/scene';
import { setMeshPreview } from './mesh-preview';
import type { MeshWorkerRequest, MeshWorkerResponse } from './automatic-mesh.worker';
import { AutomaticMeshPresets, validMeshSettings } from './AutomaticMeshPresets';

export function AutomaticMeshDialog({ guids, close }: { guids: string[]; close: () => void }) {
  const { state, t, perform } = useEditor(),
    initial = useRef(state).current,
    targets = useRef([...new Set(guids)]).current,
    [settings, setSettings] = useState<AutomaticMeshSettings>({ ...automaticMeshPresets.standard }),
    [previewScene, setPreviewScene] = useState<SourceScene | null>(null),
    [ready, setReady] = useState(false),
    [pending, setPending] = useState(true),
    [busy, setBusy] = useState(false),
    [showPreview, setShowPreview] = useState(true),
    [error, setError] = useState(''),
    [result, setResult] = useState<Extract<MeshWorkerResponse, { type: 'result' }> | null>(null);
  const worker = useRef<Worker | null>(null),
    generation = useRef(0),
    closeRef = useRef(close),
    form = useRef<HTMLFormElement>(null),
    drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null),
    [position, setPosition] = useState(() => {
      const viewport = document
        .querySelector('[data-testid=model-canvas]')
        ?.getBoundingClientRect();
      return {
        left: Math.max(12, (viewport?.left || 370) - 354),
        top: Math.max(80, Math.min(Math.max(105, viewport?.top || 130), window.innerHeight - 500)),
      };
    });
  closeRef.current = close;
  useEffect(() => {
    const abort = new AbortController(),
      w = new Worker(new URL('./automatic-mesh.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = (event: MessageEvent<MeshWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'ready') {
        setPreviewScene(message.scene);
        setReady(true);
      } else if (message.type === 'error') {
        if (message.id !== undefined && message.id !== generation.current) return;
        setError(message.message);
        setResult(null);
        setPending(false);
      } else if (message.id === generation.current) {
        setResult(message);
        setError('');
        setPending(false);
      }
    };
    w.onerror = (event) => {
      setError(event.message || t('autoMeshFailed'));
      setPending(false);
    };
    void (async () => {
      try {
        const responses = await Promise.all(
          [initial.preview!.sceneUrl, initial.preview!.meshGenerationUrl!].map((url) =>
            fetch(url, { signal: abort.signal }),
          ),
        );
        if (responses.some((r) => !r.ok)) throw new Error(t('autoMeshFailed'));
        const [scene, workspace]: [SourceScene & { revision: number }, MeshGenerationWorkspace] =
          await Promise.all([responses[0].json(), responses[1].json()]);
        if (abort.signal.aborted) return;
        if (scene.revision !== initial.preview!.revision || workspace.revision !== scene.revision)
          throw new Error(t('autoMeshChanged'));
        targets.forEach((guid) => {
          const input = workspace.inputs.find((i) => i.guid === guid);
          if (!input) throw new Error(workspace.errors[guid] || t('autoMeshFailed'));
        });
        w.postMessage({
          type: 'load',
          scene,
          inputs: workspace.inputs,
          guids: targets,
        } satisfies MeshWorkerRequest);
      } catch (error) {
        if (!abort.signal.aborted) {
          setError((error as Error).message);
          setPending(false);
        }
      }
    })();
    return () => {
      abort.abort();
      w.terminate();
      worker.current = null;
      setMeshPreview(null);
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const id = ++generation.current;
    setPending(true);
    if (!validMeshSettings(settings)) {
      setError(t('autoMeshInvalid'));
      setPending(false);
      setResult(null);
      return;
    }
    setError('');
    const timer = window.setTimeout(
      () =>
        worker.current?.postMessage({ type: 'generate', id, settings } satisfies MeshWorkerRequest),
      160,
    );
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [ready, settings]);
  useEffect(() => {
    setMeshPreview({
      documentId: initial.preview!.id,
      documentRevision: initial.documentRevision,
      enabled: showPreview,
      scene: previewScene,
      geometry: result?.geometry || null,
    });
  }, [showPreview, result, previewScene]);
  useEffect(() => {
    if (
      state.preview?.id !== initial.preview?.id ||
      state.documentRevision !== initial.documentRevision ||
      targets.join(',') !== guids.join(',')
    )
      closeRef.current();
  }, [state.documentRevision, state.preview?.id, guids.join(',')]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busy) closeRef.current();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [busy]);
  const count = result?.meshes.reduce((n, mesh) => n + mesh.vertices.length, 0) || 0,
    triangles = result?.meshes.reduce((n, mesh) => n + mesh.indices.length / 3, 0) || 0,
    before = initial
      .document!.objects.filter((o) => targets.includes(o.guid))
      .reduce((n, o) => n + o.vertexCount, 0);
  return (
    <form
      ref={form}
      className="automatic-mesh-window"
      role="dialog"
      aria-modal="false"
      aria-label={t('autoMesh')}
      style={{ left: position.left, top: position.top }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!result || pending || busy || error) return;
        setBusy(true);
        perform(async () => {
          try {
            await window.lattice.command({
              type: 'automaticMesh',
              guids: targets,
              settings,
              expectedRevision: state.revision,
            });
            closeRef.current();
          } finally {
            setBusy(false);
          }
        });
      }}
    >
      <header
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button') || event.button !== 0) return;
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
                window.innerWidth - (form.current?.offsetWidth || 340) - 8,
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
        <h2>{t('autoMesh')}</h2>
        <button type="button" aria-label={t('autoMeshClose')} disabled={busy} onClick={close}>
          <X size={16} />
        </button>
      </header>
      <div className="automatic-mesh-body">
        <AutomaticMeshPresets settings={settings} change={setSettings} disabled={busy} />
        <fieldset disabled={busy}>
          {(Object.keys(automaticMeshFields) as (keyof AutomaticMeshSettings)[]).map((key) => (
            <label className="automatic-mesh-setting" key={key}>
              <span>{t(key)}</span>
              <input
                type="number"
                aria-label={t(key)}
                {...automaticMeshFields[key]}
                step={1}
                value={settings[key]}
                onChange={(event) =>
                  setSettings((s) => ({ ...s, [key]: Number(event.target.value) }))
                }
              />
            </label>
          ))}
        </fieldset>
        <label className="automatic-mesh-toggle">
          <input
            type="checkbox"
            checked={showPreview}
            onChange={(event) => setShowPreview(event.target.checked)}
          />
          {t('autoMeshLivePreview')}
        </label>
        <p className="automatic-mesh-hint">{t('autoMeshPreviewHint')}</p>
        {initial.project?.textureMode === 'atlas' && (
          <p className="automatic-mesh-hint">{t('autoMeshSourceMode')}</p>
        )}
        <div
          className="automatic-mesh-status"
          role="status"
          aria-live="polite"
          data-testid="automatic-mesh-status"
          data-vertices={count}
          data-triangles={triangles}
          data-pending={pending}
        >
          {pending ? (
            t('autoMeshGenerating')
          ) : error ? (
            <span role="alert">{error}</span>
          ) : (
            <>
              <strong>
                {before} → {count}
              </strong>{' '}
              {t('vertices')}
              <span>
                {targets.length} {t('autoMeshObjects')} · {triangles} {t('autoMeshTriangles')}
              </span>
            </>
          )}
        </div>
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={close}>
          {t('cancel')}
        </button>
        <button className="primary" type="submit" disabled={busy || pending || !result || !!error}>
          {busy ? t('atlasApplying') : t('apply')}
        </button>
      </footer>
    </form>
  );
}
