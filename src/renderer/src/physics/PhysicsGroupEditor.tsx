import { useEffect, useRef, useState, type RefObject } from 'react';
import { Plus, Copy, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import type { PhysicsGroup, PhysicsType } from '../../../shared/physics';
import { presetParticles } from '../../../shared/physics-presets';
import { useEditor } from '../store';
import { IconButton } from '../components';
import { PhysicsNumber, reorder } from './fields';
import { PhysicsPresets } from './Presets';
import { PendulumView, type PhysicsPreviewHandle } from './PhysicsPreview';
export function PhysicsGroupEditor({
  group,
  update,
  handle,
  collectPeaks,
  setCollectPeaks,
  setPicker,
  setError,
}: {
  group?: PhysicsGroup;
  update: (fn: (g: PhysicsGroup) => PhysicsGroup) => void;
  handle: RefObject<PhysicsPreviewHandle | null>;
  collectPeaks: boolean;
  setCollectPeaks: (v: boolean) => void;
  setPicker: (v: 'input' | 'output') => void;
  setError: (v: string) => void;
}) {
  const { state, t } = useEditor(),
    model = state.document!;
  const outputTable = useRef<HTMLTableElement>(null);
  const [tab, setTab] = useState<'input' | 'output'>('input');
  const [inputRow, setInputRow] = useState(''),
    [outputRow, setOutputRow] = useState(''),
    [particleRow, setParticleRow] = useState('');
  useEffect(() => {
    setInputRow('');
    setOutputRow('');
    setParticleRow('');
  }, [group?.guid]);
  useEffect(() => {
    const timer = setInterval(
      () =>
        outputTable.current?.querySelectorAll<HTMLElement>('[data-physics-peak]').forEach((el) => {
          const peak = handle.current?.runtime.peaks[el.dataset.physicsPeak!];
          el.textContent = `${(peak?.percent || 0).toFixed(2)}%`;
          el.classList.toggle('physics-overflow', !!peak?.clipped);
        }),
      100,
    );
    return () => clearInterval(timer);
  }, []);
  const rowActions = (kind: 'input' | 'output' | 'particle') => {
    const list =
      kind === 'input'
        ? group?.inputs
        : kind === 'output'
          ? group?.outputs
          : group?.particles.slice(1);
    const selection = kind === 'input' ? inputRow : kind === 'output' ? outputRow : particleRow;
    const index = list?.findIndex((p) => p.guid === selection) ?? -1;
    const move = (delta: number) =>
      update((g) => {
        if (kind === 'input')
          return {
            ...g,
            inputs: reorder(
              g.inputs,
              g.inputs.findIndex((p) => p.guid === selection),
              delta,
            ),
          };
        if (kind === 'output')
          return {
            ...g,
            outputs: reorder(
              g.outputs,
              g.outputs.findIndex((p) => p.guid === selection),
              delta,
            ),
          };
        const old = g.particles,
          next = reorder(
            old,
            old.findIndex((p) => p.guid === selection),
            delta,
          );
        return {
          ...g,
          particles: next,
          outputs: g.outputs.map((o) => ({
            ...o,
            vertexIndex: next.findIndex((p) => p.guid === old[o.vertexIndex].guid),
          })),
        };
      });
    const remove = () =>
      update((g) => {
        if (kind === 'input') return { ...g, inputs: g.inputs.filter((p) => p.guid !== selection) };
        if (kind === 'output')
          return { ...g, outputs: g.outputs.filter((p) => p.guid !== selection) };
        const i = g.particles.findIndex((p) => p.guid === selection);
        return {
          ...g,
          particles: g.particles.filter((p) => p.guid !== selection),
          outputs: g.outputs
            .filter((o) => o.vertexIndex !== i)
            .map((o) => ({
              ...o,
              vertexIndex: o.vertexIndex > i ? o.vertexIndex - 1 : o.vertexIndex,
            })),
        };
      });
    return (
      <>
        <IconButton
          icon={Plus}
          label={t('phAdd')}
          disabled={!group || (kind === 'output' && group.particles.length < 2)}
          onClick={() => {
            if (kind !== 'particle') setPicker(kind);
            else
              update((g) => {
                const particle = {
                  guid: crypto.randomUUID(),
                  position: { x: 0, y: g.particles.reduce((s, p) => s + p.radius, 0) + 10 },
                  radius: 10,
                  mobility: 0.8,
                  delay: 1,
                  acceleration: 1,
                };
                setParticleRow(particle.guid);
                return {
                  ...g,
                  particles: [
                    ...(g.particles.length ? g.particles : presetParticles('none')),
                    particle,
                  ],
                };
              });
          }}
        />
        {kind === 'particle' && (
          <IconButton
            icon={Copy}
            label={t('phDuplicate')}
            disabled={index < 0}
            onClick={() =>
              update((g) => {
                const p = g.particles.find((p) => p.guid === selection)!;
                return {
                  ...g,
                  particles: [
                    ...g.particles,
                    {
                      ...p,
                      guid: crypto.randomUUID(),
                      position: {
                        x: 0,
                        y: g.particles.reduce((n, p) => n + p.radius, 0) + p.radius,
                      },
                    },
                  ],
                };
              })
            }
          />
        )}
        <IconButton icon={Trash2} label={t('phDelete')} disabled={index < 0} onClick={remove} />
        <IconButton
          icon={ArrowUp}
          label={t('phUp')}
          disabled={index <= 0}
          onClick={() => move(-1)}
        />
        <IconButton
          icon={ArrowDown}
          label={t('phDown')}
          disabled={index < 0 || index >= (list?.length || 0) - 1}
          onClick={() => move(1)}
        />
      </>
    );
  };
  const parameterSelect = (value: string, change: (id: string) => void) => (
    <select value={value} aria-label={t('phParameters')} onChange={(e) => change(e.target.value)}>
      {!model.parameters.some((p) => p.id === value) && <option value={value}>{value}</option>}
      {model.parameters.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  const typeSelect = (type: PhysicsType, change: (type: PhysicsType) => void) => (
    <select
      value={type}
      aria-label={t('phType')}
      onChange={(e) => change(e.target.value as PhysicsType)}
    >
      <option value="X">{t('phX')}</option>
      <option value="Y">{t('phY')}</option>
      <option value="Angle">{t('phAngle')}</option>
    </select>
  );
  const autoScale = (direction: 'increase' | 'decrease' | 'reset') => {
    const targets = group?.outputs.filter((o) => !outputRow || o.guid === outputRow) || [];
    const peaks = structuredClone(handle.current?.runtime.peaks || {});
    if (direction !== 'reset' && !targets.some((o) => (peaks[o.guid]?.percent || 0) > 0.0001)) {
      setError(t('phNoPeak'));
      return;
    }
    update((g) => ({
      ...g,
      outputs: g.outputs.map((o) => {
        if (!targets.some((p) => p.guid === o.guid)) return o;
        const peak = peaks[o.guid]?.percent || 0;
        if (direction === 'reset') return { ...o, scale: 1 };
        if (peak > 0.0001 && (direction === 'increase' ? peak < 100 : peak > 100))
          return { ...o, scale: Math.max(-100000, Math.min(100000, (o.scale * 100) / peak)) };
        return o;
      }),
    }));
  };

  return (
    <>
      {!group ? (
        <div className="physics-empty">{t('phEmpty')}</div>
      ) : (
        <>
          <div className="physics-tabs">
            <button className={tab === 'input' ? 'active' : ''} onClick={() => setTab('input')}>
              {t('phInput')}
            </button>
            <button className={tab === 'output' ? 'active' : ''} onClick={() => setTab('output')}>
              {t('phOutput')}
            </button>
          </div>
          <div className={`physics-upper ${tab}`}>
            {tab === 'input' ? (
              <>
                <div className="physics-input-options">
                  <PhysicsPresets kind="input" group={group} update={update} />
                  <fieldset>
                    <legend>{t('phNormalize')}</legend>
                    <table>
                      <thead>
                        <tr>
                          <th />
                          <th>{t('phMin')}</th>
                          <th>{t('phCenter')}</th>
                          <th>{t('phMax')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(['angle', 'position'] as const).map((kind) => (
                          <tr key={kind}>
                            <th>{t(kind === 'angle' ? 'phAngle' : 'phX')}</th>
                            {(['min', 'default', 'max'] as const).map((key) => (
                              <td key={key}>
                                <PhysicsNumber
                                  value={group.normalization[kind][key]}
                                  min={-10000}
                                  max={10000}
                                  onCommit={(v) =>
                                    update((g) => ({
                                      ...g,
                                      normalization: {
                                        ...g.normalization,
                                        [kind]: { ...g.normalization[kind], [key]: v },
                                      },
                                    }))
                                  }
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </fieldset>
                </div>
                <div className="physics-input-table">
                  <div className="physics-actions">{rowActions('input')}</div>
                  <div className="physics-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{t('phParameters')}</th>
                          <th>{t('phType')}</th>
                          <th>{t('phWeight')}</th>
                          <th>{t('phReflect')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.inputs.map((p) => (
                          <tr
                            key={p.guid}
                            className={inputRow === p.guid ? 'selected' : ''}
                            onClick={() => setInputRow(p.guid)}
                          >
                            <td>
                              {parameterSelect(p.parameterId, (parameterId) =>
                                update((g) => ({
                                  ...g,
                                  inputs: g.inputs.map((i) =>
                                    i.guid === p.guid ? { ...i, parameterId } : i,
                                  ),
                                })),
                              )}
                            </td>
                            <td>
                              {typeSelect(p.type, (type) =>
                                update((g) => ({
                                  ...g,
                                  inputs: g.inputs.map((i) =>
                                    i.guid === p.guid ? { ...i, type } : i,
                                  ),
                                })),
                              )}
                            </td>
                            <td>
                              <PhysicsNumber
                                value={p.weight}
                                min={0}
                                max={100}
                                step={1}
                                onCommit={(weight) =>
                                  update((g) => ({
                                    ...g,
                                    inputs: g.inputs.map((i) =>
                                      i.guid === p.guid ? { ...i, weight } : i,
                                    ),
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={t('phReflect')}
                                checked={p.reflect}
                                onChange={(e) => {
                                  const reflect = e.target.checked;
                                  update((g) => ({
                                    ...g,
                                    inputs: g.inputs.map((i) =>
                                      i.guid === p.guid ? { ...i, reflect } : i,
                                    ),
                                  }));
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(['X', 'Y', 'Angle'] as const)
                    .filter(
                      (type) =>
                        group.inputs
                          .filter((p) => p.type === type)
                          .reduce((sum, p) => sum + p.weight, 0) > 100.001,
                    )
                    .map((type) => (
                      <small className="physics-warning" key={type}>
                        {type}: {t('phWeightWarning')}
                      </small>
                    ))}
                </div>
              </>
            ) : (
              <>
                <div className="physics-output-table">
                  <div className="physics-actions">
                    {rowActions('output')}
                    <label>
                      <input
                        type="checkbox"
                        checked={collectPeaks}
                        onChange={(e) => setCollectPeaks(e.target.checked)}
                      />
                      {t('phAutoPeak')}
                    </label>
                  </div>
                  <div className="physics-table-scroll">
                    <table ref={outputTable}>
                      <thead>
                        <tr>
                          <th>{t('phPendulum')}</th>
                          <th>{t('phParameters')}</th>
                          <th>{t('phType')}</th>
                          <th>{t('phWeight')}</th>
                          <th>{t('phReflect')}</th>
                          <th>{t('phScale')}</th>
                          <th>{t('phMaximum')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.outputs.map((p) => (
                          <tr
                            key={p.guid}
                            className={outputRow === p.guid ? 'selected' : ''}
                            onClick={() => setOutputRow(p.guid)}
                          >
                            <td>
                              <select
                                aria-label={t('phPendulum')}
                                value={p.vertexIndex}
                                onChange={(e) => {
                                  const vertexIndex = Number(e.target.value);
                                  update((g) => ({
                                    ...g,
                                    outputs: g.outputs.map((i) =>
                                      i.guid === p.guid ? { ...i, vertexIndex } : i,
                                    ),
                                  }));
                                }}
                              >
                                {group.particles.slice(1).map((v, i) => (
                                  <option key={v.guid} value={i + 1}>
                                    {i + 1}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              {parameterSelect(p.parameterId, (parameterId) =>
                                update((g) => ({
                                  ...g,
                                  outputs: g.outputs.map((i) =>
                                    i.guid === p.guid ? { ...i, parameterId } : i,
                                  ),
                                })),
                              )}
                            </td>
                            <td>
                              {typeSelect(p.type, (type) =>
                                update((g) => ({
                                  ...g,
                                  outputs: g.outputs.map((i) =>
                                    i.guid === p.guid ? { ...i, type } : i,
                                  ),
                                })),
                              )}
                            </td>
                            <td>
                              <PhysicsNumber
                                value={p.weight}
                                min={0}
                                max={100}
                                step={1}
                                onCommit={(weight) =>
                                  update((g) => ({
                                    ...g,
                                    outputs: g.outputs.map((i) =>
                                      i.guid === p.guid ? { ...i, weight } : i,
                                    ),
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={t('phReflect')}
                                checked={p.reflect}
                                onChange={(e) => {
                                  const reflect = e.target.checked;
                                  update((g) => ({
                                    ...g,
                                    outputs: g.outputs.map((i) =>
                                      i.guid === p.guid ? { ...i, reflect } : i,
                                    ),
                                  }));
                                }}
                              />
                            </td>
                            <td>
                              <PhysicsNumber
                                value={p.scale}
                                onCommit={(scale) =>
                                  update((g) => ({
                                    ...g,
                                    outputs: g.outputs.map((i) =>
                                      i.guid === p.guid ? { ...i, scale } : i,
                                    ),
                                  }))
                                }
                              />
                            </td>
                            <td data-physics-peak={p.guid}>0.00%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!group.outputs.length && <p className="physics-muted">{t('phNoOutputs')}</p>}
                  </div>
                </div>
                <div className="physics-output-actions">
                  <button disabled={!group.outputs.length} onClick={() => autoScale('increase')}>
                    {t('phIncrease')}
                  </button>
                  <button disabled={!group.outputs.length} onClick={() => autoScale('decrease')}>
                    {t('phDecrease')}
                  </button>
                  <button disabled={!group.outputs.length} onClick={() => autoScale('reset')}>
                    {t('phResetScale')}
                  </button>
                  <button
                    onClick={() =>
                      handle.current?.runtime.resetPeaks(
                        group.outputs
                          .filter((p) => !outputRow || p.guid === outputRow)
                          .map((p) => p.guid),
                      )
                    }
                  >
                    {t('phResetPeak')}
                  </button>
                  <button onClick={() => setOutputRow('')}>{t('phAll')}</button>
                </div>
              </>
            )}
          </div>
          <div className="physics-lower">
            <div className="physics-particle-editor">
              <PhysicsPresets kind="model" group={group} update={update} />
              <fieldset>
                <legend>{t('phPendulums')}</legend>
                <div className="physics-actions">{rowActions('particle')}</div>
                <div className="physics-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th title={t('phDurationHint')}>{t('phDuration')}</th>
                        <th title={t('phMobilityHint')}>{t('phMobility')}</th>
                        <th title={t('phDelayHint')}>{t('phDelay')}</th>
                        <th title={t('phAccelerationHint')}>{t('phAcceleration')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.particles.slice(1).map((p, i) => (
                        <tr
                          key={p.guid}
                          className={p.guid === particleRow ? 'selected' : ''}
                          onClick={() => setParticleRow(p.guid)}
                        >
                          <td>{i + 1}</td>
                          {(['radius', 'mobility', 'delay', 'acceleration'] as const).map((key) => (
                            <td key={key}>
                              <PhysicsNumber
                                value={p[key]}
                                min={key === 'radius' ? 0.01 : 0}
                                max={
                                  key === 'radius'
                                    ? 10000
                                    : key === 'mobility'
                                      ? 1
                                      : key === 'delay'
                                        ? 10
                                        : 100
                                }
                                step={key === 'mobility' ? 0.01 : 0.1}
                                onCommit={(v) =>
                                  update((g) => ({
                                    ...g,
                                    particles: g.particles.map((q) =>
                                      q.guid === p.guid ? { ...q, [key]: v } : q,
                                    ),
                                  }))
                                }
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </fieldset>
            </div>
            <PendulumView handle={handle} guid={group.guid} />
          </div>
        </>
      )}
    </>
  );
}
