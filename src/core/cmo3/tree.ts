import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { editObjectProperties } from './inspector';
import { locked } from '../model/selection';
import { emptyDeformers, isDeformer, topDeformerSelection } from '../../shared/tree';
import { removeSources } from './remove';

export function setObjectFlags(
  document: Cmo3Document,
  guids: string[],
  values: { visible?: boolean; locked?: boolean },
) {
  const e = new XmlEdit(document.graph);
  const targets = [...new Set(guids)].map((guid) => {
    if (guid === document.model.rootPartGuid)
      throw new Error('The root part cannot be hidden or locked.');
    return e.source(guid);
  });
  // Flags must remain operable on locked objects, including an explicit unlock.
  for (const source of targets)
    for (const [key, value] of Object.entries(values)) {
      const field = key === 'visible' ? 'isVisible' : 'isLocked';
      const current =
        key === 'visible'
          ? e.g.text(source, field) !== 'false'
          : e.g.text(source, field) === 'true';
      if (current !== value) e.field(source, field, e.scalar('b', field, value));
    }
}

export function moveDeformerObjects(
  document: Cmo3Document,
  guids: string[],
  deformerGuid: string | null,
  parameters: Record<string, number>,
) {
  const objects = document.model.objects;
  if (
    guids.some(
      (id) =>
        !objects.some(
          (o) => o.guid === id && ['mesh', 'artpath', 'warp', 'rotation'].includes(o.kind),
        ),
    )
  )
    throw new Error('Select meshes, ArtPaths or deformers to move.');
  const top = topDeformerSelection(objects, guids);
  editObjectProperties(document, top, { deformerGuid }, parameters);
  return guids;
}

/** Remove empty descendants, retaining the selected anchor just like Cubism. */
export function pruneEmptyDeformers(document: Cmo3Document, parentGuid: string | null) {
  const objects = document.model.objects,
    byGuid = new Map(objects.map((o) => [o.guid, o]));
  if (parentGuid && (!byGuid.has(parentGuid) || !isDeformer(byGuid.get(parentGuid)!)))
    throw new Error('Select a deformer or the root.');
  const removed = new Set(
    emptyDeformers(
      objects,
      parentGuid,
      new Set(objects.filter((o) => locked(byGuid, o.guid)).map((o) => o.guid)),
    ),
  );
  if (removed.size) removeSources(document, removed);
}
