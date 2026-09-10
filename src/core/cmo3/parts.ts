import type { Cmo3Document } from './document';
import type { CreatePart } from '../../shared/parts';
import { emptyParts, partDescendants, topPartSelection } from '../../shared/parts';
import { XmlEdit } from './edit';
import { locked } from '../model/selection';
import { readSourceScene } from './scene';
import { reparentObjects } from './reparent';
import { removeSources } from './remove';

function selection(document: Cmo3Document, guids: string[]) {
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  for (const guid of guids) {
    if (!objects.has(guid)) throw new Error('Object not found.');
    if (guid === document.model.rootPartGuid) throw new Error('The root part cannot be edited.');
    if (locked(objects, guid)) throw new Error('This object or its parent is locked.');
  }
  return objects;
}

function setChildren(e: XmlEdit, guid: string, ids: string[]) {
  const part = e.source(guid);
  const previous = e.g.list(part, '_childGuids').map((n) => e.g.guid(n)!);
  if (JSON.stringify(previous) === JSON.stringify(ids)) return;
  e.field(
    part,
    '_childGuids',
    e.list(
      'carray_list',
      '_childGuids',
      ids.map((id) => e.guid(e.g.field(e.source(id), 'guid')!.tagName, '', id)),
    ),
  );
}

export function movePartObjects(
  document: Cmo3Document,
  guids: string[],
  parentGuid: string | null,
  beforeGuid?: string,
) {
  const objects = selection(document, guids),
    parent = parentGuid || document.model.rootPartGuid!;
  if (objects.get(parent)?.kind !== 'part' || locked(objects, parent))
    throw new Error('Select an unlocked parent part.');
  const top = topPartSelection(document.model.objects, guids);
  if (partDescendants(document.model.objects, top).includes(parent))
    throw new Error('A part cannot belong to itself or its descendant.');
  if (beforeGuid && objects.get(beforeGuid)?.parentGuid !== parent)
    throw new Error('The insertion point must belong to the target part.');
  const e = new XmlEdit(document.graph),
    g = e.g;
  const original = g.list(e.source(parent), '_childGuids').map((n) => g.guid(n)!);
  // An insertion anchor within the selection means its first surviving successor.
  const anchor = beforeGuid
    ? original.slice(original.indexOf(beforeGuid)).find((id) => !top.includes(id))
    : undefined;
  const next = original.filter((id) => !top.includes(id));
  next.splice(anchor ? next.indexOf(anchor) : next.length, 0, ...top);
  for (const previous of new Set(top.map((id) => objects.get(id)!.parentGuid!)))
    if (previous !== parent)
      setChildren(
        e,
        previous,
        g
          .list(e.source(previous), '_childGuids')
          .map((n) => g.guid(n)!)
          .filter((id) => !top.includes(id)),
      );
  setChildren(e, parent, next);
  for (const id of top)
    if (objects.get(id)!.parentGuid !== parent)
      e.field(e.source(id), 'parentGuid', e.guid('CPartGuid', 'parentGuid', parent));
  return guids;
}

export function createPart(document: Cmo3Document, input: CreatePart) {
  const objects = selection(document, input.guids);
  if (document.model.objects.some((o) => o.id === input.id))
    throw new Error('This object ID is already in use.');
  const top = topPartSelection(document.model.objects, input.guids),
    first = objects.get(top[0]);
  const parent = first?.parentGuid || document.model.rootPartGuid!;
  if (locked(objects, parent)) throw new Error('The parent part is locked.');
  const e = new XmlEdit(document.graph),
    g = e.g;
  const siblings = g.list(e.source(parent), '_childGuids').map((n) => g.guid(n)!);
  const { source, id } = partSource(e, input, parent);
  // Add directly: all part lists below are rewritten with standalone typed GUIDs.
  e.append(g.field(g.field(g.source, 'partSourceSet'), '_sources')!, source);
  const next = [...siblings];
  next.splice(first ? siblings.indexOf(first.guid) : 0, 0, id);
  setChildren(e, parent, next);
  if (input.groupSelected && top.length) {
    for (const previous of new Set(top.map((id) => objects.get(id)!.parentGuid!)))
      setChildren(
        e,
        previous,
        (previous === parent
          ? next
          : g.list(e.source(previous), '_childGuids').map((n) => g.guid(n)!)
        ).filter((id) => !top.includes(id)),
      );
    setChildren(e, id, top);
    for (const child of top)
      e.field(e.source(child), 'parentGuid', e.guid('CPartGuid', 'parentGuid', id));
  }
  return id;
}

/** Native part construction shared by modeling and file import. */
export function partSource(
  e: XmlEdit,
  input: Pick<CreatePart, 'name' | 'id' | 'drawOrder'>,
  parent: string | null,
) {
  const source = e.identified(e.node('CPartSource')),
    guid = e.identified(e.guid('CPartGuid', 'guid')),
    formGuid = e.identified(e.guid('CFormGuid', 'guid')),
    id = guid.getAttribute('uuid')!;
  for (const node of [
    e.control(input.name, parent, formGuid),
    guid,
    e.node('CPartId', 'id', { idstr: input.id }),
    e.list('carray_list', 'keyforms', [
      e.node('CPartForm', undefined, {}, [
        e.formBase(source, formGuid),
        e.scalar('i', 'drawOrder', input.drawOrder),
        ...e.formAppearance().filter((n) => n.getAttribute('xs.n') !== 'coordType'),
      ]),
    ]),
    e.scalar('b', 'enableDrawOrderGroup', false),
    e.scalar('i', 'defaultOrder_forEditor', input.drawOrder),
    e.scalar('b', 'isSketch', false),
    e.node('CColor', 'partsEditColor'),
    e.list('carray_list', '_childGuids'),
    e.scalar('b', 'useOffscreen', false),
    e.list('carray_list', 'clipGuidList'),
    e.scalar('b', 'invertClippingMask', false),
    e.node('ColorComposition', 'colorComposition', { v: 'NORMAL' }),
    e.node('AlphaComposition', 'alphaComposition', { v: 'OVER' }),
  ])
    source.appendChild(node);
  e.imports([
    'com.live2d.cubism.doc.model.parts.CPartSource',
    'com.live2d.cubism.doc.model.parts.CPartForm',
    'com.live2d.cubism.doc.model.id.CPartId',
    'com.live2d.type.CPartGuid',
    'com.live2d.type.CColor',
  ]);
  e.versions({ CPartSource: 2, CPartForm: 2 });
  return { source, id };
}

export function deletePartObjects(
  document: Cmo3Document,
  guids: string[],
  mode: 'subtree' | 'partsOnly',
  parameters: Record<string, number>,
) {
  const objects = selection(document, guids),
    all = document.model.objects;
  if (mode === 'partsOnly' && guids.some((id) => objects.get(id)!.kind !== 'part'))
    throw new Error('Select parts to keep their child objects.');
  const removed = new Set(mode === 'partsOnly' ? guids : partDescendants(all, guids));
  const e = new XmlEdit(document.graph),
    g = e.g;
  // Glue cannot survive deletion of either of its meshes (native editor behavior).
  for (const glue of g.sources('affecterSourceSet'))
    if (
      glue.tagName === 'CGlueSource' &&
      ['targetArtMeshA_guid', 'targetArtMeshB_guid'].some((key) =>
        removed.has(g.guid(g.field(glue, key))!),
      )
    )
      removed.add(g.guid(g.field(glue, 'guid'))!);
  selection(document, [...removed]);
  const survivors = all.filter((o) => !removed.has(o.guid));
  const parentOf = (id: string) => {
    let parent = objects.get(id)!.parentGuid!;
    while (removed.has(parent)) parent = objects.get(parent)!.parentGuid!;
    return parent;
  };
  // Retained children keep their place when one or several nested containers dissolve.
  if (mode === 'partsOnly') {
    const childrenOf = (id: string): string[] =>
      g.list(e.source(id), '_childGuids').flatMap((n) => {
        const child = g.guid(n)!;
        return removed.has(child) ? childrenOf(child) : [child];
      });
    for (const object of survivors.filter((o) => o.kind === 'part'))
      setChildren(e, object.guid, childrenOf(object.guid));
    for (const object of survivors)
      if (object.parentGuid && removed.has(object.parentGuid)) {
        selection(document, [object.guid]);
        e.field(
          e.source(object.guid),
          'parentGuid',
          e.guid('CPartGuid', 'parentGuid', parentOf(object.guid)),
        );
      }
  }
  const scene = readSourceScene(document).scene;
  // Deformers in a deleted Part may drive artwork in a different Part. Convert
  // those surviving objects to the nearest retained deformer before removal.
  const conversions = new Map<string | null, string[]>();
  for (const object of survivors)
    if (object.deformerGuid && removed.has(object.deformerGuid)) {
      selection(document, [object.guid]);
      let parent = object.deformerGuid;
      while (removed.has(parent)) parent = objects.get(parent)!.deformerGuid!;
      const ids = conversions.get(parent) || [];
      ids.push(object.guid);
      conversions.set(parent, ids);
    }
  for (const [deformerGuid, ids] of conversions)
    reparentObjects(document, scene, ids, { deformerGuid }, parameters);
  for (const object of survivors) {
    const source = e.source(object.guid),
      clips = g.list(source, 'clipGuidList');
    if (clips.some((n) => removed.has(g.guid(n)!)))
      e.field(
        source,
        'clipGuidList',
        e.list(
          'carray_list',
          'clipGuidList',
          clips
            .filter((n) => !removed.has(g.guid(n)!))
            .map((n) => e.guid('CDrawableGuid', '', g.guid(n)!)),
        ),
      );
  }
  removeSources(document, removed);
  return [];
}

export function pruneEmptyParts(document: Cmo3Document, parentGuid: string | null) {
  if (parentGuid && document.model.objects.find((o) => o.guid === parentGuid)?.kind !== 'part')
    throw new Error('Select a part.');
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  const ids = emptyParts(
    document.model.objects,
    document.model.rootPartGuid!,
    parentGuid,
    new Set(document.model.objects.filter((o) => locked(objects, o.guid)).map((o) => o.guid)),
  );
  if (ids.length) removeSources(document, new Set(ids));
}
