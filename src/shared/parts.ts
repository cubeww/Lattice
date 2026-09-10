import type { ModelObject } from './types';

export interface CreatePart {
  name: string;
  id: string;
  drawOrder: number;
  guids: string[];
  groupSelected: boolean;
}

/** Part membership is independent of the deformation hierarchy. */
export function partDescendants(objects: ModelObject[], guids: string[]) {
  const found = new Set(guids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects)
      if (object.parentGuid && found.has(object.parentGuid) && !found.has(object.guid)) {
        found.add(object.guid);
        changed = true;
      }
  }
  return objects.filter((o) => found.has(o.guid)).map((o) => o.guid);
}

export function topPartSelection(objects: ModelObject[], guids: string[]) {
  const selected = new Set(guids),
    byGuid = new Map(objects.map((o) => [o.guid, o]));
  return objects
    .filter((o) => {
      if (!selected.has(o.guid)) return false;
      const seen = new Set<string>();
      let parent = o.parentGuid;
      while (parent && !seen.has(parent)) {
        if (selected.has(parent)) return false;
        seen.add(parent);
        parent = byGuid.get(parent)?.parentGuid || null;
      }
      return true;
    })
    .map((o) => o.guid);
}

export function emptyParts(
  objects: ModelObject[],
  root: string,
  parent: string | null,
  locked: ReadonlySet<string>,
) {
  const scope = new Set(partDescendants(objects, [parent || root]));
  const removed = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects)
      if (
        object.kind === 'part' &&
        object.guid !== (parent || root) &&
        scope.has(object.guid) &&
        !removed.has(object.guid) &&
        !locked.has(object.guid) &&
        objects.every((child) => child.parentGuid !== object.guid || removed.has(child.guid))
      ) {
        removed.add(object.guid);
        changed = true;
      }
  }
  return [...removed];
}
