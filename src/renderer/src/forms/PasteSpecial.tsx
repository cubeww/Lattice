import { useState } from 'react';
import {
  formKinds,
  propertiesForKind,
  type FormKind,
  type PasteOptions,
  type PasteProperty,
  type PasteSettings,
} from '../../../shared/form-edit';
import { useEditor } from '../store';
import type { MessageKey } from '../i18n';
import { FormWindow } from './FormWindow';

const propertyLabels: Record<PasteProperty, MessageKey> = {
  vertices: 'pasteVertices',
  opacity: 'pasteOpacity',
  drawOrder: 'pasteDrawOrder',
  multiply: 'pasteMultiply',
  screen: 'pasteScreen',
  angle: 'pasteAngle',
  scale: 'pasteScale',
  pathWidth: 'pastePathWidth',
  pathColor: 'pastePathColor',
  pathOpacity: 'pastePathOpacity',
  pathCorner: 'pastePathCorner',
};
export const kindLabels: Record<FormKind, MessageKey> = {
  mesh: 'meshKind',
  artpath: 'artpathKind',
  rotation: 'rotationKind',
  warp: 'warpKind',
  part: 'partKind',
};
export function PasteSpecial({
  settings,
  change,
  close,
}: {
  settings: PasteSettings;
  change: (value: PasteSettings) => void;
  close: () => void;
}) {
  const { t, state } = useEditor(),
    [kind, setKind] = useState<FormKind>('mesh'),
    [manualCenter, setManualCenter] = useState(0);
  const options = settings[kind];
  const update = (value: Partial<PasteOptions>) =>
    change({ ...settings, [kind]: { ...options, ...value } });
  return (
    <FormWindow title={t('pasteSpecial')} palette close={close}>
      <div className="form-special-tabs" role="tablist">
        {formKinds.map((key) => (
          <button
            type="button"
            key={key}
            role="tab"
            aria-selected={key === kind}
            onClick={() => setKind(key)}
          >
            {t(kindLabels[key])}
          </button>
        ))}
      </div>
      <div className="form-window-body" role="tabpanel">
        {propertiesForKind[kind].map((key) => (
          <label className="radio-row" key={key}>
            <input
              type="checkbox"
              checked={options.properties.includes(key)}
              onChange={(e) =>
                update({
                  properties: e.target.checked
                    ? [...options.properties, key]
                    : options.properties.filter((p) => p !== key),
                })
              }
            />
            {t(propertyLabels[key])}
          </label>
        ))}
        {kind === 'rotation' && (
          <label className="radio-row form-indent">
            <input
              type="checkbox"
              checked={options.reverseAngle}
              disabled={!options.properties.includes('angle')}
              onChange={(e) => update({ reverseAngle: e.target.checked })}
            />
            {t('pasteReverseAngle')}
          </label>
        )}
        {kind !== 'part' && (
          <fieldset disabled={!options.properties.includes('vertices')}>
            <label className="radio-row">
              <input
                type="checkbox"
                checked={options.mirror !== 'none'}
                onChange={(e) => update({ mirror: e.target.checked ? 'horizontal' : 'none' })}
              />
              {t('pasteInvert')}
            </label>
            <fieldset className="form-indent" disabled={options.mirror === 'none'}>
              <label className="property">
                <span>{t('pasteAxis')}</span>
                <select
                  value={options.mirror === 'none' ? 'horizontal' : options.mirror}
                  onChange={(e) => update({ mirror: e.target.value as PasteOptions['mirror'] })}
                >
                  <option value="horizontal">{t('flipHorizontal')}</option>
                  <option value="vertical">{t('flipVertical')}</option>
                </select>
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="form-center"
                  checked={options.center === 'canvas'}
                  onChange={() => update({ center: 'canvas' })}
                />
                {t('pasteCanvasCenter')}{' '}
                <span className="form-muted">
                  (
                  {(state.document?.canvas[options.mirror === 'vertical' ? 'height' : 'width'] ||
                    0) / 2}
                  )
                </span>
              </label>
              <label className="radio-row">
                <input
                  type="radio"
                  name="form-center"
                  checked={options.center !== 'canvas'}
                  onChange={() => update({ center: manualCenter })}
                />
                {t('pasteManualCenter')}
              </label>
              <input
                aria-label={t('pasteManualCenter')}
                type="number"
                disabled={options.center === 'canvas'}
                min={-1e7}
                max={1e7}
                value={options.center === 'canvas' ? manualCenter : options.center}
                onChange={(e) => {
                  const center = e.target.valueAsNumber;
                  if (Number.isFinite(center)) {
                    setManualCenter(center);
                    update({ center });
                  }
                }}
              />
            </fieldset>
          </fieldset>
        )}
        <p className="form-hint">{t('pasteSpecialHint')}</p>
      </div>
    </FormWindow>
  );
}
