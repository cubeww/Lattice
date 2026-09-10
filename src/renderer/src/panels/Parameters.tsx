import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  RotateCcw,
  SlidersHorizontal,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  FolderPlus,
  Plus,
  Trash2,
  ListFilter,
  LockKeyhole,
  Menu,
  Link2,
  Unlink2,
  ListTree,
  CircleMinus,
  Settings2,
} from 'lucide-react';
import type { Parameter } from '../../../shared/types';
import { useEditor } from '../store';
import { Empty, IconButton } from '../components';
import {
  ParameterNumber,
  ParameterSlider,
  ParameterXY,
  parameterKeys,
} from '../parameters/ParameterControl';
import {
  ParameterDialog,
  FolderDialog,
  KeyDialog,
  ParameterConfirm,
} from '../parameters/ParameterDialogs';
import '../parameters/parameters.css';
import { MotionMirroringDialog } from '../parameters/MotionMirroringDialog';
import { getMeshPreview } from '../modeling/mesh-preview';
import { getManualMeshSession } from '../modeling/manual-mesh-session';

const dragType = 'application/x-lattice-parameter';
type Entry = { guid: string; depth: number; parameter?: Parameter };
type Modal =
  | { type: 'new' }
  | { type: 'settings'; parameter: Parameter }
  | { type: 'folder'; guid: string }
  | { type: 'keys'; parameter: Parameter }
  | { type: 'motion'; parameter: Parameter }
  | { type: 'delete' | 'removeKeys' };

export function Parameters() {
  const { state, command, t } = useEditor(),
    doc = state.document,
    panel = state.parameterPanel;
  const [filter, setFilter] = useState(''),
    [modal, setModal] = useState<Modal | null>(null),
    [menu, setMenu] = useState<{ x: number; y: number } | null>(null),
    [drop, setDrop] = useState('');
  const anchor = useRef<string | null>(null),
    container = useRef<HTMLDivElement>(null),
    pointerActive = useRef(false);
  const selected = doc?.parameters.filter((p) => panel.selection.includes(p.guid)) || [];
  const only = panel.selection.length === 1 ? panel.selection[0] : undefined;
  const selectedGroup = doc?.parameterGroups.find((g) => g.guid === only);
  const parent =
    selectedGroup?.guid || selected.at(-1)?.groupGuid || doc?.rootParameterGroupGuid || '';
  const ready = !!state.previewReady;
  const canKeys =
    ready &&
    !!state.selectedGuids.length &&
    selected.length > 0 &&
    selected.length <= 32 &&
    selected.every((p) => p.type === 'NORMAL') &&
    state.selectedGuids.every((id) => !doc?.objects.find((o) => o.guid === id)?.locked);
  const hasKeys = selected.some((p) => parameterKeys(p, state.selectedGuids).length);
  const groups = new Map(doc?.parameterGroups.map((g) => [g.guid, g]));
  const parameters = new Map(doc?.parameters.map((p) => [p.guid, p]));
  const searching = !!filter.trim() || panel.onlyActive;
  const matches = (p: Parameter) =>
    `${p.name} ${p.id}`.toLowerCase().includes(filter.trim().toLowerCase()) &&
    (!panel.onlyActive || state.selectedGuids.some((id) => p.bindings[id]?.length));
  const visible = (id: string): boolean =>
    parameters.has(id) ? matches(parameters.get(id)!) : !!groups.get(id)?.children.some(visible);
  const entries: Entry[] = [];
  const walk = (id: string, depth: number) => {
    for (const child of groups.get(id)?.children || []) {
      const p = parameters.get(child);
      if (p) {
        if (matches(p)) entries.push({ guid: child, depth, parameter: p });
      } else if (!searching || visible(child)) {
        entries.push({ guid: child, depth });
        if (searching || !panel.collapsed.includes(child)) walk(child, depth + 1);
      }
    }
  };
  if (doc) walk(doc.rootParameterGroupGuid, 0);
  const update = (value: Partial<typeof panel>) => command({ type: 'parameterPanel', value });
  const select = (guid: string, e?: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>) => {
    let selection = [guid];
    if (e?.shiftKey && anchor.current) {
      const a = entries.findIndex((p) => p.guid === anchor.current),
        b = entries.findIndex((p) => p.guid === guid);
      if (a >= 0 && b >= 0)
        selection = entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.guid);
    } else if (e?.ctrlKey || e?.metaKey)
      selection = panel.selection.includes(guid)
        ? panel.selection.filter((id) => id !== guid)
        : [...panel.selection, guid];
    if (!e?.shiftKey) anchor.current = guid;
    update({ selection });
  };
  const selectControl = (p: Parameter) => {
    if (!panel.selection.includes(p.guid)) select(p.guid);
  };
  const expand = (guid: string) =>
    update({
      collapsed: panel.collapsed.includes(guid)
        ? panel.collapsed.filter((id) => id !== guid)
        : [...panel.collapsed, guid],
    });
  const preset = (count: 2 | 3) =>
    command({
      type: 'editParameterKeys',
      guids: state.selectedGuids,
      expectedRevision: state.revision,
      edits: selected.map((p) => ({
        parameterGuid: p.guid,
        keys: [
          ...new Set([
            ...parameterKeys(p, state.selectedGuids),
            p.min,
            ...(count === 3 ? [(p.min + p.max) / 2] : []),
            p.max,
          ]),
        ].map((value) => ({ value })),
      })),
    });
  const settings = () => {
    if (selectedGroup) setModal({ type: 'folder', guid: selectedGroup.guid });
    else if (selected.length === 1) setModal({ type: 'settings', parameter: selected[0] });
  };
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.parameter-menu')) setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  useEffect(() => {
    setModal(null);
    setFilter('');
    setMenu(null);
  }, [doc?.path]);
  useEffect(() => {
    if (pointerActive.current) return;
    for (const id of [...panel.selection].reverse()) {
      const row = container.current?.querySelector(`[data-parameter-entry="${CSS.escape(id)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }, [panel.selection.join('|')]);
  const dragStart = (e: DragEvent, guid: string) => {
    if (panel.dragLocked) {
      e.preventDefault();
      return;
    }
    const guids = panel.selection.includes(guid) ? panel.selection : [guid];
    e.dataTransfer.setData(dragType, JSON.stringify(guids));
    e.dataTransfer.effectAllowed = 'move';
    if (!panel.selection.includes(guid)) select(guid);
  };
  const dropHandlers = (key: string, groupGuid: string, beforeGuid?: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!panel.dragLocked && ready && e.dataTransfer.types.includes(dragType)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setDrop(key);
      }
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDrop('');
      if (panel.dragLocked || !e.dataTransfer.types.includes(dragType)) return;
      try {
        const guids: string[] = JSON.parse(e.dataTransfer.getData(dragType));
        command({
          type: 'moveParameterEntries',
          guids,
          groupGuid,
          beforeGuid,
          expectedRevision: state.revision,
        });
      } catch {
        /* Ignore non-editor drag payloads. */
      }
    },
  });
  const name = (p: Parameter) => (
    <button
      type="button"
      className="parameter-name"
      title={`${p.name}\n${p.id}${p.description ? '\n' + p.description : ''}`}
      draggable={!panel.dragLocked && ready}
      onDragStart={(e) => dragStart(e, p.guid)}
      onClick={(e) => select(p.guid, e)}
      onDoubleClick={() => {
        if (ready && p.type === 'NORMAL') setModal({ type: 'settings', parameter: p });
      }}
    >
      {p.name}
    </button>
  );
  const rows: ReactNode[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i],
      p = entry.parameter;
    const style = { '--parameter-depth': entry.depth } as CSSProperties;
    if (!p) {
      const g = groups.get(entry.guid)!;
      rows.push(
        <div
          key={g.guid}
          className={`parameter-folder${panel.selection.includes(g.guid) ? ' selected' : ''}${drop === g.guid ? ' drop-inside' : ''}`}
          style={style}
          data-parameter-entry={g.guid}
          {...dropHandlers(g.guid, g.guid)}
        >
          <button
            className="parameter-folder-toggle"
            aria-label={`${t(panel.collapsed.includes(g.guid) ? 'parameterExpand' : 'parameterCollapse')} · ${g.name}`}
            onClick={() => expand(g.guid)}
          >
            {searching || !panel.collapsed.includes(g.guid) ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )}
          </button>
          <button
            className="parameter-folder-name"
            draggable={!panel.dragLocked && ready}
            onDragStart={(e) => dragStart(e, g.guid)}
            onClick={(e) => select(g.guid, e)}
            onDoubleClick={() => {
              if (ready) setModal({ type: 'folder', guid: g.guid });
            }}
          >
            <Folder size={14} />
            {g.name}
          </button>
          <span className="parameter-folder-count">{g.children.length}</span>
        </div>,
      );
      continue;
    }
    const next = entries[i + 1]?.parameter;
    const sibling = groups.get(p.groupGuid)?.children,
      index = sibling?.indexOf(p.guid) ?? -1;
    const canLink =
      p.type === 'NORMAL' && parameters.get(sibling?.[index + 1] || '')?.type === 'NORMAL';
    const pair = p.combined && next?.guid === sibling?.[index + 1] ? next : undefined;
    const link = (
      <button
        type="button"
        className={`parameter-link${p.combined ? ' linked' : ''}`}
        aria-label={`${t(p.combined ? 'parameterUnlink' : 'parameterLink')} · ${p.name}`}
        title={t(p.combined ? 'parameterUnlink' : 'parameterLink')}
        disabled={!ready || (!p.combined && !canLink)}
        onClick={() =>
          command({
            type: 'linkParameter',
            guid: p.guid,
            combined: !p.combined,
            expectedRevision: state.revision,
          })
        }
      >
        {p.combined ? <Link2 size={13} /> : <Unlink2 size={12} />}
      </button>
    );
    const classes = `parameter-row${panel.selection.includes(p.guid) ? ' selected' : ''}${drop === p.guid ? ' drop-before' : ''}`;
    if (pair) {
      rows.push(
        <div
          key={p.guid}
          className={`parameter-pair${drop === p.guid ? ' drop-before' : ''}`}
          style={style}
          data-parameter-entry={p.guid}
          {...dropHandlers(p.guid, p.groupGuid, p.guid)}
        >
          {link}
          <div className="parameter-pair-names">
            <div className={panel.selection.includes(p.guid) ? 'selected' : ''}>{name(p)}</div>
            <div className={panel.selection.includes(pair.guid) ? 'selected' : ''}>
              {name(pair)}
            </div>
          </div>
          <ParameterXY
            x={p}
            y={pair}
            select={() => {
              if (!panel.selection.includes(p.guid) || !panel.selection.includes(pair.guid))
                update({ selection: [p.guid, pair.guid] });
            }}
          />
          <div className="parameter-pair-values">
            <ParameterNumber parameter={p} select={() => selectControl(p)} />
            <ParameterNumber parameter={pair} select={() => selectControl(pair)} />
          </div>
        </div>,
      );
      i++;
    } else
      rows.push(
        <div
          key={p.guid}
          className={classes}
          style={style}
          data-parameter-entry={p.guid}
          {...dropHandlers(p.guid, p.groupGuid, p.guid)}
        >
          {link}
          {name(p)}
          <span className="parameter-colon">:</span>
          <ParameterSlider parameter={p} select={() => selectControl(p)} />
          <ParameterNumber parameter={p} select={() => selectControl(p)} />
        </div>,
      );
  }
  const folderCount = (doc?.parameterGroups.length || 1) - 1;
  const allCollapsed = folderCount > 0 && panel.collapsed.length >= folderCount;
  return (
    <div
      className="parameter-panel"
      ref={container}
      onPointerDownCapture={() => {
        pointerActive.current = true;
      }}
      onPointerUpCapture={() => {
        pointerActive.current = false;
      }}
      onPointerCancelCapture={() => {
        pointerActive.current = false;
      }}
      aria-label={t('parameters')}
      onDragEnd={() => setDrop('')}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches('input,textarea,select')) return;
        if (e.key === 'Escape') {
          setMenu(null);
          update({ selection: [] });
        }
        if (e.key === 'Delete' && ready && panel.selection.length) {
          e.preventDefault();
          e.stopPropagation();
          setModal({ type: 'delete' });
        }
        if (e.key === 'F2' && ready && only) {
          e.preventDefault();
          settings();
        }
      }}
    >
      <div className="parameter-toolbar" role="toolbar" aria-label={t('parameterTools')}>
        <IconButton
          icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
          label={t(allCollapsed ? 'parameterExpand' : 'parameterCollapse')}
          disabled={!folderCount}
          onClick={() =>
            update({
              collapsed: allCollapsed
                ? []
                : doc!.parameterGroups.filter((g) => g.parentGuid).map((g) => g.guid),
            })
          }
        />
        {([2, 3] as const).map((n) => (
          <button
            key={n}
            type="button"
            className="icon-button parameter-preset"
            aria-label={t(n === 2 ? 'addTwoKeys' : 'addThreeKeys')}
            title={t(n === 2 ? 'addTwoKeys' : 'addThreeKeys')}
            disabled={!canKeys}
            onClick={() => preset(n)}
          >
            <svg width="22" height="20" viewBox="0 0 24 20" aria-hidden="true">
              <path
                d="M3 8H21M17 13V19M14 16H20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              {(n === 2 ? [4, 20] : [4, 12, 20]).map((x) => (
                <circle key={x} cx={x} cy="8" r="2" fill="currentColor" />
              ))}
            </svg>
          </button>
        ))}
        <IconButton
          icon={CircleMinus}
          label={t('removeParameterKeys')}
          disabled={!canKeys || !hasKeys}
          onClick={() => setModal({ type: 'removeKeys' })}
        />
        <IconButton
          icon={Settings2}
          label={t('editParameterKeys')}
          disabled={!canKeys || selected.length !== 1}
          onClick={() => setModal({ type: 'keys', parameter: selected[0] })}
        />
        <span className="parameter-tool-separator" />
        <IconButton
          icon={ListFilter}
          label={t('parameterOnlyActive')}
          active={panel.onlyActive}
          disabled={!doc}
          onClick={() => update({ onlyActive: !panel.onlyActive })}
        />
        <IconButton
          icon={LockKeyhole}
          label={t('parameterDragLock')}
          active={panel.dragLocked}
          disabled={!doc}
          onClick={() => update({ dragLocked: !panel.dragLocked })}
        />
        <span className="parameter-toolbar-space" />
        <IconButton
          icon={RotateCcw}
          label={t('resetParameters')}
          disabled={!doc}
          onClick={() => command({ type: 'resetParameters' })}
        />
        <IconButton
          icon={Menu}
          label={t('parameterMenu')}
          active={!!menu}
          disabled={!doc}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu(
              menu
                ? null
                : {
                    x: Math.max(8, rect.right - 270),
                    y: Math.max(8, Math.min(rect.bottom + 3, window.innerHeight - 385)),
                  },
            );
          }}
        />
      </div>
      <div className="parameter-tools">
        <div className="panel-search">
          <Search size={12} />
          <input
            aria-label={t('filterParameters')}
            placeholder={t('filterParameters')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button type="button" aria-label={t('cancel')} onClick={() => setFilter('')}>
              ×
            </button>
          )}
        </div>
      </div>
      <div className="parameter-scroll">
        {!doc ? (
          <Empty icon={SlidersHorizontal}>{t('emptyTree')}</Empty>
        ) : rows.length ? (
          rows
        ) : (
          <Empty icon={ListTree}>
            {t(panel.onlyActive ? 'parameterNoActive' : 'parameterNoMatches')}
          </Empty>
        )}
        {doc && !panel.dragLocked && (
          <div
            className={`parameter-drop-root${drop === 'root' ? ' drop-inside' : ''}`}
            {...dropHandlers('root', doc.rootParameterGroupGuid)}
          >
            {t('parameterDropRoot')}
          </div>
        )}
      </div>
      <div className="parameter-foot">
        <span
          className="parameter-status"
          title={t(canKeys ? 'parameterInteractionHint' : 'parameterSelectionHint')}
        >
          {panel.selection.length
            ? `${panel.selection.length} ${t('parameterSelected')}`
            : t('parameterSelectionHint')}
        </span>
        <IconButton
          icon={Plus}
          label={t('newParameter')}
          disabled={!ready}
          onClick={() => setModal({ type: 'new' })}
        />
        <IconButton
          icon={FolderPlus}
          label={t('newParameterFolder')}
          disabled={!ready}
          onClick={() => {
            let i = 1;
            while (doc!.parameterGroups.some((g) => g.name === `${t('parameterFolder')} ${i}`)) i++;
            command({
              type: 'createParameterGroup',
              name: `${t('parameterFolder')} ${i}`,
              parentGuid: parent,
              expectedRevision: state.revision,
            });
          }}
        />
        <IconButton
          icon={Trash2}
          label={t('parameterDelete')}
          disabled={!ready || !panel.selection.length}
          onClick={() => setModal({ type: 'delete' })}
        />
      </div>
      {menu &&
        createPortal(
          <div
            className="parameter-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={() => setMenu(null)}
          >
            <button role="menuitem" onClick={() => command({ type: 'resetParameters' })}>
              {t('resetParameters')}
            </button>
            <button
              role="menuitem"
              disabled={!selected.length}
              onClick={() => command({ type: 'resetParameters', ids: selected.map((p) => p.id) })}
            >
              {t('parameterResetSelected')}
            </button>
            <button
              role="menuitemcheckbox"
              aria-checked={panel.snap}
              onClick={() => update({ snap: !panel.snap })}
            >
              <span>{panel.snap ? '✓' : ''}</span>
              {t('parameterSnap')}
            </button>
            <hr />
            <button
              role="menuitem"
              disabled={!ready || !only || (selected.length === 1 && selected[0].type !== 'NORMAL')}
              onClick={settings}
            >
              {t(selectedGroup ? 'renameParameterFolder' : 'parameterSettings')}
            </button>
            <button
              role="menuitem"
              disabled={!ready || !selected.length}
              onClick={() =>
                command({
                  type: 'setParameterDefaults',
                  ids: selected.map((p) => p.id),
                  expectedRevision: state.revision,
                })
              }
            >
              {t('parameterSetDefaults')}
            </button>
            <button
              role="menuitem"
              disabled={
                !ready ||
                !only ||
                selected.length !== 1 ||
                !state.selectedGuids.length ||
                !!getMeshPreview() ||
                !!getManualMeshSession()
              }
              title={t('motionSelectParameter')}
              onClick={() => setModal({ type: 'motion', parameter: selected[0] })}
            >
              {t('motionMirroring')}…
            </button>
            <button
              role="menuitem"
              disabled={!selected.some((p) => p.keys.length)}
              onClick={() =>
                command({
                  type: 'selectMany',
                  guids: [...new Set(selected.flatMap((p) => Object.keys(p.bindings)))],
                })
              }
            >
              {t('parameterSelectObjects')}
            </button>
            <button
              role="menuitem"
              disabled={!ready || !panel.selection.length}
              onClick={() =>
                command({
                  type: 'moveParameterEntries',
                  guids: panel.selection,
                  groupGuid: doc!.rootParameterGroupGuid,
                  expectedRevision: state.revision,
                })
              }
            >
              {t('parameterMoveRoot')}
            </button>
          </div>,
          document.body,
        )}
      {modal?.type === 'new' && <ParameterDialog groupGuid={parent} close={() => setModal(null)} />}
      {modal?.type === 'settings' && (
        <ParameterDialog
          parameter={modal.parameter}
          groupGuid={modal.parameter.groupGuid}
          close={() => setModal(null)}
        />
      )}
      {modal?.type === 'folder' && <FolderDialog guid={modal.guid} close={() => setModal(null)} />}
      {modal?.type === 'keys' && (
        <KeyDialog parameter={modal.parameter} close={() => setModal(null)} />
      )}
      {modal?.type === 'motion' && (
        <MotionMirroringDialog parameter={modal.parameter} close={() => setModal(null)} />
      )}
      {(modal?.type === 'delete' || modal?.type === 'removeKeys') && (
        <ParameterConfirm
          kind={modal.type === 'delete' ? 'delete' : 'keys'}
          close={() => setModal(null)}
        />
      )}
    </div>
  );
}
