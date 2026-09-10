import { useEffect, useState } from 'react';
import { useEditor } from '../store';
import type { SourceScene, SourceGlue } from '../../../shared/scene';
import { ModelEvaluator } from '../../../core/model/evaluate';

export function GlueDialog({ close }: { close: () => void }) {
  const { state, t, perform } = useEditor(),
    objects = state.document?.objects || [],
    meshes = objects.filter((o) => o.kind === 'mesh');
  const [scene, setScene] = useState<SourceScene | null>(null),
    [meshA, setA] = useState(
      state.selectedGuids.find((id) => meshes.some((m) => m.guid === id)) || meshes[0]?.guid || '',
    ),
    [meshB, setB] = useState(
      state.selectedGuids.filter((id) => meshes.some((m) => m.guid === id))[1] ||
        meshes[1]?.guid ||
        '',
    ),
    [pairs, setPairs] = useState<SourceGlue['pairs']>([]),
    [name, setName] = useState(t('glue')),
    [busy, setBusy] = useState(false);
  const [guid, setGuid] = useState<string>();
  useEffect(() => {
    let alive = true;
    perform(async () => {
      const r = await fetch(state.preview!.sceneUrl),
        data: SourceScene = await r.json();
      if (!alive) return;
      setScene(data);
      const glue = data.glues?.find((g) => g.guid === state.selectedGuid);
      if (glue) {
        setGuid(glue.guid);
        setA(glue.meshA);
        setB(glue.meshB);
        setPairs(glue.pairs);
        setName(objects.find((o) => o.guid === glue.guid)!.name);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  const match = () => {
    if (!scene) return;
    const evaluated = new ModelEvaluator(scene).evaluate(state.parameterValues),
      a = evaluated.find((m) => m.source.guid === meshA)!,
      b = evaluated.find((m) => m.source.guid === meshB)!;
    const selected = (id: string, length: number) => {
      const points = Object.entries(state.pointSelection[id] || {})
        .filter(([, w]) => w > 0)
        .map(([i]) => Number(i));
      return points.length ? points : Array.from({ length: length / 2 }, (_, i) => i);
    };
    const available = new Set(selected(meshB, b.positions.length)),
      result: SourceGlue['pairs'] = [];
    for (const indexA of selected(meshA, a.positions.length)) {
      const indexB = [...available].sort(
        (i, j) =>
          Math.hypot(
            a.positions[indexA * 2] - b.positions[i * 2],
            a.positions[indexA * 2 + 1] - b.positions[i * 2 + 1],
          ) -
          Math.hypot(
            a.positions[indexA * 2] - b.positions[j * 2],
            a.positions[indexA * 2 + 1] - b.positions[j * 2 + 1],
          ),
      )[0];
      if (indexB === undefined) break;
      if (
        Object.keys(state.pointSelection[meshA] || {}).length ||
        Math.hypot(
          a.positions[indexA * 2] - b.positions[indexB * 2],
          a.positions[indexA * 2 + 1] - b.positions[indexB * 2 + 1],
        ) <= state.toolSettings.size
      ) {
        result.push({ indexA, indexB, weightA: 0.5, weightB: 0.5 });
        available.delete(indexB);
      }
    }
    setPairs(result);
  };
  return (
    <div className="modal-backdrop">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t('glue')}
        className="modeling-dialog glue-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          perform(async () => {
            try {
              await window.lattice.command({
                type: 'setGlue',
                guid,
                value: { name, meshA, meshB, pairs },
                expectedRevision: state.revision,
              });
              await window.lattice.command({ type: 'view', value: { tool: 'glue' } });
              close();
            } finally {
              setBusy(false);
            }
          });
        }}
      >
        <h2>{t('glue')}</h2>
        <p>{t('glueHint')}</p>
        <label className="property">
          <span>{t('name')}</span>
          <input required value={name} maxLength={256} onChange={(e) => setName(e.target.value)} />
        </label>
        {[
          ['A', meshA, setA],
          ['B', meshB, setB],
        ].map(([label, value, set]) => (
          <label key={label as string} className="property">
            <span>ArtMesh {label as string}</span>
            <select
              aria-label={'ArtMesh ' + label}
              value={value as string}
              onChange={(e) => {
                (set as (id: string) => void)(e.target.value);
                setPairs([]);
              }}
            >
              {meshes.map((m) => (
                <option value={m.guid} key={m.guid}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          </label>
        ))}
        <div className="mesh-actions">
          <button type="button" disabled={!scene || meshA === meshB} onClick={match}>
            {t('matchVertices')}
          </button>
          <button
            type="button"
            onClick={() =>
              setPairs([...pairs, { indexA: 0, indexB: 0, weightA: 0.5, weightB: 0.5 }])
            }
          >
            {t('addPair')}
          </button>
        </div>
        <div className="glue-pairs">
          <table>
            <thead>
              <tr>
                <th>A</th>
                <th>B</th>
                <th>{t('glueWeight')} A → B</th>
                <th>{t('glueWeight')} B → A</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pairs.map((p, i) => (
                <tr key={i}>
                  {(['indexA', 'indexB', 'weightA', 'weightB'] as const).map((key) => (
                    <td key={key}>
                      <input
                        type="number"
                        aria-label={key + ' ' + i}
                        min="0"
                        max={
                          key === 'indexA'
                            ? (meshes.find((m) => m.guid === meshA)?.vertexCount || 1) - 1
                            : key === 'indexB'
                              ? (meshes.find((m) => m.guid === meshB)?.vertexCount || 1) - 1
                              : 1
                        }
                        step={key.startsWith('weight') ? 0.05 : 1}
                        value={p[key]}
                        onChange={(e) =>
                          setPairs(
                            pairs.map((p, j) =>
                              j === i ? { ...p, [key]: Number(e.target.value) } : p,
                            ),
                          )
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      aria-label={t('removePair')}
                      onClick={() => setPairs(pairs.filter((_, j) => i !== j))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer>
          {guid && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await window.lattice.command({
                    type: 'removeGlue',
                    guid,
                    expectedRevision: state.revision,
                  });
                  close();
                })
              }
            >
              {t('removeGlue')}
            </button>
          )}
          <button type="button" onClick={close}>
            {t('cancel')}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !pairs.length || meshA === meshB}
          >
            {t('apply')}
          </button>
        </footer>
      </form>
    </div>
  );
}
