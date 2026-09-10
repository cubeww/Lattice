import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Plus,
  Copy,
  Trash2,
  ArrowUp,
  ArrowDown,
  Undo2,
  Redo2,
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  Save,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  PhysicsEdit,
  PhysicsGroup,
  PhysicsSettings as Settings,
} from '../../../shared/physics';
import { duplicatePhysicsGroup } from '../../../shared/physics';
import {
  newPhysicsGroup,
  physicsPresets,
  type PhysicsPreset,
} from '../../../shared/physics-presets';
import { readPhysicsMotion, type PhysicsMotion } from '../../../core/physics/motion';
import type { EditorCommand } from '../../../shared/types';
import { useEditor } from '../store';
import { IconButton } from '../components';
import { PhysicsModal, PhysicsNumber, PhysicsText, reorder } from './fields';
import { modelPresetLabels } from './Presets';
import { ParameterPicker } from './ParameterPicker';
import { PhysicsPreview, type PhysicsPreviewHandle, type PhysicsPlayback } from './PhysicsPreview';
import { PhysicsGroupEditor } from './PhysicsGroupEditor';
import './physics.css';

export function PhysicsSettings({ close }: { close: () => void }) {
  const { state, t } = useEditor();
  const model = state.document!,
    settings = model.physics;
  const current = useRef(state);
  if (state.revision > current.current.revision) current.current = state;
  const pending = useRef(Promise.resolve()),
    pendingCount = useRef(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [selected, setSelected] = useState(settings.groups[0]?.guid || '');
  const group = settings.groups.find((g) => g.guid === selected) || settings.groups[0];
  const [picker, setPicker] = useState<'input' | 'output' | null>(null),
    [manage, setManage] = useState(false),
    [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState(''),
    [inputPreset, setInputPreset] = useState<'head' | 'body' | 'none'>('head'),
    [modelPreset, setModelPreset] = useState<PhysicsPreset | 'none'>('hairShort');
  const [disabled, setDisabled] = useState<string[]>([]),
    [collectPeaks, setCollectPeaks] = useState(true);
  const handle = useRef<PhysicsPreviewHandle | null>(null);
  const [playback, setPlayback] = useState<PhysicsPlayback>({
    playing: false,
    simulate: true,
    pattern: 'A',
    speed: 1,
    loop: true,
    interval: 0,
    fade: 1000,
    fading: false,
    track: true,
  });
  const [motions, setMotions] = useState<PhysicsMotion[]>([]),
    [playlist, setPlaylist] = useState(false),
    [shuffle, setShuffle] = useState(false);
  const motionFile = useRef<HTMLInputElement>(null);
  const patchPlayback = (value: Partial<PhysicsPlayback>) =>
    setPlayback((p) => ({ ...p, ...value }));
  const run = (fn: () => Promise<unknown>) => {
    pendingCount.current++;
    setBusy(true);
    setError('');
    pending.current = pending.current
      .then(fn)
      .then(() => undefined)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        pendingCount.current--;
        if (!pendingCount.current) setBusy(false);
      });
  };
  const send = (command: EditorCommand) =>
    run(async () => {
      current.current = await window.lattice.command(command);
    });
  const edit = (make: (s: Settings) => PhysicsEdit[]) =>
    run(async () => {
      const s = current.current;
      if (s.preview?.id !== state.preview?.id || !s.document)
        throw new Error('The open model changed.');
      current.current = await window.lattice.command({
        type: 'editPhysics',
        edits: make(s.document.physics),
        expectedRevision: s.revision,
      });
    });
  const update = (fn: (g: PhysicsGroup) => PhysicsGroup, guid = group?.guid) => {
    if (!guid) return;
    edit((s) => {
      const g = s.groups.find((g) => g.guid === guid);
      if (!g) throw new Error('Physics group not found.');
      return [{ action: 'putGroup', group: fn(g) }];
    });
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('.physics-submodal-backdrop')) return;
      if (e.key === 'Escape') {
        if (!pendingCount.current) closeRef.current();
        e.preventDefault();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        ['z', 'y', 's'].includes(e.key.toLowerCase()) &&
        !(e.target as HTMLElement).matches('input,textarea')
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key.toLowerCase() === 's') run(() => window.lattice.saveDocument());
        else send({ type: e.key.toLowerCase() === 'y' || e.shiftKey ? 'redo' : 'undo' });
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const groupEnabled = (guid: string, checked: boolean) =>
    setDisabled((ids) => (checked ? ids.filter((id) => id !== guid) : [...ids, guid]));
  const duplicate = () => {
    if (group)
      edit((s) => {
        const g = duplicatePhysicsGroup(
          s.groups.find((g) => g.guid === group.guid)!,
          s.groups,
        );
        g.name += ` ${t('phCopy')}`;
        setSelected(g.guid);
        return [{ action: 'putGroup', group: g }];
      });
  };
  const removeGroup = () => {
    if (group) edit(() => [{ action: 'deleteGroup', guid: group.guid }]);
  };
  const moveGroup = (delta: number) => {
    if (group)
      edit((s) => [
        {
          action: 'reorderGroups',
          guids: reorder(
            s.groups,
            s.groups.findIndex((g) => g.guid === group.guid),
            delta,
          ).map((g) => g.guid),
        },
      ]);
  };
  const next = () => {
    if (!motions.length) return;
    const i = motions.findIndex((m) => m.id === playback.pattern);
    patchPlayback({
      pattern:
        motions[shuffle ? Math.floor(Math.random() * motions.length) : (i + 1) % motions.length].id,
    });
    handle.current?.resetTime();
  };
  return createPortal(
    <div className="physics-backdrop">
      <section
        className="physics-window"
        role="dialog"
        aria-modal="true"
        aria-label={t('physicsSettings')}
      >
        <div className="physics-title">
          <SlidersHorizontal size={18} />
          <strong>{t('physicsSettings')}</strong>
          <span className="physics-model-name">{model.name}</span>
          <div className="physics-title-actions">
            <IconButton
              icon={Undo2}
              label={t('undo')}
              disabled={!state.canUndo || busy}
              onClick={() => send({ type: 'undo' })}
            />
            <IconButton
              icon={Redo2}
              label={t('redo')}
              disabled={!state.canRedo || busy}
              onClick={() => send({ type: 'redo' })}
            />
            <IconButton
              icon={Save}
              label={t('save')}
              disabled={busy}
              onClick={() => run(() => window.lattice.saveDocument())}
            />
            <IconButton icon={X} label={t('phClose')} disabled={busy} onClick={close} />
          </div>
        </div>
        <div className="physics-playbar">
          <select
            aria-label={t('phPattern')}
            value={playback.pattern}
            onChange={(e) => patchPlayback({ pattern: e.target.value })}
          >
            <option value="manual">{t('phManual')}</option>
            <option value="A">{t('phPatternA')}</option>
            <option value="B">{t('phPatternB')}</option>
            <option value="C">{t('phPatternC')}</option>
            <option value="sweep">{t('phSweep')}</option>
            {motions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <IconButton
            icon={playback.playing ? Pause : Play}
            label={t(playback.playing ? 'phPause' : 'phPlay')}
            disabled={playback.pattern === 'manual'}
            onClick={() => {
              if (playback.playing) handle.current?.pauseMotion();
              patchPlayback({ playing: !playback.playing });
            }}
          />
          <IconButton
            icon={SkipForward}
            label={t('phNext')}
            disabled={!motions.length}
            onClick={next}
          />
          <IconButton
            icon={RotateCcw}
            label={t('phReset')}
            onClick={() => {
              handle.current?.reset();
              handle.current?.resetTime();
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={playback.loop}
              onChange={(e) => patchPlayback({ loop: e.target.checked })}
            />
            {t('phLoop')}
          </label>
          <label>
            {t('phSpeed')}
            <select
              value={playback.speed}
              onChange={(e) => patchPlayback({ speed: Number(e.target.value) })}
            >
              {[0.25, 0.5, 1, 1.5, 2].map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={playback.fading}
              onChange={(e) => patchPlayback({ fading: e.target.checked })}
            />
            {t('phFading')}
          </label>
          <PhysicsNumber
            value={playback.fade}
            min={0}
            max={10000}
            step={100}
            title={t('phFadeTime')}
            onCommit={(v) => patchPlayback({ fade: v })}
          />
          <label>
            {t('phInterval')}
            <PhysicsNumber
              value={playback.interval}
              min={0}
              max={60000}
              step={100}
              onCommit={(v) => patchPlayback({ interval: v })}
            />
          </label>
          <span className="physics-spacer" />
          <button onClick={() => setPlaylist(!playlist)}>{t('phPlaylist')}</button>
          <label>
            <input
              type="checkbox"
              checked={playback.simulate}
              onChange={(e) => patchPlayback({ simulate: e.target.checked })}
            />
            {t('phSimulation')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={playback.track}
              onChange={(e) => patchPlayback({ track: e.target.checked })}
            />
            {t('phTrack')}
          </label>
        </div>
        <div className="physics-body">
          <section className="physics-editor">
            <div className="physics-groupbar">
              <label>
                {t('phFps')}
                <PhysicsNumber
                  value={settings.fps}
                  min={1}
                  max={240}
                  step={1}
                  onCommit={(fps) => edit(() => [{ action: 'setFps', fps: Math.round(fps) }])}
                />
              </label>
              <select
                aria-label={t('phGroup')}
                value={group?.guid || ''}
                onChange={(e) => {
                  setSelected(e.target.value);
                }}
              >
                {!group && <option value="">{t('phGroup')}</option>}
                {settings.groups.map((g) => (
                  <option key={g.guid} value={g.guid}>
                    {g.name}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  disabled={!group}
                  checked={!!group && !disabled.includes(group.guid)}
                  onChange={(e) => groupEnabled(group.guid, e.target.checked)}
                />
                {t('phEnable')}
              </label>
              <IconButton
                icon={Plus}
                label={t('phAddGroup')}
                onClick={() => {
                  setNewName(`${t('phGroup')} ${settings.groups.length + 1}`);
                  setAdding(true);
                }}
              />
              <IconButton
                icon={Copy}
                label={t('phDuplicate')}
                disabled={!group}
                onClick={duplicate}
              />
              <button onClick={() => setManage(true)}>{t('phGroups')}</button>
            </div>
            <PhysicsGroupEditor
              group={group}
              update={update}
              handle={handle}
              collectPeaks={collectPeaks}
              setCollectPeaks={setCollectPeaks}
              setPicker={setPicker}
              setError={setError}
            />
          </section>
          <PhysicsPreview
            settings={settings}
            disabled={disabled}
            collectPeaks={collectPeaks}
            playback={playback}
            motions={motions}
            handle={handle}
            stop={() => {
              if (playback.playing) handle.current?.pauseMotion();
              patchPlayback({ playing: false });
            }}
            next={next}
          />
        </div>
        <div className="physics-bottom">
          <span
            className={error ? 'physics-warning' : 'physics-muted'}
            role={error ? 'alert' : undefined}
          >
            {error || t('phTemporary')}
          </span>
          <button
            disabled={busy}
            onClick={() => run(() => window.lattice.physicsFileDialog('import', 'replace'))}
          >
            {t('phImport')}
          </button>
          <button
            disabled={busy}
            onClick={() => run(() => window.lattice.physicsFileDialog('import', 'append'))}
          >
            {t('phAppend')}
          </button>
          <button
            title={t('phExportHint')}
            disabled={busy || !settings.groups.length}
            onClick={() => run(() => window.lattice.physicsFileDialog('export'))}
          >
            {t('phExport')}
          </button>
        </div>
        {picker && group && (
          <ParameterPicker
            output={picker === 'output'}
            excluded={(picker === 'input' ? group.inputs : group.outputs).map((p) => p.parameterId)}
            close={() => setPicker(null)}
            accept={(ids) =>
              update((g) =>
                picker === 'input'
                  ? {
                      ...g,
                      inputs: [
                        ...g.inputs,
                        ...ids.map((parameterId) => ({
                          guid: crypto.randomUUID(),
                          parameterId,
                          type: 'X' as const,
                          weight:
                            Math.max(
                              0,
                              100 -
                                g.inputs
                                  .filter((i) => i.type === 'X')
                                  .reduce((s, i) => s + i.weight, 0),
                            ) / ids.length,
                          reflect: false,
                        })),
                      ],
                    }
                  : {
                      ...g,
                      outputs: [
                        ...g.outputs,
                        ...ids.map((parameterId) => ({
                          guid: crypto.randomUUID(),
                          parameterId,
                          type: 'Angle' as const,
                          vertexIndex: g.particles.length - 1,
                          weight: 100,
                          scale: 1,
                          reflect: false,
                        })),
                      ],
                    },
              )
            }
          />
        )}
        {adding && (
          <PhysicsModal title={t('phAddGroup')} close={() => setAdding(false)}>
            <label>
              {t('phName')}
              <input
                autoFocus
                value={newName}
                maxLength={256}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            <label>
              {t('phInputPreset')}
              <select
                value={inputPreset}
                onChange={(e) => setInputPreset(e.target.value as typeof inputPreset)}
              >
                <option value="none">{t('phNone')}</option>
                <option value="head">{t('phHead')}</option>
                <option value="body">{t('phBody')}</option>
              </select>
            </label>
            <label>
              {t('phModelPreset')}
              <select
                value={modelPreset}
                onChange={(e) => setModelPreset(e.target.value as typeof modelPreset)}
              >
                <option value="none">{t('phNone')}</option>
                {Object.keys(physicsPresets).map((key) => (
                  <option key={key} value={key}>
                    {t(modelPresetLabels[key as PhysicsPreset])}
                  </option>
                ))}
              </select>
            </label>
            <div className="physics-dialog-footer">
              <button onClick={() => setAdding(false)}>{t('phCancel')}</button>
              <button
                className="primary"
                disabled={!newName.trim()}
                onClick={() => {
                  edit((s) => {
                    const g = newPhysicsGroup(
                      newName.trim(),
                      model.parameters.map((p) => p.id),
                      s.groups,
                      inputPreset,
                      modelPreset,
                    );
                    setSelected(g.guid);
                    return [{ action: 'putGroup', group: g }];
                  });
                  setAdding(false);
                }}
              >
                {t('phAdd')}
              </button>
            </div>
          </PhysicsModal>
        )}
        {manage && (
          <PhysicsModal title={t('phGroups')} close={() => setManage(false)} wide>
            <div className="physics-actions">
              <IconButton
                icon={Plus}
                label={t('phAddGroup')}
                onClick={() => {
                  setManage(false);
                  setNewName(`${t('phGroup')} ${settings.groups.length + 1}`);
                  setAdding(true);
                }}
              />
              <IconButton
                icon={Copy}
                label={t('phDuplicate')}
                disabled={!group}
                onClick={duplicate}
              />
              <IconButton
                icon={Trash2}
                label={t('phDelete')}
                disabled={!group}
                onClick={removeGroup}
              />
              <IconButton
                icon={ArrowUp}
                label={t('phUp')}
                disabled={!group || settings.groups[0] === group}
                onClick={() => moveGroup(-1)}
              />
              <IconButton
                icon={ArrowDown}
                label={t('phDown')}
                disabled={!group || settings.groups.at(-1) === group}
                onClick={() => moveGroup(1)}
              />
            </div>
            <div className="physics-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('phEnable')}</th>
                    <th>{t('phPriority')}</th>
                    <th>{t('phName')}</th>
                    <th>{t('phId')}</th>
                    <th>{t('phPendulum')}</th>
                    <th>{t('phInput')}</th>
                    <th>{t('phOutput')}</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.groups.map((g, i) => (
                    <tr
                      key={g.guid}
                      className={g.guid === group?.guid ? 'selected' : ''}
                      onClick={() => setSelected(g.guid)}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t('phEnable')}
                          checked={!disabled.includes(g.guid)}
                          onChange={(e) => groupEnabled(g.guid, e.target.checked)}
                        />
                      </td>
                      <td>{i + 1}</td>
                      <td>
                        <PhysicsText
                          value={g.name}
                          label={t('phName')}
                          onCommit={(name) => update((p) => ({ ...p, name }), g.guid)}
                        />
                      </td>
                      <td>
                        <PhysicsText
                          value={g.id}
                          label={t('phId')}
                          onCommit={(id) => update((p) => ({ ...p, id }), g.guid)}
                        />
                      </td>
                      <td>{Math.max(0, g.particles.length - 1)}</td>
                      <td>{g.inputs.length}</td>
                      <td>{g.outputs.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="physics-dialog-footer">
              <button onClick={() => setManage(false)}>{t('phClose')}</button>
            </div>
          </PhysicsModal>
        )}
        {playlist && (
          <PhysicsModal title={t('phPlaylist')} close={() => setPlaylist(false)}>
            <div className="physics-actions">
              <button onClick={() => motionFile.current?.click()}>{t('phLoadMotion')}</button>
              <label>
                <input
                  type="checkbox"
                  checked={shuffle}
                  onChange={(e) => setShuffle(e.target.checked)}
                />
                {t('phShuffle')}
              </label>
            </div>
            <input
              ref={motionFile}
              hidden
              type="file"
              accept=".json"
              multiple
              onChange={(e) => {
                const files = [...(e.target.files || [])];
                e.target.value = '';
                run(async () => {
                  const loaded: PhysicsMotion[] = [];
                  for (const file of files) {
                    if (file.size > 8 * 1024 * 1024) throw new Error('Motion exceeds 8 MiB.');
                    loaded.push(readPhysicsMotion(JSON.parse(await file.text()), file.name));
                  }
                  setMotions((m) => [...m, ...loaded]);
                  if (loaded[0]) patchPlayback({ pattern: loaded[0].id });
                });
              }}
            />
            <div className="physics-picker-list">
              {motions.map((m) => (
                <div className="physics-motion-row" key={m.id}>
                  <button
                    className={playback.pattern === m.id ? 'active' : ''}
                    onClick={() => patchPlayback({ pattern: m.id })}
                  >
                    {m.name} <small>{m.duration.toFixed(2)} s</small>
                  </button>
                  <IconButton
                    icon={ArrowUp}
                    label={t('phUp')}
                    onClick={() =>
                      setMotions((list) =>
                        reorder(
                          list,
                          list.findIndex((p) => p.id === m.id),
                          -1,
                        ),
                      )
                    }
                  />
                  <IconButton
                    icon={ArrowDown}
                    label={t('phDown')}
                    onClick={() =>
                      setMotions((list) =>
                        reorder(
                          list,
                          list.findIndex((p) => p.id === m.id),
                          1,
                        ),
                      )
                    }
                  />
                  <IconButton
                    icon={Trash2}
                    label={t('phRemoveMotion')}
                    onClick={() => {
                      setMotions((list) => list.filter((p) => p.id !== m.id));
                      if (playback.pattern === m.id)
                        patchPlayback({ pattern: 'A', playing: false });
                    }}
                  />
                </div>
              ))}
              {!motions.length && <p className="physics-muted">{t('phNoMotion')}</p>}
            </div>
            <div className="physics-dialog-footer">
              <button onClick={() => setPlaylist(false)}>{t('phClose')}</button>
            </div>
          </PhysicsModal>
        )}
      </section>
    </div>,
    window.document.body,
  );
}
