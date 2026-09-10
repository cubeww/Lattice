import type { ModelObject } from './types';

export const isDeformer = (object: ModelObject) => ['warp', 'rotation'].includes(object.kind);

export function emptyDeformers(
  objects: ModelObject[],
  parentGuid: string | null,
  locked: ReadonlySet<string>,
) {
  const scope = parentGuid
    ? new Set(deformerDescendants(objects, [parentGuid]).filter((id) => id !== parentGuid))
    : new Set(objects.map((o) => o.guid));
  const removed = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects)
      if (
        scope.has(object.guid) &&
        isDeformer(object) &&
        !removed.has(object.guid) &&
        !locked.has(object.guid) &&
        objects.every((child) => child.deformerGuid !== object.guid || removed.has(child.guid))
      ) {
        removed.add(object.guid);
        changed = true;
      }
  }
  return [...removed];
}

/** The deformation tree is independent of the part tree. */
export function deformerDescendants(objects: ModelObject[], roots: string[]) {
  const result = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects)
      if (object.deformerGuid && result.has(object.deformerGuid) && !result.has(object.guid)) {
        result.add(object.guid);
        changed = true;
      }
  }
  return [...result];
}

export function topDeformerSelection(objects: ModelObject[], guids: string[]) {
  const byGuid = new Map(objects.map((o) => [o.guid, o])),
    selected = new Set(guids);
  return [...selected].filter((guid) => {
    const seen = new Set<string>();
    let parent = byGuid.get(guid)?.deformerGuid;
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return false;
      seen.add(parent);
      parent = byGuid.get(parent)?.deformerGuid;
    }
    return true;
  });
}
