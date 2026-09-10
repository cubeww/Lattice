import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import {
  atlasBounds,
  atlasMatrix,
  visibleAtlasImages,
  type TextureAtlas,
  type AtlasItem,
  type AtlasImage,
  type AtlasWorkspace,
} from '../../../shared/atlas';
import { autoLayoutAtlas } from '../../../shared/atlas-layout';
import { AtlasCreate, atlasSizes } from './AtlasCreate';

export function AtlasDialog({ close }: { close: () => void }) {
  const { state, t } = useEditor();
  const [atlases, setAtlases] = useState<TextureAtlas[]>([]),
    [catalog, setCatalog] = useState<AtlasImage[]>([]),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [padding, setPadding] = useState(3),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [creating, setCreating] = useState(false),
    [filter, setFilter] = useState('unassigned'),
    [search, setSearch] = useState(''),
    [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null),
    images = useRef(new Map<string, HTMLImageElement>()),
    drag = useRef<{ id: string; x: number; y: number; left: number; top: number } | null>(null),
    initial = useRef({ id: state.preview?.id, documentRevision: state.documentRevision }),
    projection = useRef({ x: 0, y: 0, scale: 1 });
  const atlas = atlases[page],
    item = selected.length === 1 ? atlas?.items.find((i) => i.guid === selected[0]) : undefined;
  const assigned = useMemo(
    () => new Map(atlases.flatMap((a, p) => a.items.map((i) => [i.guid, p] as const))),
    [atlases],
  );
  const unassigned = catalog.filter((i) => !assigned.has(i.guid));
  const visible = useMemo(
    () => visibleAtlasImages(catalog, state.document?.objects || []),
    [catalog, state.document?.objects],
  );
  const listed = catalog.filter(
    (i) =>
      (filter === 'all' ||
        (filter === 'page' ? assigned.get(i.guid) === page : !assigned.has(i.guid))) &&
      i.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const invalid = atlases.some(
    (a) =>
      !a.name.trim() ||
      a.items.some((i) => {
        const b = atlasBounds(i);
        return (
          !Number.isFinite(b.x + b.y + b.width + b.height) ||
          b.x < -0.01 ||
          b.y < -0.01 ||
          b.x + b.width > a.width + 0.01 ||
          b.y + b.height > a.height + 0.01
        );
      }),
  );
  useEffect(() => {
    if (
      !busy &&
      (state.preview?.id !== initial.current.id ||
        state.documentRevision !== initial.current.documentRevision)
    )
      close();
  }, [state.preview?.id, state.documentRevision, busy]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const response = await fetch(state.preview!.atlasUrl!);
      if (!response.ok) throw new Error(t('atlasLoadFailed'));
      const data: AtlasWorkspace = await response.json();
      const all = [...data.atlases.flatMap((a) => a.items), ...data.unassigned];
      await Promise.all(
        all.map(async (i) => {
          const image = new Image();
          image.src = i.url;
          await image.decode();
          if (alive) images.current.set(i.guid, image);
        }),
      );
      if (!alive) return;
      setCatalog(all);
      setAtlases(data.atlases);
      setCreating(!data.atlases.length);
      setFilter(data.unassigned.length ? 'unassigned' : 'page');
      setLoaded(true);
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      alive = false;
    };
  }, []);
  const update = (change: Partial<TextureAtlas>) =>
    setAtlases((list) => list.map((a, i) => (i === page ? { ...a, ...change } : a)));
  const place = (guid: string, change: Partial<AtlasItem>) =>
    setAtlases((list) =>
      list.map((a, i) =>
        i === page
          ? {
              ...a,
              items: a.items.map((item) => (item.guid === guid ? { ...item, ...change } : item)),
            }
          : a,
      ),
    );
  const pack = (addImages: string[] = []) => {
    if (!atlas) return;
    const result = autoLayoutAtlas(
      { atlases, unassigned },
      visible,
      {
        atlasGuid: atlas.guid,
        addImages,
        padding,
      },
      atlas.guid,
    );
    if (!result) {
      setError(t('atlasDoesNotFit'));
      return;
    }
    update(result);
    setError('');
  };
  const add = (ids: string[], arrange: boolean, position = { x: 0, y: 0 }) => {
    if (!atlas) return;
    const additions = unassigned
      .filter((i) => ids.includes(i.guid))
      .map((i) => ({ ...i, ...position, scaleX: 1, scaleY: 1, angle: 0 }));
    if (!additions.length) return;
    if (arrange) pack(additions.map((i) => i.guid));
    else update({ items: [...atlas.items, ...additions] });
    setSelected(additions.map((i) => i.guid));
  };
  const remove = () => {
    setAtlases((list) =>
      list.map((a) => ({ ...a, items: a.items.filter((i) => !selected.includes(i.guid)) })),
    );
    setFilter('unassigned');
    setError('');
  };
  const choose = (id: string, event: React.MouseEvent) => {
    if (event.shiftKey && selected.length) {
      const from = listed.findIndex((i) => i.guid === selected[0]),
        to = listed.findIndex((i) => i.guid === id);
      if (from >= 0) {
        setSelected(listed.slice(Math.min(from, to), Math.max(from, to) + 1).map((i) => i.guid));
        return;
      }
    }
    setSelected(
      event.ctrlKey || event.metaKey
        ? selected.includes(id)
          ? selected.filter((i) => i !== id)
          : [...selected, id]
        : [id],
    );
  };
  useEffect(() => {
    if (!canvas.current) return;
    const ctx = canvas.current.getContext('2d')!,
      w = canvas.current.width,
      h = canvas.current.height;
    ctx.clearRect(0, 0, w, h);
    if (!atlas) return;
    const scale = Math.min((w - 32) / atlas.width, (h - 32) / atlas.height),
      x = (w - atlas.width * scale) / 2,
      y = (h - atlas.height * scale) / 2;
    projection.current = { x, y, scale };
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, atlas.width, atlas.height);
    ctx.strokeStyle = '#b1b6bd';
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, atlas.width, atlas.height);
    for (const i of atlas.items) {
      const image = images.current.get(i.guid);
      if (!image) continue;
      ctx.save();
      ctx.transform(...atlasMatrix(i));
      ctx.drawImage(image, 0, 0);
      if (selected.includes(i.guid)) {
        ctx.strokeStyle = '#e46076';
        ctx.lineWidth = 2 / scale;
        ctx.strokeRect(0, 0, i.width, i.height);
      }
      ctx.restore();
    }
    ctx.restore();
  }, [atlas, selected, loaded, creating]);
  const pointer = (
    event: React.PointerEvent<HTMLCanvasElement> | React.DragEvent<HTMLCanvasElement>,
  ) => {
    const r = event.currentTarget.getBoundingClientRect(),
      p = projection.current;
    return {
      x: (((event.clientX - r.left) * 760) / r.width - p.x) / p.scale,
      y: (((event.clientY - r.top) * 560) / r.height - p.y) / p.scale,
    };
  };
  const cancelDrag = () => {
    const d = drag.current;
    if (d) place(d.id, { x: d.left, y: d.top });
    drag.current = null;
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      if (drag.current) cancelDrag();
      else if (creating && atlases.length) setCreating(false);
      else close();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [busy, creating, atlases.length, page, close]);
  return (
    <div className="modal-backdrop">
      {creating ? (
        <AtlasCreate
          images={unassigned}
          visible={visible}
          number={atlases.length + 1}
          padding={padding}
          cancel={() => (atlases.length ? setCreating(false) : close())}
          create={(a) => {
            setAtlases([...atlases, a]);
            setPage(atlases.length);
            setCreating(false);
            setSelected([]);
            setFilter(a.items.length ? 'page' : 'unassigned');
          }}
        />
      ) : (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('atlas')}
          className="modeling-dialog atlas-dialog"
          onKeyDown={(e) => {
            if (e.key === 'Delete' && !(e.target as HTMLElement).matches('input,select') && !busy) {
              e.preventDefault();
              remove();
            }
          }}
        >
          <h2>{t('atlas')}</h2>
          <fieldset disabled={busy || !loaded}>
            <div className="atlas-tabs">
              {atlases.map((a, i) => (
                <button
                  key={a.guid}
                  aria-pressed={page === i}
                  onClick={() => {
                    setPage(i);
                    setSelected([]);
                  }}
                >
                  {a.name}
                </button>
              ))}
              <button
                aria-label={t('addAtlas')}
                disabled={atlases.length >= 16}
                onClick={() => setCreating(true)}
              >
                +
              </button>
            </div>
            <div className="atlas-body">
              <div className="atlas-preview">
                <canvas
                  ref={canvas}
                  width="760"
                  height="560"
                  tabIndex={0}
                  data-testid="atlas-canvas"
                  onDragOver={(e) => {
                    if (atlas) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    add(
                      [e.dataTransfer.getData('application/x-lattice-model-image')],
                      false,
                      pointer(e),
                    );
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !atlas) return;
                    e.currentTarget.focus({ preventScroll: true });
                    const p = pointer(e),
                      hit = [...atlas.items].reverse().find((i) => {
                        const b = atlasBounds(i);
                        return (
                          p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height
                        );
                      });
                    setSelected(hit ? [hit.guid] : []);
                    if (hit) {
                      drag.current = { id: hit.guid, x: p.x, y: p.y, left: hit.x, top: hit.y };
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d) return;
                    const p = pointer(e);
                    place(d.id, {
                      x: Math.round(d.left + p.x - d.x),
                      y: Math.round(d.top + p.y - d.y),
                    });
                  }}
                  onPointerUp={() => {
                    drag.current = null;
                  }}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={cancelDrag}
                />
                {!atlas && <p className="hint">{t('atlasEmpty')}</p>}
                {atlas && (
                  <div className="atlas-page-properties">
                    <label>
                      {t('name')}
                      <input
                        aria-label={t('name')}
                        maxLength={256}
                        value={atlas.name}
                        onChange={(e) => update({ name: e.target.value })}
                      />
                    </label>
                    {(['width', 'height'] as const).map((key) => (
                      <label key={key}>
                        {t(key === 'width' ? 'atlasWidth' : 'atlasHeight')}
                        <select
                          aria-label={t(key === 'width' ? 'atlasWidth' : 'atlasHeight')}
                          value={atlas[key]}
                          onChange={(e) => update({ [key]: Number(e.target.value) })}
                        >
                          {atlasSizes.map((n) => (
                            <option key={n}>{n}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <label>
                      {t('padding')}
                      <input
                        aria-label={t('padding')}
                        type="number"
                        min="0"
                        max="64"
                        value={padding}
                        onChange={(e) =>
                          setPadding(Math.max(0, Math.min(64, Number(e.target.value))))
                        }
                      />
                    </label>
                    <button disabled={!atlas.items.length} onClick={() => pack()}>
                      {t('autoLayout')}
                    </button>
                  </div>
                )}
                {item && (
                  <div className="atlas-item-properties">
                    <strong>{item.name}</strong>
                    {(['x', 'y', 'angle', 'scaleX', 'scaleY'] as const).map((key) => (
                      <label key={key}>
                        {key === 'angle'
                          ? t('angle')
                          : key.startsWith('scale')
                            ? t('scale') + ' ' + key.at(-1)
                            : key.toUpperCase()}
                        <input
                          aria-label={'Atlas ' + key}
                          type="number"
                          step={key.startsWith('scale') ? 0.05 : 1}
                          value={item[key]}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (!Number.isFinite(n)) return;
                            place(item.guid, {
                              [key]: key.startsWith('scale')
                                ? Math.min(10, Math.max(0.01, n))
                                : key === 'angle'
                                  ? Math.min(360, Math.max(-360, n))
                                  : n,
                            });
                          }}
                        />
                      </label>
                    ))}
                    {atlases.length > 1 && (
                      <select
                        aria-label={t('moveToAtlas')}
                        value={page}
                        onChange={(e) => {
                          const target = Number(e.target.value);
                          setAtlases((list) =>
                            list.map((a, i) =>
                              i === page
                                ? { ...a, items: a.items.filter((v) => v.guid !== item.guid) }
                                : i === target
                                  ? { ...a, items: [...a.items, item] }
                                  : a,
                            ),
                          );
                          setPage(target);
                        }}
                      >
                        {atlases.map((a, i) => (
                          <option key={a.guid} value={i}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
              <aside>
                <div className="atlas-list-heading">
                  <strong>{t('atlasModelImages')}</strong>
                  <span>
                    {listed.length} / {catalog.length}
                  </span>
                </div>
                <select
                  aria-label={t('atlasImageFilter')}
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setSelected([]);
                  }}
                >
                  <option value="unassigned">{t('atlasUnassigned')}</option>
                  <option value="page">{t('atlasCurrentPage')}</option>
                  <option value="all">{t('atlasAllImages')}</option>
                </select>
                <input
                  type="search"
                  aria-label={t('atlasSearch')}
                  placeholder={t('atlasSearch')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="atlas-image-list" role="group" aria-label={t('atlasModelImages')}>
                  {listed.map((i) => (
                    <button
                      key={i.guid}
                      data-image-guid={i.guid}
                      aria-pressed={selected.includes(i.guid)}
                      title={i.name}
                      draggable={!assigned.has(i.guid)}
                      onDragStart={(e) =>
                        e.dataTransfer.setData('application/x-lattice-model-image', i.guid)
                      }
                      onClick={(e) => choose(i.guid, e)}
                      onDoubleClick={() => {
                        const target = assigned.get(i.guid);
                        if (target === undefined) add([i.guid], false);
                        else {
                          setPage(target);
                          setSelected([i.guid]);
                        }
                      }}
                    >
                      <img src={i.url} alt="" draggable={false} />
                      <span>
                        {i.name}
                        <small>
                          {i.width} × {i.height}
                          {assigned.has(i.guid) ? ' · ' + atlases[assigned.get(i.guid)!].name : ''}
                        </small>
                      </span>
                    </button>
                  ))}
                  {!listed.length && <p className="hint">{t('atlasListEmpty')}</p>}
                </div>
                <div className="atlas-list-actions">
                  <button
                    disabled={!atlas || !selected.some((id) => !assigned.has(id))}
                    onClick={() => add(selected, true)}
                  >
                    {t('atlasAddSelected')}
                  </button>
                  <button
                    disabled={!atlas || !unassigned.length}
                    onClick={() =>
                      add(
                        unassigned.map((i) => i.guid),
                        true,
                      )
                    }
                  >
                    {t('atlasAddAll')}
                  </button>
                  <button disabled={!selected.some((id) => assigned.has(id))} onClick={remove}>
                    {t('atlasUnassign')}
                  </button>
                </div>
              </aside>
            </div>
          </fieldset>
          {(error || invalid) && (
            <p role="alert" className="atlas-error">
              {error || t('atlasInvalid')}
            </p>
          )}
          <footer>
            <span className="hint">
              {t('atlasUnassigned')}: {unassigned.length}
            </span>
            {atlas && (
              <button
                disabled={busy || !loaded}
                onClick={() => {
                  setAtlases(atlases.filter((_, i) => i !== page));
                  setPage(0);
                  setSelected([]);
                  setFilter('unassigned');
                }}
              >
                {t('removeAtlas')}
              </button>
            )}
            <button onClick={close} disabled={busy}>
              {t('cancel')}
            </button>
            <button
              className="primary"
              disabled={!loaded || busy || invalid}
              onClick={() => {
                setBusy(true);
                setError('');
                void window.lattice
                  .command({ type: 'editAtlases', atlases, expectedRevision: state.revision })
                  .then(close)
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? t('atlasApplying') : t('apply')}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
