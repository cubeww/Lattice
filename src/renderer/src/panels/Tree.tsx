import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  Folder,
  Network,
  BoxSelect,
  RotateCw,
  Spline,
  Link2,
  LockKeyhole,
  LockKeyholeOpen,
  ChevronsDownUp,
  ChevronsUpDown,
  ArrowLeftRight,
  MoreHorizontal,
  FolderPlus,
  Trash2,
  X,
} from 'lucide-react';
import type { ModelObject } from '../../../shared/types';
import { deformerDescendants, emptyDeformers, isDeformer } from '../../../shared/tree';
import { emptyParts, partDescendants, topPartSelection } from '../../../shared/parts';
import { locked } from '../../../core/model/selection';
import { useEditor } from '../store';
import { Empty, IconButton } from '../components';
import { treeModel } from '../tree/model';
import { TreeDialog, TreeMenu, type TreeMenuItem } from '../tree/TreeMenu';
import { DeformerDialog } from '../modeling/DeformerDialog';
import { usePartDialogs } from '../tree/PartDialogs';
import { useTreeMovement } from '../tree/useTreeMovement';
import '../tree/tree.css';

const icons = {
  part: Folder,
  mesh: BoxSelect,
  rotation: RotateCw,
  warp: Network,
  artpath: Spline,
  glue: Link2,
};

function RenameField({ object, close }: { object: ModelObject; close: () => void }) {
  const { command, t } = useEditor(),
    [name, setName] = useState(object.name);
  const finished = useRef(false);
  const finish = (cancel = false) => {
    if (finished.current) return;
    finished.current = true;
    if (!cancel && name !== object.name) command({ type: 'rename', guid: object.guid, name });
    close();
  };
  return (
    <input
      className="tree-rename"
      aria-label={`${t('treeRename')}: ${object.name || object.id}`}
      autoFocus
      maxLength={256}
      value={name}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setName(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          finish(e.key === 'Escape');
        }
      }}
    />
  );
}

export function ObjectTree({ deformers = false }: { deformers?: boolean }) {
  const { state, command, perform, t } = useEditor();
  const doc = state.document,
    all = doc?.objects || [];
  const [query, setQuery] = useState(''),
    [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [follow, setFollow] = useState(true),
    [dragLocked, setDragLocked] = useState(false);
  const [focusGuid, setFocusGuid] = useState<string | null>(null),
    [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: string | null;
    guids: string[];
  } | null>(null);
  const [dialog, setDialog] = useState<'warp' | 'rotation' | null>(null);
  const [pruning, setPruning] = useState<{
      parentGuid: string | null;
      guids: string[];
      revision: number;
    } | null>(null),
    [pruningBusy, setPruningBusy] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    anchor = useRef<string | null>(null);
  const model = useMemo(
    () => treeModel(all, doc?.rootPartGuid || null, deformers, expanded, query),
    [all, doc?.rootPartGuid, deformers, expanded, query],
  );
  const byGuid = useMemo(() => new Map(all.map((o) => [o.guid, o])), [all]);
  const lockedGuids = useMemo(
    () => new Set(all.filter((o) => locked(byGuid, o.guid)).map((o) => o.guid)),
    [byGuid],
  );
  const movement = useTreeMovement(deformers, dragLocked, lockedGuids, (guid) =>
    setExpanded((old) => new Set([...old, guid])),
  );
  const { moving, setMoving, canMove, move } = movement;
  const partDialogs = usePartDialogs();
  const { rows, list } = model;
  const selected = state.selectedGuids.filter((id) => model.byGuid.has(id));
  const selectedParent =
    state.selectedGuid && model.byGuid.has(state.selectedGuid)
      ? model.parent(model.byGuid.get(state.selectedGuid)!)
      : null;
  const setFlags = (guids: string[], values: { visible?: boolean; locked?: boolean }) =>
    command({ type: 'setObjectFlags', guids, values, expectedRevision: state.revision });
  const toggle = (guid: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  const focus = (guid: string) => {
    setFocusGuid(guid);
    requestAnimationFrame(() =>
      container.current?.querySelector<HTMLElement>(`[data-guid="${CSS.escape(guid)}"]`)?.focus(),
    );
  };
  useEffect(() => {
    setExpanded(new Set());
    setQuery('');
    setMenu(null);
    setRenaming(null);
    setPruning(null);
    setDialog(null);
    anchor.current = null;
  }, [doc?.path]);
  useEffect(() => {
    setRenaming(null);
    if (!follow || !state.selectedGuid) return;
    const parents = new Set<string>();
    let object = model.byGuid.get(state.selectedGuid);
    while (object && model.parent(object) && !parents.has(model.parent(object)!)) {
      const id = model.parent(object)!;
      parents.add(id);
      object = model.byGuid.get(id);
    }
    setExpanded((old) => new Set([...old, ...parents]));
    setFocusGuid(state.selectedGuid);
    const frame = requestAnimationFrame(() =>
      container.current
        ?.querySelector<HTMLElement>(`[data-guid="${CSS.escape(state.selectedGuid!)}"]`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [state.selectedGuid, selectedParent, doc?.path, follow]);

  const choose = (
    guid: string,
    modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
  ) => {
    const additive = modifiers.ctrlKey || modifiers.metaKey;
    let guids: string[];
    const start = rows.findIndex((r) => r.object.guid === (anchor.current || state.selectedGuid));
    const end = rows.findIndex((r) => r.object.guid === guid);
    if (modifiers.shiftKey && start >= 0 && end >= 0) {
      const range = rows
        .slice(Math.min(start, end), Math.max(start, end) + 1)
        .map((r) => r.object.guid);
      guids = additive ? [...new Set([...state.selectedGuids, ...range])] : range;
    } else {
      guids = additive
        ? state.selectedGuids.includes(guid)
          ? state.selectedGuids.filter((id) => id !== guid)
          : [...state.selectedGuids, guid]
        : [guid];
      anchor.current = guid;
    }
    if (guids.includes(guid)) guids = [...guids.filter((id) => id !== guid), guid];
    setFocusGuid(guid);
    command({ type: 'selectMany', guids });
  };
  const openMenu = (event: React.MouseEvent, target: string | null, guids = selected) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target, guids });
  };
  const menuItems: TreeMenuItem[] = [];
  if (menu && doc) {
    const guids = menu.guids.filter((id) => byGuid.has(id)),
      objects = guids.map((id) => byGuid.get(id)!);
    const descendantIds = deformers ? deformerDescendants(all, guids) : partDescendants(all, guids);
    const valid = !!guids.length,
      editable = valid && !guids.some((id) => lockedGuids.has(id));
    {
      menuItems.push(
        {
          label: t('treeSelectChildren'),
          disabled: !valid || descendantIds.length === guids.length,
          action: () => command({ type: 'selectMany', guids: descendantIds }),
        },
        {
          label: t('treeCollapseChildren'),
          disabled: !objects.some((o) => (deformers ? isDeformer(o) : o.kind === 'part')),
          action: () =>
            setExpanded((old) => new Set([...old].filter((id) => !descendantIds.includes(id)))),
        },
      );
    }
    menuItems.push(
      {
        label: t('treeRename'),
        separator: true,
        disabled: guids.length !== 1 || !editable,
        action: () => setRenaming(guids[0]),
      },
      {
        label: t('treeShow'),
        disabled: !valid || !state.previewReady,
        action: () => setFlags(guids, { visible: true }),
      },
      {
        label: t('treeHide'),
        disabled: !valid || !state.previewReady,
        action: () => setFlags(guids, { visible: false }),
      },
      {
        label: t('treeLock'),
        disabled: !valid || !state.previewReady,
        action: () => setFlags(guids, { locked: true }),
      },
      {
        label: t('treeUnlock'),
        disabled: !valid || !state.previewReady,
        action: () => setFlags(guids, { locked: false }),
      },
    );
    menuItems.push(
      {
        label: t('treeMarkMove'),
        separator: true,
        disabled: !canMove(guids, null),
        action: () => setMoving(guids),
      },
      {
        label: t('treeMoveHere'),
        disabled: !canMove(moving, menu.target),
        action: () => move(moving, menu.target),
      },
      {
        label: t('treeDetach'),
        disabled: !canMove(guids, null),
        action: () => move(guids, null),
      },
      { label: t('treeCancelMove'), disabled: !moving.length, action: () => setMoving([]) },
    );
    if (deformers) {
      const targetObject = menu.target ? byGuid.get(menu.target) : undefined;
      const pruneParent = targetObject && isDeformer(targetObject) ? targetObject.guid : null;
      const empties = emptyDeformers(all, pruneParent, lockedGuids);
      menuItems.push(
        {
          label: t('createWarp'),
          separator: true,
          disabled: !state.previewReady || (valid && !editable),
          action: () => setDialog('warp'),
        },
        {
          label: t('createRotation'),
          disabled: !state.previewReady || (valid && !editable),
          action: () => setDialog('rotation'),
        },
        {
          label: t(pruneParent ? 'treePrune' : 'treePruneAll'),
          separator: true,
          disabled: !state.previewReady || !empties.length || (!!menu.target && !pruneParent),
          action: () =>
            setPruning({ parentGuid: pruneParent, guids: empties, revision: state.revision }),
        },
      );
    } else {
      const parts = objects.filter((o) => o.kind === 'part'),
        onlyParts = valid && parts.length === objects.length;
      const children = partDescendants(
        all,
        parts.map((o) => o.guid),
      ).filter((id) => !guids.includes(id));
      const target = menu.target && byGuid.get(menu.target)?.kind === 'part' ? menu.target : null;
      const empty = emptyParts(all, doc.rootPartGuid!, target, lockedGuids);
      const properties = (values: { drawOrderGroup?: boolean; guideImage?: boolean }) =>
        command({
          type: 'editObjectProperties',
          guids: parts.map((o) => o.guid),
          values,
          expectedRevision: state.revision,
        });
      const grouped =
        parts.length > 0 &&
        parts.every((o) => state.inspector.find((i) => i.guid === o.guid)?.values.drawOrderGroup);
      const guide =
        parts.length > 0 &&
        parts.every((o) => state.inspector.find((i) => i.guid === o.guid)?.values.guideImage);
      const top = topPartSelection(all, guids),
        one = top.length === 1 ? byGuid.get(top[0]) : undefined;
      const siblings = one ? all.filter((o) => o.parentGuid === one.parentGuid) : [],
        index = one ? siblings.indexOf(one) : -1;
      menuItems.push(
        {
          label: t('partMoveUp'),
          disabled: !editable || index <= 0,
          action: () => move(guids, one!.parentGuid, siblings[index - 1].guid),
        },
        {
          label: t('partMoveDown'),
          disabled: !editable || index < 0 || index === siblings.length - 1,
          action: () => move(guids, one!.parentGuid, siblings[index + 2]?.guid),
        },
        {
          label: t('partCreate'),
          separator: true,
          disabled: !state.previewReady || (valid && !editable),
          action: () => partDialogs.create(guids),
        },
        {
          label: t('partDissolve'),
          disabled: !onlyParts || !editable || !state.previewReady,
          action: () => partDialogs.remove(guids, 'partsOnly'),
        },
        {
          label: t('partDelete'),
          disabled: !editable || !state.previewReady,
          action: () => partDialogs.remove(guids),
        },
        {
          label: t(target ? 'partPrune' : 'partPruneAll'),
          disabled: !empty.length || !state.previewReady || (!!menu.target && !target),
          action: () => partDialogs.prune(empty, target),
        },
        {
          label: t(grouped ? 'partUngroupOrder' : 'partGroupOrder'),
          separator: true,
          disabled: !onlyParts || !editable || !state.previewReady,
          action: () => properties({ drawOrderGroup: !grouped }),
        },
        {
          label: t(guide ? 'partUnguided' : 'partGuide'),
          disabled: !onlyParts || !editable || !state.previewReady,
          action: () => properties({ guideImage: !guide }),
        },
      );
      for (const [label, values] of [
        ['partShowChildren', { visible: true }],
        ['partHideChildren', { visible: false }],
        ['partLockChildren', { locked: true }],
        ['partUnlockChildren', { locked: false }],
      ] as const)
        menuItems.push({
          label: t(label),
          separator: label === 'partShowChildren',
          disabled: !children.length || !state.previewReady,
          action: () => setFlags(children, values),
        });
    }
  }
  const bulk = list.filter((o) => model.matches.has(o.guid));
  const shown = bulk.every((o) => o.visible),
    allLocked = bulk.every((o) => o.locked);
  const tabGuid = rows.some((r) => r.object.guid === focusGuid) ? focusGuid : rows[0]?.object.guid;
  return (
    <div
      className={`tree-panel${deformers ? ' deformer-panel' : ''}`}
      data-testid={deformers ? 'deformer-panel' : 'part-panel'}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches('input')) return;
        if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          e.stopPropagation();
          command({ type: e.shiftKey || e.key.toLowerCase() === 'y' ? 'redo' : 'undo' });
        }
        if (e.key === 'Escape') {
          setMoving([]);
          setMenu(null);
          setRenaming(null);
        }
        if (
          !deformers &&
          e.key === 'Delete' &&
          selected.length &&
          state.previewReady &&
          !selected.some((id) => lockedGuids.has(id))
        ) {
          e.preventDefault();
          e.stopPropagation();
          partDialogs.remove(selected);
        }
      }}
    >
      <div className="panel-search">
        <Search size={13} />
        <input
          aria-label={t('filterObjects')}
          placeholder={t('filterObjects')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <IconButton icon={X} label={t('treeClearSearch')} onClick={() => setQuery('')} />}
      </div>
      <div className="tree-tools">
        <IconButton
          icon={shown ? Eye : EyeOff}
          label={t(shown ? 'treeHideAll' : 'treeShowAll')}
          disabled={!bulk.length || !state.previewReady}
          onClick={() =>
            setFlags(
              bulk.map((o) => o.guid),
              { visible: !shown },
            )
          }
        />
        <IconButton
          icon={allLocked ? LockKeyhole : LockKeyholeOpen}
          label={t(allLocked ? 'treeUnlockAll' : 'treeLockAll')}
          disabled={!bulk.length || !state.previewReady}
          onClick={() =>
            setFlags(
              bulk.map((o) => o.guid),
              { locked: !allLocked },
            )
          }
        />
        <IconButton
          icon={ChevronsUpDown}
          label={t('expand')}
          disabled={!doc}
          onClick={() => setExpanded(new Set(list.map((o) => o.guid)))}
        />
        <IconButton
          icon={ChevronsDownUp}
          label={t('collapse')}
          disabled={!doc}
          onClick={() => setExpanded(new Set())}
        />
        <span className="tree-tool-spacer" />
        {
          <>
            <IconButton
              icon={ArrowLeftRight}
              label={t('treeFollow')}
              active={follow}
              onClick={() => setFollow(!follow)}
            />
            <IconButton
              icon={LockKeyhole}
              label={t('treeDragLock')}
              active={dragLocked}
              onClick={() => setDragLocked(!dragLocked)}
            />
          </>
        }
        <IconButton
          icon={MoreHorizontal}
          label={t('treeMenu')}
          disabled={!doc}
          onClick={(e) => openMenu(e, null)}
        />
      </div>
      <div
        className="tree-scroll"
        ref={container}
        role="tree"
        aria-multiselectable="true"
        aria-label={deformers ? t('deformers') : t('parts')}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) openMenu(e, null);
        }}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).matches('input,button')) return;
          const guid = (e.target as HTMLElement).closest<HTMLElement>('[data-guid]')?.dataset.guid;
          if (!guid) return;
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            e.stopPropagation();
            command({ type: 'selectMany', guids: rows.map((r) => r.object.guid) });
            return;
          }
          const index = rows.findIndex((r) => r.object.guid === guid),
            row = rows[index];
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            const next =
              rows[
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? rows.length - 1
                    : Math.max(
                        0,
                        Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)),
                      )
              ];
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey) choose(next.object.guid, e);
            focus(next.object.guid);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            if (row.hasChildren && !row.open) toggle(guid);
            else if (row.hasChildren) {
              choose(rows[index + 1].object.guid);
              focus(rows[index + 1].object.guid);
            }
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();
            if (row.hasChildren && row.open && !model.filtering) toggle(guid);
            else {
              const parent = model.parent(row.object);
              if (parent) {
                choose(parent);
                focus(parent);
              }
            }
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            choose(guid, e);
          } else if (e.key === 'F2' && !lockedGuids.has(guid)) {
            e.preventDefault();
            setRenaming(guid);
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            if (!state.selectedGuids.includes(guid)) choose(guid);
            const box = e.currentTarget
              .querySelector<HTMLElement>(`[data-guid="${CSS.escape(guid)}"]`)!
              .getBoundingClientRect();
            setMenu({
              x: box.left + 60,
              y: box.bottom,
              target: guid,
              guids: state.selectedGuids.includes(guid) ? selected : [guid],
            });
          }
        }}
      >
        {!doc ? (
          <Empty icon={deformers ? Network : Folder}>{t('emptyTree')}</Empty>
        ) : !rows.length ? (
          <Empty>{t('noMatches')}</Empty>
        ) : (
          rows.map(({ object, depth, hasChildren, open, context }) => {
            const Icon = icons[object.kind],
              isSelected = state.selectedGuids.includes(object.guid),
              inherited = !object.locked && lockedGuids.has(object.guid);
            const guids = isSelected ? selected : [object.guid];
            return (
              <div
                key={object.guid}
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={isSelected}
                aria-expanded={hasChildren ? open : undefined}
                tabIndex={object.guid === tabGuid ? 0 : -1}
                data-guid={object.guid}
                className={`tree-row${isSelected ? ' selected' : ''}${context ? ' context-row' : ''}${movement.className(object.guid)}${!object.visible ? ' object-hidden' : ''}`}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusGuid(object.guid);
                }}
                onClick={(e) => choose(object.guid, e)}
                onDoubleClick={(e) => {
                  if (!(e.target as HTMLElement).closest('button') && !lockedGuids.has(object.guid))
                    setRenaming(object.guid);
                }}
                onContextMenu={(e) => {
                  if (!isSelected) choose(object.guid);
                  openMenu(e, object.guid, guids);
                }}
                {...movement.rowProps(
                  object.guid,
                  guids,
                  () => {
                    if (!isSelected) choose(object.guid);
                    setMenu(null);
                  },
                  renaming === object.guid,
                )}
              >
                <button
                  className="tree-eye"
                  tabIndex={-1}
                  aria-label={`${t('visibility')}: ${object.name || object.id}`}
                  aria-pressed={object.visible}
                  title={
                    isDeformer(object)
                      ? t('treeDeformerVisibility')
                      : t(object.visible ? 'treeHide' : 'treeShow')
                  }
                  disabled={!state.previewReady}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFlags([object.guid], { visible: !object.visible });
                  }}
                >
                  {object.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button
                  className={`tree-lock${inherited ? ' inherited' : ''}`}
                  tabIndex={-1}
                  aria-label={`${t(object.locked ? 'treeUnlock' : 'treeLock')}: ${object.name || object.id}`}
                  aria-pressed={object.locked}
                  title={
                    inherited
                      ? t('treeInheritedLock')
                      : t(object.locked ? 'treeUnlock' : 'treeLock')
                  }
                  disabled={!state.previewReady}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFlags([object.guid], { locked: !object.locked });
                  }}
                >
                  {object.locked || inherited ? (
                    <LockKeyhole size={11} />
                  ) : (
                    <span className="tree-lock-dot" />
                  )}
                </button>
                <span style={{ width: depth * 13 }} className="indent" />
                <button
                  className="tree-chevron"
                  tabIndex={-1}
                  aria-label={`${t(open ? 'treeCollapse' : 'treeExpand')}: ${object.name || object.id}`}
                  disabled={!hasChildren}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(object.guid);
                  }}
                >
                  {hasChildren && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                </button>
                <Icon size={14} className={`object-icon ${object.kind}`} />
                {renaming === object.guid ? (
                  <RenameField
                    key={`${object.guid}:${object.name}`}
                    object={object}
                    close={() => {
                      setRenaming(null);
                      focus(object.guid);
                    }}
                  />
                ) : (
                  <span
                    className="tree-name"
                    title={`${object.name || object.id}\n${object.id}${context ? `\n${t('treeContext')}` : ''}`}
                  >
                    {object.name || object.id}
                  </span>
                )}
                {!deformers && <span className="draw-order">{object.drawOrder}</span>}
              </div>
            );
          })
        )}
      </div>
      {!!moving.length && (
        <div className="tree-move-status">
          {moving.length} {t('treeMoving')}
          <IconButton icon={X} label={t('treeCancelMove')} onClick={() => setMoving([])} />
        </div>
      )}
      <div className="panel-foot">
        {doc ? `${list.length} ${t('objects')}` : '—'}
        <span>
          {selected.length ? `${selected.length} ${t('treeSelected')}` : t('sourcePreview')}
        </span>
        {!deformers && (
          <div className="part-foot-actions">
            <IconButton
              icon={FolderPlus}
              label={t('partCreate')}
              disabled={!doc || !state.previewReady || selected.some((id) => lockedGuids.has(id))}
              onClick={() => partDialogs.create(selected)}
            />
            <IconButton
              icon={Trash2}
              label={t('partDelete')}
              disabled={
                !state.previewReady ||
                !selected.length ||
                selected.some((id) => lockedGuids.has(id))
              }
              onClick={() => partDialogs.remove(selected)}
            />
          </div>
        )}
      </div>
      {menu && (
        <TreeMenu {...menu} label={t('treeMenu')} items={menuItems} close={() => setMenu(null)} />
      )}
      {!deformers && partDialogs.element}
      {dialog &&
        createPortal(<DeformerDialog kind={dialog} close={() => setDialog(null)} />, document.body)}
      {pruning && (
        <TreeDialog
          title={t('treePruneTitle')}
          close={() => {
            if (!pruningBusy) setPruning(null);
          }}
        >
          <p>{t('treePruneHint')}</p>
          <ul>
            {pruning.guids.map((id) => (
              <li key={id}>{byGuid.get(id)?.name || byGuid.get(id)?.id}</li>
            ))}
          </ul>
          <footer>
            <button disabled={pruningBusy} onClick={() => setPruning(null)}>
              {t('cancel')}
            </button>
            <button
              className="primary"
              disabled={pruningBusy}
              onClick={() => {
                setPruningBusy(true);
                perform(async () => {
                  try {
                    await window.lattice.command({
                      type: 'pruneEmptyDeformers',
                      parentGuid: pruning.parentGuid,
                      expectedRevision: pruning.revision,
                    });
                    setPruning(null);
                  } finally {
                    setPruningBusy(false);
                  }
                });
              }}
            >
              {t('treePruneTitle')}
            </button>
          </footer>
        </TreeDialog>
      )}
    </div>
  );
}
