import { useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { ObjectProperties } from '../../../shared/inspector';
import { keyformProperties } from '../../../shared/inspector';
import { useEditor } from '../store';
import { Empty, IconButton } from '../components';
import type { MessageKey } from '../i18n';
import { PropertyCheck, PropertyInput } from '../inspector/PropertyInput';
import { ColorDialog, MaskDialog } from '../inspector/PropertyDialogs';
import '../inspector/inspector.css';
import { ProjectInspector } from '../project/ProjectInspector';

export function Inspector() {
  const { state, t } = useEditor();
  if (state.inspectorTarget === 'project' && state.project && state.document)
    return <ProjectInspector key={state.document.rootPartGuid} />;
  if (!state.inspector.length) return <Empty icon={SlidersHorizontal}>{t('selectHint')}</Empty>;
  // A focused draft belongs to one selection and pose. Never apply it to new objects.
  const scope = JSON.stringify([
    state.preview?.id,
    state.selectedGuids,
    state.parameterValues,
    state.inspector,
  ]);
  return (
    <div className="inspector panel-scroll" data-testid="inspector">
      <InspectorFields key={scope} />
    </div>
  );
}

function InspectorFields() {
  const { state, command, t } = useEditor(),
    items = state.inspector;
  const [dialog, setDialog] = useState<'clips' | 'multiply' | 'screen' | null>(null);
  const objects = state.document!.objects,
    selected = items.map((o) => o.guid);
  const supported = (key: keyof ObjectProperties) => items.every((o) => key in o.values);
  const common = <K extends keyof ObjectProperties>(key: K): ObjectProperties[K] | undefined => {
    const first = items[0].values[key];
    return items.every((o) => JSON.stringify(o.values[key]) === JSON.stringify(first))
      ? first
      : undefined;
  };
  const disabled = (key: keyof ObjectProperties) =>
    !state.previewReady ||
    items.some(
      (o) =>
        o.locked ||
        (keyformProperties.has(key) &&
          !o.keyformGuid &&
          !(key === 'drawOrder' && o.kind === 'part' && o.keyformCount === 0)),
    );
  const edit = (values: ObjectProperties) =>
    command({
      type: 'editObjectProperties',
      guids: selected,
      values,
      expectedRevision: state.revision,
    });
  const number = (
    key: keyof ObjectProperties,
    label: MessageKey,
    min: number,
    max: number,
    factor = 1,
    step?: number,
  ) => {
    if (!supported(key)) return null;
    const value = common(key) as number | undefined;
    return (
      <PropertyInput
        key={key}
        label={t(label)}
        value={value === undefined ? undefined : Number((value * factor).toFixed(3))}
        disabled={disabled(key)}
        min={min}
        max={max}
        step={step}
        unit={factor === 100 ? '%' : key === 'angle' ? '°' : undefined}
        commit={(text) => edit({ [key]: Number(text) / factor })}
      />
    );
  };
  const check = (
    key: 'inverted' | 'culling' | 'drawOrderGroup' | 'guideImage',
    label: MessageKey,
  ) =>
    supported(key) && (
      <PropertyCheck
        label={t(label)}
        value={common(key)}
        disabled={disabled(key)}
        commit={(value) => edit({ [key]: value })}
      />
    );
  const descendants = (guid: string, key: 'parentGuid' | 'deformerGuid') => {
    const seen = new Set<string>();
    let current: string | null | undefined = guid;
    while (current && !seen.has(current)) {
      if (selected.includes(current)) return true;
      seen.add(current);
      current = objects.find((o) => o.guid === current)?.[key];
    }
    return false;
  };
  const parent = (key: 'parentGuid' | 'deformerGuid', label: MessageKey) => {
    if (!supported(key)) return null;
    const root = key === 'parentGuid' ? state.document!.rootPartGuid : null;
    const value = common(key),
      candidates = objects.filter(
        (o) =>
          (key === 'parentGuid' ? o.kind === 'part' : ['warp', 'rotation'].includes(o.kind)) &&
          o.guid !== root &&
          !descendants(o.guid, key),
      );
    return (
      <label className="inspector-property">
        <span>{t(label)}</span>
        <select
          aria-label={t(label)}
          value={value === undefined ? '__mixed' : value === root ? '' : value || ''}
          disabled={disabled(key)}
          onChange={(e) => edit({ [key]: e.target.value || null })}
        >
          {value === undefined && (
            <option value="__mixed" disabled>
              {t('inspectorMixed')}
            </option>
          )}
          <option value="">{t('inspectorRoot')}</option>
          {candidates.map((o) => (
            <option key={o.guid} value={o.guid} disabled={o.locked}>
              {o.name || o.id}
            </option>
          ))}
        </select>
      </label>
    );
  };
  const kind: Record<string, MessageKey> = {
    part: 'partKind',
    mesh: 'meshKind',
    rotation: 'rotationKind',
    warp: 'warpKind',
    artpath: 'artpathKind',
    glue: 'glue',
  };
  const colors = (['multiply', 'screen'] as const).filter(supported);
  const hasAppearance = ['drawOrder', 'opacity', 'intensity'].some((k) =>
    supported(k as keyof ObjectProperties),
  );
  const masks = common('clips');
  return (
    <>
      <div className="object-heading">
        <span className={`kind-dot ${items[0].kind}`} />
        {items.length === 1 ? t(kind[items[0].kind]) : `${items.length} ${t('inspectorSelection')}`}
        <span className="muted">
          {items.reduce((n, o) => n + o.keyformCount, 0)} {t('keyforms')}
        </span>
      </div>
      <PropertyInput
        label={t('name')}
        value={common('name')}
        maxLength={256}
        disabled={disabled('name')}
        commit={(name) => edit({ name })}
      />
      <PropertyInput
        label={t('id')}
        value={common('id')}
        maxLength={256}
        pattern="[A-Za-z_][A-Za-z0-9_]*"
        disabled={items.length !== 1 || disabled('id')}
        commit={(id) => edit({ id })}
      />
      {parent('parentGuid', 'part')}
      {parent('deformerGuid', 'deformer')}
      {check('drawOrderGroup', 'inspectorGrouped')}
      {check('guideImage', 'inspectorGuide')}
      {hasAppearance && <h3>{t('inspectorAppearance')}</h3>}
      {items.some((o) => !o.keyformGuid && !(o.kind === 'part' && o.keyformCount === 0)) && (
        <p className="inspector-notice">{t('inspectorKeyHint')}</p>
      )}
      {items.some((o) => o.locked) && <p className="inspector-notice">{t('lockedSelection')}</p>}
      {number('drawOrder', 'drawOrder', 0, 1000, 1, 1)}
      {number('opacity', 'inspectorOpacity', 0, 100, 100)}
      {number('intensity', 'inspectorIntensity', 0, 100, 100)}
      {colors.map((key) => (
        <div className="inspector-color-row" key={key}>
          <PropertyInput
            label={t(key === 'multiply' ? 'inspectorMultiply' : 'inspectorScreen')}
            value={common(key)}
            maxLength={7}
            pattern="#[a-fA-F0-9]{6}"
            disabled={disabled(key)}
            commit={(color) => edit({ [key]: color })}
          />
          <button
            className="inspector-swatch"
            aria-label={`${t('inspectorColor')} · ${t(key === 'multiply' ? 'inspectorMultiply' : 'inspectorScreen')}`}
            style={{ background: common(key) }}
            disabled={disabled(key)}
            onClick={() => setDialog(key)}
          />
          <IconButton
            icon={RotateCcw}
            label={`${t('inspectorResetColor')} · ${t(key === 'multiply' ? 'inspectorMultiply' : 'inspectorScreen')}`}
            disabled={disabled(key)}
            onClick={() => edit({ [key]: key === 'multiply' ? '#FFFFFF' : '#000000' })}
          />
        </div>
      ))}
      {supported('blend') && (
        <label className="inspector-property">
          <span>{t('inspectorBlend')}</span>
          <select
            aria-label={t('inspectorBlend')}
            value={common('blend') ?? '__mixed'}
            disabled={disabled('blend')}
            onChange={(e) => edit({ blend: e.target.value as ObjectProperties['blend'] })}
          >
            {common('blend') === undefined && (
              <option value="__mixed" disabled>
                {t('inspectorMixed')}
              </option>
            )}
            <option value="normal">{t('inspectorNormal')}</option>
            <option value="add">{t('inspectorAdd')}</option>
            <option value="multiply">{t('inspectorMultiplyBlend')}</option>
          </select>
        </label>
      )}
      {check('culling', 'inspectorCulling')}
      {supported('clips') && (
        <div className="inspector-property">
          <span>{t('inspectorClips')}</span>
          <button
            className="inspector-mask-button"
            aria-label={t('inspectorChooseMasks')}
            disabled={disabled('clips')}
            onClick={() => setDialog('clips')}
          >
            {masks === undefined
              ? t('inspectorMixed')
              : masks.map((id) => objects.find((o) => o.guid === id)?.id || id).join(', ') ||
                t('none')}
          </button>
        </div>
      )}
      {check('inverted', 'inspectorInvert')}
      {(supported('angle') || supported('columns')) && <h3>{t('inspectorGeometry')}</h3>}
      {number('angle', 'inspectorAngle', -3600, 3600)}
      {supported('baseAngle') && (
        <div className="inspector-property">
          <span>{t('inspectorBase')}</span>
          <output>{common('baseAngle') ?? t('inspectorMixed')}°</output>
        </div>
      )}
      {supported('baseAngle') && items.length === 1 && (
        <button
          className="inspector-action"
          disabled={disabled('angle') || !common('angle')}
          title={t('inspectorFreezeHint')}
          onClick={() => edit({ baseAngle: common('baseAngle')! + common('angle')! })}
        >
          {t('inspectorFreeze')}
        </button>
      )}
      {number('scale', 'inspectorScale', 0.1, 10000, 100)}
      {number('columns', 'inspectorColumns', 1, 32, 1, 1)}
      {number('rows', 'inspectorRows', 1, 32, 1, 1)}
      {number('bezierColumns', 'inspectorBezierColumns', 1, 8, 1, 1)}
      {number('bezierRows', 'inspectorBezierRows', 1, 8, 1, 1)}
      {supported('userData') && (
        <details className="inspector-data">
          <summary>{t('inspectorUserData')}</summary>
          <PropertyInput
            label={t('inspectorUserData')}
            value={common('userData')}
            maxLength={16384}
            multiline
            disabled={disabled('userData')}
            commit={(userData) => edit({ userData })}
          />
        </details>
      )}
      {!!items.reduce((n, o) => n + o.vertexCount, 0) && (
        <div className="inspector-stats">
          {t('vertices')} <span>{items.reduce((n, o) => n + o.vertexCount, 0)}</span>
        </div>
      )}
      {dialog === 'clips' && (
        <MaskDialog
          objects={objects.filter(
            (o) => ['mesh', 'artpath'].includes(o.kind) && !selected.includes(o.guid),
          )}
          selected={masks || []}
          apply={(clips) => edit({ clips })}
          close={() => setDialog(null)}
        />
      )}
      {(dialog === 'multiply' || dialog === 'screen') && (
        <ColorDialog
          initial={common(dialog) || (dialog === 'multiply' ? '#FFFFFF' : '#000000')}
          apply={(color) => edit({ [dialog]: color })}
          close={() => setDialog(null)}
        />
      )}
    </>
  );
}
