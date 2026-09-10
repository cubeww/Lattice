import { useEffect, useRef, useState } from 'react';
import type { SourceScene } from '../../../shared/scene';
import type { Parameter } from '../../../shared/types';
import {
  motionMirroringErrors,
  MotionMirroringError,
  type MotionMirroring,
} from '../../../shared/motion-mirroring';
import { motionMirrorCenter, motionMirroringPlan } from '../../../core/model/motion-mirroring';
import { useEditor } from '../store';
import { Dialog } from './ParameterDialogs';

export function MotionMirroringDialog({
  parameter,
  close,
}: {
  parameter: Parameter;
  close: () => void;
}) {
  const { state, t } = useEditor();
  const [initial] = useState(state);
  const document = initial.document!;
  const [direction, setDirection] = useState<MotionMirroring['direction']>(() =>
    localStorage.getItem('lattice.motionMirroring.direction') === 'vertical'
      ? 'vertical'
      : 'horizontal',
  );
  const [axisType, setAxisType] = useState<MotionMirroring['axis']['type']>('canvas');
  const [guideGuid, setGuideGuid] = useState(
    () => document.guides.find((g) => g.direction !== direction)?.guid || '',
  );
  const rotations = document.objects.filter((o) => o.kind === 'rotation');
  const [rotationGuid, setRotationGuid] = useState(rotations[0]?.guid || '');
  const [data, setData] = useState<{
    scene: SourceScene;
    plan: ReturnType<typeof motionMirroringPlan>;
  } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const current = useRef(state),
    closeRef = useRef(close);
  current.current = state;
  closeRef.current = close;
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const response = await fetch(initial.preview!.sceneUrl, { signal: abort.signal });
      if (!response.ok) throw new Error(t('motionSceneChanged'));
      const scene: SourceScene & { revision: number } = await response.json();
      if (scene.revision !== initial.preview!.revision) throw new Error(t('motionSceneChanged'));
      const plan = motionMirroringPlan(
        document,
        scene,
        initial.selectedGuids,
        parameter.id,
        initial.parameterValues,
      );
      if (!abort.signal.aborted) setData({ scene, plan });
    })().catch((error) => {
      if (!abort.signal.aborted) setLoadError(error);
    });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (
      state.documentRevision !== initial.documentRevision ||
      state.preview?.id !== initial.preview?.id ||
      JSON.stringify(state.parameterValues) !== JSON.stringify(initial.parameterValues) ||
      JSON.stringify(state.selectedGuids) !== JSON.stringify(initial.selectedGuids)
    )
      closeRef.current();
  }, [state.documentRevision, state.preview?.id, state.parameterValues, state.selectedGuids]);
  const objects = initial.selectedGuids.map((guid) =>
    document.objects.find((o) => o.guid === guid)!,
  );
  const allDeformers = objects.every((o) => o.kind === 'rotation' || o.kind === 'warp');
  const guides = document.guides.filter((g) => g.direction !== direction);
  const value: MotionMirroring = {
    guids: initial.selectedGuids,
    parameterId: parameter.id,
    direction,
    axis:
      allDeformers || axisType === 'canvas'
        ? { type: 'canvas' }
        : axisType === 'guide'
          ? { type: 'guide', guid: guideGuid }
          : { type: 'rotation', guid: rotationGuid },
  };
  const formatError = (error: unknown) => {
    if (error instanceof MotionMirroringError)
      return `${error.objectId ? error.objectId + ': ' : ''}${t(error.code)}`;
    const message = (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': Error: /,
      '',
    );
    const code = (
      Object.keys(motionMirroringErrors) as (keyof typeof motionMirroringErrors)[]
    ).find((key) => message.includes(motionMirroringErrors[key]));
    return code ? message.replace(motionMirroringErrors[code], t(code)) : message;
  };
  let issue = loadError;
  if (data && !allDeformers) {
    try {
      motionMirrorCenter(document, data.scene, value, initial.parameterValues);
    } catch (error) {
      issue = error;
    }
  }
  const number = (n: number) =>
    new Intl.NumberFormat(state.locale, { maximumFractionDigits: 6 }).format(n);
  const sourceValue = initial.parameterValues[parameter.id] ?? parameter.default;
  return (
    <Dialog
      title={t('motionMirroring')}
      close={close}
      action={t('parameterSave')}
      valid={!!data && !issue}
      formatError={formatError}
      submit={async () => {
        if (
          current.current.documentRevision !== initial.documentRevision ||
          JSON.stringify(current.current.parameterValues) !==
            JSON.stringify(initial.parameterValues)
        )
          throw new Error(t('motionSceneChanged'));
        await window.lattice.command({
          type: 'mirrorMotion',
          value,
          expectedRevision: current.current.revision,
        });
        localStorage.setItem('lattice.motionMirroring.direction', direction);
      }}
    >
      <section className="motion-section">
        <h3>{t('motionTargets')}</h3>
        <ul className="motion-targets">
          {objects.map((o) => (
            <li key={o.guid}>
              <span>{o.name || o.id}</span>
              <small>{o.id}</small>
            </li>
          ))}
        </ul>
      </section>
      <section className="motion-section">
        <h3>{t('motionSourceParameter')}</h3>
        <div className="motion-parameter">
          <span>{parameter.name}</span>
          <code>{parameter.id}</code>
        </div>
        <div className="motion-values">
          <span>
            {t('motionSourceValue')}
            <strong>{number(sourceValue)}</strong>
          </span>
          <b aria-hidden="true">→</b>
          <span>
            {t('motionTargetValue')}
            <strong>{number(Math.fround(2 * parameter.default - sourceValue))}</strong>
          </span>
        </div>
      </section>
      <section className="motion-section">
        <h3>{t('motionDirection')}</h3>
        {(['horizontal', 'vertical'] as const).map((d) => (
          <label className="motion-option" key={d}>
            <input
              type="radio"
              name="motion-direction"
              value={d}
              checked={direction === d}
              onChange={() => {
                setDirection(d);
                setGuideGuid(document.guides.find((g) => g.direction !== d)?.guid || '');
              }}
            />
            {t(d === 'horizontal' ? 'motionHorizontal' : 'motionVertical')}
          </label>
        ))}
      </section>
      <section className="motion-section">
        <h3>{t('motionAxis')}</h3>
        <label className="motion-option">
          <input
            type="radio"
            name="motion-axis"
            checked={allDeformers || axisType === 'canvas'}
            disabled={allDeformers}
            onChange={() => setAxisType('canvas')}
          />
          {t('motionCanvasCenter')}
        </label>
        <label className="motion-option">
          <input
            type="radio"
            name="motion-axis"
            checked={!allDeformers && axisType === 'guide'}
            disabled={allDeformers || !guides.length}
            onChange={() => setAxisType('guide')}
          />
          {t('motionGuide')}
        </label>
        <select
          className="motion-axis-select"
          aria-label={t('motionGuide')}
          value={guideGuid}
          disabled={allDeformers || axisType !== 'guide'}
          onChange={(e) => setGuideGuid(e.target.value)}
        >
          {!guides.length && <option value="">{t('motionNoGuides')}</option>}
          {guides.map((g) => (
            <option key={g.guid} value={g.guid}>
              {g.number} · {number(g.position)} px
            </option>
          ))}
        </select>
        <label className="motion-option">
          <input
            type="radio"
            name="motion-axis"
            checked={!allDeformers && axisType === 'rotation'}
            disabled={allDeformers || !rotations.length}
            onChange={() => setAxisType('rotation')}
          />
          {t('motionRotationCenter')}
        </label>
        <select
          className="motion-axis-select"
          aria-label={t('motionRotationCenter')}
          value={rotationGuid}
          disabled={allDeformers || axisType !== 'rotation'}
          onChange={(e) => setRotationGuid(e.target.value)}
        >
          {!rotations.length && <option value="">{t('motionNoRotations')}</option>}
          {rotations.map((d) => (
            <option key={d.guid} value={d.guid}>
              {d.name || d.id}
            </option>
          ))}
        </select>
        {allDeformers && <p className="parameter-dialog-hint">{t('motionDeformerAxisHint')}</p>}
      </section>
      {data && (
        <p className="parameter-dialog-hint">
          {t('motionNewKeys')}: {data.plan.nodes.length - data.plan.existingTargets} ·{' '}
          {t('motionOverwriteKeys')}: {data.plan.existingTargets}
        </p>
      )}
      {!!data?.plan.unselectedParents.length && (
        <p className="parameter-dialog-hint">
          {t('motionParentHint')}{' '}
          {data.plan.unselectedParents
            .map((id) => document.objects.find((o) => o.guid === id)?.name)
            .join(', ')}
        </p>
      )}
      {issue ? (
        <p className="parameter-validation" role="alert">
          {formatError(issue)}
        </p>
      ) : (
        !data && <p className="parameter-dialog-hint">{t('motionLoading')}</p>
      )}
    </Dialog>
  );
}
