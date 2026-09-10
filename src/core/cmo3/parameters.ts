import type { Element } from '@xmldom/xmldom';
import { parameterDescendants, type ParameterDefinition } from '../../shared/parameters';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { children } from './xml';

function entry(e: XmlEdit, guid: string, group = false) {
  const node = e.g
    .sources(group ? 'parameterGroupSet' : 'parameterSourceSet')
    .find((n) => e.g.guid(e.g.field(n, 'guid')) === guid);
  if (!node) throw new Error(group ? 'Parameter folder not found.' : 'Parameter not found.');
  return node;
}
function childList(e: XmlEdit, guid: string) {
  const list = e.g.field(entry(e, guid, true), '_childGuids');
  if (!list) throw new Error('Parameter folder has no child list.');
  return list;
}
function removeChildren(e: XmlEdit, list: Element, guids: Set<string>) {
  for (const child of children(list)) if (guids.has(e.g.guid(child)!)) list.removeChild(child);
  list.setAttribute('count', String(children(list).length));
}
function retainAdjacentPairs(e: XmlEdit, document: Cmo3Document) {
  const pairs = new Map(
    document.model.parameters
      .filter((p) => p.combined)
      .map((p) => {
        const siblings = document.model.parameterGroups.find(
          (g) => g.guid === p.groupGuid,
        )!.children;
        return [p.guid, siblings[siblings.indexOf(p.guid) + 1]];
      }),
  );
  for (const node of e.g.sources('parameterSourceSet')) {
    const id = e.g.guid(e.g.field(node, 'guid'))!;
    if (!pairs.has(id)) continue;
    const parent = e.g.guid(e.g.field(node, 'parentGroupGuid'))!;
    const siblings = children(childList(e, parent)).map((n) => e.g.guid(n));
    if (siblings[siblings.indexOf(id) + 1] !== pairs.get(id))
      e.field(node, 'combined', e.scalar('b', 'combined', false));
  }
}
function checkDefinition(document: Cmo3Document, value: ParameterDefinition, except?: string) {
  if (document.model.parameters.some((p) => p.id === value.id && p.guid !== except))
    throw new Error('A parameter with this ID already exists.');
  if (!(
    Math.fround(value.min) < Math.fround(value.max) &&
    value.default >= value.min &&
    value.default <= value.max
  ))
    throw new Error('Default must lie within the parameter range.');
  const existing = document.model.parameters.find((p) => p.guid === except);
  if (existing?.keys.some((key) => key < value.min || key > value.max))
    throw new Error('The range must include existing keys. Move or remove those keys first.');
}
export function createParameter(
  document: Cmo3Document,
  value: ParameterDefinition,
  groupGuid: string,
) {
  checkDefinition(document, value);
  const e = new XmlEdit(document.graph),
    list = childList(e, groupGuid);
  const { node, guid } = parameterSource(e, value, groupGuid);
  e.append(e.g.field(e.g.field(e.g.source, 'parameterSourceSet'), '_sources')!, node);
  e.append(list, e.ref(guid));
  return guid.getAttribute('uuid')!;
}

export function parameterSource(e: XmlEdit, value: ParameterDefinition, groupGuid: string) {
  const guid = e.guid('CParameterGuid', 'guid');
  const node = e.node('CParameterSource', undefined, {}, [
    e.scalar('i', 'decimalPlaces', 3),
    guid,
    e.scalar('f', 'snapEpsilon', 0.001),
    e.scalar('f', 'minValue', Math.fround(value.min)),
    e.scalar('f', 'maxValue', Math.fround(value.max)),
    e.scalar('f', 'defaultValue', Math.fround(value.default)),
    e.scalar('b', 'isRepeat', false),
    e.node('CParameterId', 'id', { idstr: value.id }),
    e.node('Type', 'paramType', { v: 'NORMAL' }),
    e.scalar('s', 'name', value.name),
    e.scalar('s', 'description', value.description),
    e.scalar('b', 'combined', false),
    e.guid('CParameterGroupGuid', 'parentGroupGuid', groupGuid),
  ]);
  return { node, guid };
}
export function editParameter(document: Cmo3Document, guid: string, value: ParameterDefinition) {
  checkDefinition(document, value, guid);
  const e = new XmlEdit(document.graph),
    node = entry(e, guid);
  if (e.g.field(node, 'paramType')?.getAttribute('v') !== 'NORMAL')
    throw new Error('Blend shape parameter settings are not supported yet.');
  e.field(node, 'id', e.node('CParameterId', 'id', { idstr: value.id }));
  for (const [name, field] of [
    ['name', 'name'],
    ['description', 'description'],
  ] as const)
    e.field(node, name, e.scalar('s', name, value[field]));
  for (const [name, field] of [
    ['minValue', 'min'],
    ['maxValue', 'max'],
    ['defaultValue', 'default'],
  ] as const)
    e.field(node, name, e.scalar('f', name, Math.fround(value[field])));
}
export function createParameterGroup(document: Cmo3Document, name: string, parentGuid: string) {
  const e = new XmlEdit(document.graph),
    parent = childList(e, parentGuid);
  // Copy the document's native group version, including its color metadata.
  const node = entry(e, document.model.rootParameterGroupGuid, true).cloneNode(true) as Element;
  node.removeAttribute('xs.id');
  node.removeAttribute('xs.idx');
  for (const child of Array.from(node.getElementsByTagName('*'))) {
    child.removeAttribute('xs.id');
    child.removeAttribute('xs.idx');
  }
  const guid = e.guid('CParameterGroupGuid', 'guid');
  let id = 'ParamGroup',
    i = 1;
  while (document.model.parameterGroups.some((g) => g.id === id)) id = 'ParamGroup' + i++;
  e.field(node, 'name', e.scalar('s', 'name', name));
  e.field(node, 'description', e.scalar('s', 'description', ''));
  e.field(node, 'guid', guid);
  e.field(node, 'id', e.node('CParameterGroupId', 'id', { idstr: id }));
  e.field(node, 'parentGroupGuid', e.guid('CParameterGroupGuid', 'parentGroupGuid', parentGuid));
  e.field(node, '_childGuids', e.list('carray_list', '_childGuids'));
  e.field(node, 'folderIsOpened', e.scalar('b', 'folderIsOpened', true));
  e.append(e.g.field(e.g.field(e.g.source, 'parameterGroupSet'), '_groups')!, node);
  e.append(parent, e.ref(guid));
  return guid.getAttribute('uuid')!;
}
export function renameParameterGroup(document: Cmo3Document, guid: string, name: string) {
  if (guid === document.model.rootParameterGroupGuid)
    throw new Error('The root folder cannot be renamed.');
  const e = new XmlEdit(document.graph);
  e.field(entry(e, guid, true), 'name', e.scalar('s', 'name', name));
}
export function moveParameterEntries(
  document: Cmo3Document,
  guids: string[],
  groupGuid: string,
  beforeGuid?: string,
) {
  const e = new XmlEdit(document.graph),
    target = childList(e, groupGuid);
  const groups = new Map(document.model.parameterGroups.map((g) => [g.guid, g]));
  const ids = new Set(guids);
  if (ids.has(document.model.rootParameterGroupGuid))
    throw new Error('The root folder cannot be moved.');
  // Selecting a folder already includes its contents for a move.
  const moved = [...ids].filter((id) => {
    let parent: string | null | undefined =
      groups.get(id)?.parentGuid || document.model.parameters.find((p) => p.guid === id)?.groupGuid;
    while (parent) {
      if (ids.has(parent)) return false;
      parent = groups.get(parent)?.parentGuid;
    }
    return true;
  });
  let ancestor: string | null = groupGuid;
  while (ancestor) {
    if (moved.includes(ancestor)) throw new Error('A folder cannot contain itself.');
    ancestor = groups.get(ancestor)?.parentGuid || null;
  }
  if (beforeGuid && !children(target).some((n) => e.g.guid(n) === beforeGuid))
    throw new Error('Drop target changed.');
  if (beforeGuid && moved.includes(beforeGuid)) return;
  const nodes = moved.map((id) => entry(e, id, groups.has(id)));
  const removed = new Set(moved);
  for (const group of groups.values()) removeChildren(e, childList(e, group.guid), removed);
  const before = children(target).find((n) => e.g.guid(n) === beforeGuid) || null;
  nodes.forEach((node, index) => {
    e.field(node, 'parentGroupGuid', e.guid('CParameterGroupGuid', 'parentGroupGuid', groupGuid));
    target.insertBefore(
      e.guid(groups.has(moved[index]) ? 'CParameterGroupGuid' : 'CParameterGuid', '', moved[index]),
      before,
    );
  });
  target.setAttribute('count', String(children(target).length));
  retainAdjacentPairs(e, document);
}
export function linkParameter(document: Cmo3Document, guid: string, combined: boolean) {
  const p = document.model.parameters.find((p) => p.guid === guid);
  if (!p) throw new Error('Parameter not found.');
  const group = document.model.parameterGroups.find((g) => g.guid === p.groupGuid)!;
  const index = group.children.indexOf(guid),
    next = document.model.parameters.find((p) => p.guid === group.children[index + 1]);
  if (combined && (!next || p.type !== 'NORMAL' || next.type !== 'NORMAL'))
    throw new Error('Link two adjacent normal parameters in the same folder.');
  const e = new XmlEdit(document.graph);
  if (combined)
    for (const id of [group.children[index - 1], next!.guid])
      if (document.model.parameters.some((p) => p.guid === id))
        e.field(entry(e, id), 'combined', e.scalar('b', 'combined', false));
  e.field(entry(e, guid), 'combined', e.scalar('b', 'combined', combined));
}
export function removeParameterEntries(document: Cmo3Document, guids: string[]) {
  const e = new XmlEdit(document.graph),
    ids = new Set(parameterDescendants(document.model.parameterGroups, guids));
  if (ids.has(document.model.rootParameterGroupGuid))
    throw new Error('The root folder cannot be deleted.');
  const groups = new Map(document.model.parameterGroups.map((g) => [g.guid, g]));
  for (const id of ids) entry(e, id, groups.has(id));
  for (const p of document.model.parameters)
    if (ids.has(p.guid) && p.type !== 'NORMAL')
      throw new Error('Blend shape parameter deletion is not supported yet.');
  // The parameter axes must already be baked. Refuse deletion when physics,
  // constraints or other active native data still refers to the parameter.
  const visited = new Set<Element>();
  const checkReferences = (node: Element) => {
    const resolved = e.g.resolve(node)!;
    if (
      visited.has(resolved) ||
      ['CParameterSourceSet', 'CParameterGroupSet', 'CParameterGroup'].includes(resolved.tagName)
    )
      return;
    visited.add(resolved);
    if (resolved.tagName === 'CParameterGuid' && ids.has(e.g.guid(resolved)!))
      throw new Error(
        `Parameter is still referenced by ${node.parentNode?.nodeName || 'native model data'}. Remove that link first.`,
      );
    for (const child of children(resolved)) checkReferences(child);
  };
  checkReferences(e.g.source);
  for (const group of groups.values())
    if (!ids.has(group.guid)) removeChildren(e, childList(e, group.guid), ids);
  for (const [setName, field] of [
    ['parameterSourceSet', '_sources'],
    ['parameterGroupSet', '_groups'],
  ]) {
    const list = e.g.field(e.g.field(e.g.source, setName), field)!;
    for (const child of children(list))
      if (ids.has(e.g.guid(e.g.field(child, 'guid'))!)) list.removeChild(child);
    list.setAttribute('count', String(children(list).length));
  }
  retainAdjacentPairs(e, document);
}
export function setParameterDefaults(
  document: Cmo3Document,
  values: Record<string, number>,
  ids?: string[],
) {
  if (ids?.some((id) => !document.model.parameters.some((p) => p.id === id)))
    throw new Error('Source parameter not found.');
  const e = new XmlEdit(document.graph);
  for (const p of document.model.parameters)
    if (!ids || ids.includes(p.id))
      e.field(
        entry(e, p.guid),
        'defaultValue',
        e.scalar('f', 'defaultValue', Math.fround(values[p.id] ?? p.default)),
      );
}
