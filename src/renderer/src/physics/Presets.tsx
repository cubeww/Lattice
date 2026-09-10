import { useState } from 'react';
import { z } from 'zod';
import type { PhysicsGroup } from '../../../shared/physics';
import { physicsGroupSchema } from '../../../shared/physics';
import {
  physicsPresets,
  presetInputs,
  presetParticles,
  type PhysicsPreset,
} from '../../../shared/physics-presets';
import type { MessageKey } from '../i18n';
import { useEditor } from '../store';
import { PhysicsModal } from './fields';

export const modelPresetLabels: Record<PhysicsPreset, MessageKey> = {
  hairShort: 'phHairShort',
  hairLong: 'phHairLong',
  hairTwo: 'phHairTwo',
  hairThree: 'phHairThree',
  clothesLight: 'phClothesLight',
  clothesHeavy: 'phClothesHeavy',
  bustSmall: 'phBustSmall',
  bustLarge: 'phBustLarge',
  chainTen: 'phChainTen',
  chainTwenty: 'phChainTwenty',
};
interface SavedPreset {
  id: string;
  name: string;
  group: PhysicsGroup;
}
const storageKey = (kind: string) => `lattice.physics.presets.${kind}`;
export function PhysicsPresets({
  kind,
  group,
  update,
}: {
  kind: 'input' | 'model';
  group: PhysicsGroup;
  update: (fn: (g: PhysicsGroup) => PhysicsGroup) => void;
}) {
  const { state, t, perform } = useEditor();
  const [saved, setSaved] = useState<SavedPreset[]>(() => {
    try {
      return z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            group: physicsGroupSchema,
          }),
        )
        .parse(JSON.parse(localStorage.getItem(storageKey(kind)) || '[]'));
    } catch {
      return [];
    }
  });
  const [selected, setSelected] = useState(''),
    [dialog, setDialog] = useState<'save' | 'rename' | null>(null),
    [name, setName] = useState('');
  const store = (list: SavedPreset[]) => {
    localStorage.setItem(storageKey(kind), JSON.stringify(list));
    setSaved(list);
  };
  const current = saved.find((p) => p.id === selected);
  const apply = () =>
    perform(async () => {
      if (kind === 'input') {
        const inputs = current
          ? current.group.inputs.map((p) => ({ ...p, guid: crypto.randomUUID() }))
          : presetInputs(
              selected as 'head' | 'body',
              state.document!.parameters.map((p) => p.id),
            );
        const missing = inputs
          .filter((p) => !state.document!.parameters.some((q) => q.id === p.parameterId))
          .map((p) => p.parameterId);
        if (missing.length) throw new Error(`${t('phMissing')} ${missing.join(', ')}`);
        update((g) => ({
          ...g,
          inputs,
          normalization: current
            ? structuredClone(current.group.normalization)
            : {
                position: { min: -10, default: 0, max: 10 },
                angle: { min: -10, default: 0, max: 10 },
              },
        }));
      } else {
        const particles = current
          ? current.group.particles.map((p) => ({
              ...p,
              position: { ...p.position },
              guid: crypto.randomUUID(),
            }))
          : presetParticles(selected as PhysicsPreset);
        update((g) => ({
          ...g,
          particles,
          outputs: g.outputs.filter((o) => o.vertexIndex < particles.length),
        }));
      }
    });
  return (
    <div className="physics-presets">
      <div className="physics-inline">
        <span>{t('phPreset')}</span>
        <select
          aria-label={t(kind === 'input' ? 'phInputPreset' : 'phModelPreset')}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">{t('phNone')}</option>
          {kind === 'input' ? (
            <>
              <option value="head">{t('phHead')}</option>
              <option value="body">{t('phBody')}</option>
            </>
          ) : (
            Object.keys(physicsPresets).map((key) => (
              <option key={key} value={key}>
                {t(modelPresetLabels[key as PhysicsPreset])}
              </option>
            ))
          )}
          {saved.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button disabled={!selected} onClick={apply}>
          {t('phApply')}
        </button>
      </div>
      <div className="physics-actions">
        <button
          onClick={() => {
            setName(group.name);
            setDialog('save');
          }}
        >
          {t('phStore')}
        </button>
        <button
          disabled={!current}
          onClick={() =>
            store(
              saved.map((p) => (p.id === selected ? { ...p, group: structuredClone(group) } : p)),
            )
          }
        >
          {t('phOverwrite')}
        </button>
        <button
          disabled={!current}
          onClick={() => {
            setName(current!.name);
            setDialog('rename');
          }}
        >
          {t('phRename')}
        </button>
        <button
          disabled={!current}
          onClick={() => {
            store(saved.filter((p) => p.id !== selected));
            setSelected('');
          }}
        >
          {t('phDelete')}
        </button>
      </div>
      {dialog && (
        <PhysicsModal title={t('phPresetName')} close={() => setDialog(null)}>
          <input value={name} autoFocus maxLength={256} onChange={(e) => setName(e.target.value)} />
          <div className="physics-dialog-footer">
            <button onClick={() => setDialog(null)}>{t('phCancel')}</button>
            <button
              className="primary"
              disabled={!name.trim()}
              onClick={() => {
                if (dialog === 'save') {
                  const id = crypto.randomUUID();
                  store([...saved, { id, name: name.trim(), group: structuredClone(group) }]);
                  setSelected(id);
                } else
                  store(saved.map((p) => (p.id === selected ? { ...p, name: name.trim() } : p)));
                setDialog(null);
              }}
            >
              {t('save')}
            </button>
          </div>
        </PhysicsModal>
      )}
    </div>
  );
}
