import { useState } from 'react';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { useEditor } from '../store';
import {
  automaticMeshFields,
  automaticMeshPresets,
  type AutomaticMeshSettings,
} from '../../../shared/automatic-mesh';
type SavedPreset = { id: string; name: string; settings: AutomaticMeshSettings };
const presetKey = 'lattice.automatic-mesh-presets';
export const validMeshSettings = (s: AutomaticMeshSettings) =>
  Object.entries(automaticMeshFields).every(([key, range]) => {
    const value = s?.[key as keyof AutomaticMeshSettings];
    return Number.isInteger(value) && value >= range.min && value <= range.max;
  });
function readPresets(): SavedPreset[] {
  try {
    const value = JSON.parse(localStorage.getItem(presetKey) || '[]');
    return Array.isArray(value)
      ? value.filter(
          (p) =>
            typeof p?.id === 'string' &&
            typeof p?.name === 'string' &&
            validMeshSettings(p.settings),
        )
      : [];
  } catch {
    return [];
  }
}
export function AutomaticMeshPresets({
  settings,
  change,
  disabled,
}: {
  settings: AutomaticMeshSettings;
  change: (s: AutomaticMeshSettings) => void;
  disabled: boolean;
}) {
  const { t } = useEditor(),
    [presets, setPresets] = useState(readPresets),
    [selected, setSelected] = useState(''),
    [name, setName] = useState<string | null>(null);
  const persist = (next: SavedPreset[]) => {
    localStorage.setItem(presetKey, JSON.stringify(next));
    setPresets(next);
  };
  const same = (s: AutomaticMeshSettings) =>
      Object.keys(automaticMeshFields).every(
        (key) =>
          s[key as keyof AutomaticMeshSettings] === settings[key as keyof AutomaticMeshSettings],
      ),
    builtIn = (Object.keys(automaticMeshPresets) as (keyof typeof automaticMeshPresets)[]).find(
      (key) => same(automaticMeshPresets[key]),
    ),
    saved = presets.find((p) => p.id === selected),
    value = saved ? selected : builtIn || 'custom';
  return (
    <>
      <div className="automatic-mesh-presets">
        <label>
          {t('autoMeshPreset')}
          <select
            aria-label={t('autoMeshPreset')}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              const key = event.target.value,
                preset = presets.find((p) => p.id === key);
              setSelected(preset ? key : '');
              change({
                ...(preset?.settings ||
                  automaticMeshPresets[key as keyof typeof automaticMeshPresets]),
              });
            }}
          >
            <option value="standard">{t('autoMeshStandard')}</option>
            <option value="little">{t('autoMeshLittle')}</option>
            <option value="heavy">{t('autoMeshHeavy')}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === selected && !same(p.settings) ? ' *' : ''}
              </option>
            ))}
            <option value="custom" disabled>
              {t('autoMeshCustom')}
            </option>
          </select>
        </label>
        <button
          type="button"
          title={t('autoMeshSavePreset')}
          aria-label={t('autoMeshSavePreset')}
          disabled={disabled || !validMeshSettings(settings)}
          onClick={() => setName('')}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          title={t('autoMeshOverwritePreset')}
          aria-label={t('autoMeshOverwritePreset')}
          disabled={disabled || !saved || !validMeshSettings(settings)}
          onClick={() =>
            persist(
              presets.map((p) => (p.id === selected ? { ...p, settings: { ...settings } } : p)),
            )
          }
        >
          <Save size={16} />
        </button>
        <button
          type="button"
          title={t('autoMeshDeletePreset')}
          aria-label={t('autoMeshDeletePreset')}
          disabled={disabled || !saved}
          onClick={() => {
            persist(presets.filter((p) => p.id !== selected));
            setSelected('');
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      {name !== null && (
        <div className="automatic-mesh-save">
          <input
            autoFocus
            aria-label={t('autoMeshPresetName')}
            placeholder={t('autoMeshPresetName')}
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => {
              const id = crypto.randomUUID();
              persist([...presets, { id, name: name.trim(), settings: { ...settings } }]);
              setSelected(id);
              setName(null);
            }}
          >
            {t('save')}
          </button>
          <button type="button" aria-label={t('cancel')} onClick={() => setName(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
