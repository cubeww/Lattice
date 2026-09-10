import type { ModelObject } from '../../../shared/types';
import { isDeformer } from '../../../shared/tree';

export function treeModel(
  objects: ModelObject[],
  rootPart: string | null,
  deformers: boolean,
  expanded: Set<string>,
  query: string,
) {
  const list = objects.filter(
    (o) => o.guid !== rootPart && (!deformers || !['part', 'glue'].includes(o.kind)),
  );
  const byGuid = new Map(list.map((o) => [o.guid, o]));
  const parent = (o: ModelObject) => {
    const id = deformers ? o.deformerGuid : o.parentGuid;
    return id && byGuid.has(id) ? id : null;
  };
  const children = new Map<string | null, ModelObject[]>();
  for (const object of list) {
    const id = parent(object),
      items = children.get(id) || [];
    items.push(object);
    children.set(id, items);
  }
  if (deformers)
    for (const items of children.values())
      items.sort((a, b) => Number(isDeformer(b)) - Number(isDeformer(a)));
  const matches = new Set(
    list
      .filter((o) => `${o.name} ${o.id}`.toLowerCase().includes(query.trim().toLowerCase()))
      .map((o) => o.guid),
  );
  const included = new Set(matches);
  for (const id of matches) {
    let object = byGuid.get(id)!;
    const seen = new Set<string>();
    while (parent(object) && !seen.has(parent(object)!)) {
      const key = parent(object)!;
      seen.add(key);
      included.add(key);
      object = byGuid.get(key)!;
    }
  }
  const filtering = !!query.trim();
  const rows: {
    object: ModelObject;
    depth: number;
    hasChildren: boolean;
    open: boolean;
    context: boolean;
  }[] = [];
  const visited = new Set<string>();
  const visit = (id: string | null, depth: number) => {
    for (const object of children.get(id) || []) {
      if (visited.has(object.guid) || !included.has(object.guid)) continue;
      visited.add(object.guid);
      const hasChildren = (children.get(object.guid) || []).some((o) => included.has(o.guid));
      const open = filtering || expanded.has(object.guid);
      rows.push({ object, depth, hasChildren, open, context: !matches.has(object.guid) });
      if (open) visit(object.guid, depth + 1);
    }
  };
  visit(null, 0);
  return { list, byGuid, parent, children, matches, rows, filtering };
}
