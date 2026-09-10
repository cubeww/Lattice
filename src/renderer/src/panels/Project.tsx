import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileBox,
  Activity,
  Search,
  Folder,
  Image,
  Images,
  Link2,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  LocateFixed,
  MoreHorizontal,
  X,
} from 'lucide-react';
import { useEditor } from '../store';
import { Empty, IconButton } from '../components';
import { TreeMenu, type TreeMenuItem } from '../tree/TreeMenu';
import { useProjectActions, resourceName, resourceKindLabel } from '../project/actions';
import type { ProjectResource } from '../../../shared/project';
import '../project/project.css';
export function Project() {
  const { state, t, command } = useEditor(),
    actions = useProjectActions();
  const resources = state.project?.resources || [],
    byKey = useMemo(() => new Map(resources.map((r) => [r.key, r])), [resources]);
  const [query, setQuery] = useState(''),
    [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState('document'),
    anchor = useRef('document'),
    container = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; keys: string[] } | null>(null);
  const [rename, setRename] = useState<{ key: string; revision: number; name: string } | null>(
    null,
  );
  useEffect(() => {
    setExpanded(
      new Set(
        resources
          .filter((r) =>
            ['document', 'sourceRoot', 'modelRoot', 'sourceImage', 'modelGroup'].includes(r.kind),
          )
          .map((r) => r.key),
      ),
    );
    setQuery('');
    setRename(null);
    setMenu(null);
    setFocus('document');
  }, [state.document?.rootPartGuid]);
  useEffect(() => {
    if (state.inspectorTarget !== 'project') return;
    setExpanded((old) => {
      const next = new Set(old);
      for (const key of state.projectSelection) {
        let parent = byKey.get(key)?.parent;
        while (parent) {
          next.add(parent);
          parent = byKey.get(parent)?.parent;
        }
      }
      return next.size === old.size ? old : next;
    });
    const key = state.projectSelection.at(-1);
    if (key) setFocus(key);
  }, [state.projectSelection.join('|'), state.inspectorTarget]);
  const rows = useMemo(() => {
    const term = query.trim().toLocaleLowerCase(),
      visible = new Set<string>();
    if (term)
      for (const r of resources)
        if (
          [resourceName(r, t), r.memo, r.layerId, r.guid].some((v) =>
            v?.toLocaleLowerCase().includes(term),
          )
        ) {
          let key: string | null = r.key;
          while (key) {
            visible.add(key);
            key = byKey.get(key)?.parent || null;
          }
        }
    const rows: { resource: ProjectResource; depth: number }[] = [];
    const visit = (key: string, depth: number) => {
      const resource = byKey.get(key);
      if (!resource || (term && !visible.has(key))) return;
      rows.push({ resource, depth });
      if (term || expanded.has(key)) resource.children.forEach((key) => visit(key, depth + 1));
    };
    visit('document', 0);
    return rows;
  }, [resources, byKey, expanded, query, state.locale]);
  useEffect(() => {
    if (state.inspectorTarget === 'project')
      Array.from(container.current?.querySelectorAll<HTMLElement>('[data-project-key]') || [])
        .find((n) => n.dataset.projectKey === focus)
        ?.scrollIntoView({ block: 'nearest' });
  }, [focus, expanded, state.inspectorTarget]);
  const toggle = (key: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const select = (key: string, shift = false, ctrl = false) => {
    let keys = ctrl ? state.projectSelection.filter((k) => k !== key) : [key];
    if (ctrl && !state.projectSelection.includes(key)) keys.push(key);
    if (shift) {
      const a = Math.max(
          0,
          rows.findIndex((r) => r.resource.key === anchor.current),
        ),
        b = rows.findIndex((r) => r.resource.key === key);
      keys = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.resource.key);
      if (ctrl) keys = [...new Set([...state.projectSelection, ...keys])];
    } else anchor.current = key;
    setFocus(key);
    command({ type: 'selectProject', keys });
  };
  const startRename = (key: string) => {
    const r = byKey.get(key);
    if (r?.editable.includes('name') && state.previewReady)
      setRename({ key, revision: state.revision, name: r.name });
  };
  const openMenu = (x: number, y: number, key?: string) => {
    const keys = key && !state.projectSelection.includes(key) ? [key] : state.projectSelection;
    if (key && !state.projectSelection.includes(key)) select(key);
    setMenu({ x, y, keys: keys.length ? keys : ['document'] });
  };
  const menuItems = (): TreeMenuItem[] => {
    const selected = resources.filter((r) => menu!.keys.includes(r.key)),
      first = selected[0],
      single = selected.length === 1;
    const models = selected.length > 0 && selected.every((r) => r.kind === 'modelImage'),
      keys = selected.map((r) => r.key);
    const items: TreeMenuItem[] = [];
    if (selected.some((r) => r.meshGuids.length))
      items.push({ label: t('projectSelectMeshes'), action: () => actions.selectMeshes(keys) });
    if (!models && selected.some((r) => r.modelImageKeys.length))
      items.push({
        label: t('projectSelectImages'),
        action: () => {
          setQuery('');
          actions.selectImages(keys);
        },
      });
    if (single && first.sourceKey)
      items.push({
        label: t('projectLocateSource'),
        action: () => {
          setQuery('');
          actions.locateSource(first.sourceKey!);
        },
      });
    if (models)
      items.push({
        label: t('projectCreateMeshes'),
        disabled: !state.previewReady,
        action: () => actions.create(keys),
      });
    if (models && single)
      items.push({
        label: t('projectAssign'),
        disabled: !state.previewReady || !actions.editableMeshes,
        action: () => actions.assign(first.key),
      });
    if (single && first.editable.includes('name'))
      items.push({
        label: t('treeRename'),
        disabled: !state.previewReady,
        action: () => startRename(first.key),
        separator: true,
      });
    if (single && first.image)
      items.push(
        { label: t('projectViewImage'), action: () => actions.preview(first.key) },
        { label: t('projectExportImage'), action: () => actions.exportImage(first.key) },
      );
    if (models)
      items.push({
        label: t('projectDeleteImages'),
        disabled:
          !state.previewReady || selected.some((r) => r.meshGuids.length || r.atlasGuids.length),
        action: () => actions.remove(keys),
        separator: true,
      });
    if (single && ['document', 'modelRoot', 'modelGroup'].includes(first.kind)) {
      const unused = resources
        .filter(
          (r) =>
            first.modelImageKeys.includes(r.key) && !r.meshGuids.length && !r.atlasGuids.length,
        )
        .map((r) => r.key);
      items.push({
        label: t('projectDeleteUnused'),
        disabled: !state.previewReady || !unused.length,
        action: () => actions.remove(unused),
        separator: true,
      });
      items.push({ label: t('atlas'), disabled: !state.previewReady, action: actions.atlas });
    }
    items.push(
      {
        label: t('expand'),
        action: () =>
          setExpanded(new Set(resources.filter((r) => r.children.length).map((r) => r.key))),
        separator: true,
      },
      { label: t('collapse'), action: () => setExpanded(new Set(['document'])) },
    );
    return items;
  };
  if (!state.document || !state.project) return <Empty icon={FileBox}>{t('projectEmpty')}</Empty>;
  return (
    <div className="project-panel" data-testid="project-panel">
      <div className="project-filter">
        <Search size={15} />
        <input
          aria-label={t('projectSearch')}
          placeholder={t('projectSearch')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <IconButton icon={X} label={t('treeClearSearch')} onClick={() => setQuery('')} />}
      </div>
      <div className="project-toolbar" role="toolbar" aria-label={t('projectActions')}>
        <IconButton
          icon={ChevronsUpDown}
          label={t('expand')}
          onClick={() => setExpanded(new Set(resources.map((r) => r.key)))}
        />
        <IconButton
          icon={ChevronsDownUp}
          label={t('collapse')}
          onClick={() => setExpanded(new Set(['document']))}
        />
        <IconButton
          icon={LocateFixed}
          label={t('projectLocateSelected')}
          disabled={
            !resources.some(
              (r) =>
                r.kind === 'modelImage' &&
                r.meshGuids.some((id) => state.selectedGuids.includes(id)),
            )
          }
          onClick={() => {
            setQuery('');
            actions.locateSelected();
          }}
        />
        <span />
        <IconButton
          icon={Images}
          label={t('atlas')}
          disabled={!state.previewReady}
          onClick={actions.atlas}
        />
        <IconButton
          icon={MoreHorizontal}
          label={t('projectActions')}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            openMenu(rect.right, rect.bottom);
          }}
        />
      </div>
      <div
        className="project-tree panel-scroll"
        role="tree"
        aria-label={t('project')}
        aria-multiselectable="true"
        tabIndex={0}
        ref={container}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;
          const index = Math.max(
              0,
              rows.findIndex((r) => r.resource.key === focus),
            ),
            row = rows[index]?.resource;
          if (!row) return;
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
            select(next.resource.key, e.shiftKey, e.ctrlKey || e.metaKey);
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'ArrowRight') {
              if (row.children.length && !expanded.has(row.key)) toggle(row.key);
              else if (row.children[0]) select(row.children[0]);
            } else if (expanded.has(row.key)) toggle(row.key);
            else if (row.parent) select(row.parent);
          } else if (e.key === 'F2') {
            e.preventDefault();
            e.stopPropagation();
            startRename(row.key);
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            e.stopPropagation();
            command({ type: 'selectProject', keys: rows.map((r) => r.resource.key) });
          } else if (e.key === 'Delete') {
            e.preventDefault();
            e.stopPropagation();
            const selected = resources.filter((r) => state.projectSelection.includes(r.key));
            if (
              state.previewReady &&
              selected.length &&
              selected.every(
                (r) => r.kind === 'modelImage' && !r.meshGuids.length && !r.atlasGuids.length,
              )
            )
              actions.remove(selected.map((r) => r.key));
          } else if (e.key === 'Enter' && row.image) {
            e.preventDefault();
            e.stopPropagation();
            actions.preview(row.key);
          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const rect = (e.target as HTMLElement).getBoundingClientRect();
            openMenu(rect.left, rect.bottom, row.key);
          }
        }}
      >
        {rows.map(({ resource: r, depth }) => {
          const selected = state.projectSelection.includes(r.key),
            isOpen = !!query.trim() || expanded.has(r.key);
          const Icon =
            r.kind === 'document'
              ? FileBox
              : r.kind === 'imageInput'
                ? Link2
                : r.kind === 'sourceImage'
                  ? Images
                  : r.kind === 'modelImage' || r.kind === 'sourceLayer'
                    ? Image
                    : Folder;
          return (
            <div
              key={r.key}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={r.children.length ? isOpen : undefined}
              aria-selected={selected}
              aria-label={r.kind === 'document' ? state.document!.name : resourceName(r, t)}
              data-project-key={r.key}
              data-kind={r.kind}
              tabIndex={focus === r.key ? 0 : -1}
              className={`project-row${selected ? ' selected' : ''}${selected && state.inspectorTarget !== 'project' ? ' inactive' : ''}`}
              style={{ paddingLeft: 7 + depth * 15 }}
              title={resourceKindLabel(r, t)}
              onClick={(e) => {
                e.currentTarget.focus();
                select(r.key, e.shiftKey, e.ctrlKey || e.metaKey);
              }}
              onDoubleClick={() =>
                r.children.length ? toggle(r.key) : r.image && actions.preview(r.key)
              }
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, r.key);
              }}
            >
              {r.children.length ? (
                <button
                  className="project-expander"
                  tabIndex={-1}
                  aria-label={`${t(isOpen ? 'collapse' : 'expand')}: ${resourceName(r, t)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(r.key);
                  }}
                >
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              ) : (
                <span className="project-expander" />
              )}
              {r.image ? (
                <img className="project-thumbnail" src={r.image.url} alt="" loading="lazy" />
              ) : (
                <Icon size={15} className="project-resource-icon" />
              )}
              {rename?.key === r.key ? (
                <ResourceRename
                  key={r.key}
                  initial={rename.name}
                  close={(name) => {
                    if (name !== null && name !== rename.name)
                      command({
                        type: 'editProjectResource',
                        key: r.key,
                        values: { name },
                        expectedRevision: rename.revision,
                      });
                    setRename(null);
                  }}
                  label={`${t('treeRename')}: ${r.name}`}
                />
              ) : (
                <span className="project-row-name">
                  {r.kind === 'document' ? state.document!.name : resourceName(r, t)}
                </span>
              )}
              {r.kind === 'document' && state.dirty && (
                <span className="project-modified" aria-label={t('modified')}>
                  •
                </span>
              )}
              {r.current && <span className="project-input-dot" title={t('projectCurrent')} />}
              {r.kind === 'modelImage' && !r.meshGuids.length && !r.atlasGuids.length && (
                <small>{t('projectUnused')}</small>
              )}
            </div>
          );
        })}
        {!rows.length && <p className="panel-hint">{t('projectNoMatches')}</p>}
      </div>
      <div className="project-footer">
        <span>
          {state.project.sourceCount} {t('projectSourceRoot')}
        </span>
        <span>
          {state.project.modelImageCount} {t('projectModelRoot')}
        </span>
      </div>
      {menu && (
        <TreeMenu
          x={menu.x}
          y={menu.y}
          label={t('projectActions')}
          items={menuItems()}
          close={() => setMenu(null)}
        />
      )}
      {actions.node}
    </div>
  );
}

function ResourceRename({
  initial,
  label,
  close,
}: {
  initial: string;
  label: string;
  close: (value: string | null) => void;
}) {
  const [name, setName] = useState(initial),
    done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    close(value);
  };
  return (
    <input
      className="tree-rename"
      aria-label={label}
      value={name}
      maxLength={256}
      autoFocus
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(name)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          finish(e.key === 'Escape' ? null : name);
        }
      }}
    />
  );
}
export function Log() {
  const { state, t } = useEditor();
  return (
    <div className="log-panel panel-scroll">
      {!state.log.length ? (
        <Empty icon={Activity}>{t('noLog')}</Empty>
      ) : (
        state.log.map((entry, i) => (
          <div className="log-row" key={`${entry.time}-${i}`}>
            <time>{new Date(entry.time).toLocaleTimeString(state.locale, { hour12: false })}</time>
            <span>{entry.message}</span>
          </div>
        ))
      )}
    </div>
  );
}
