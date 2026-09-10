import type { Element } from '@xmldom/xmldom';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { children } from './xml';

/** Detach native sources without losing shared definitions used by survivors. */
export function removeSources(document: Cmo3Document, removed: ReadonlySet<string>) {
  const e = new XmlEdit(document.graph),
    g = e.g;
  const sources = new Set([...removed].map((id) => e.source(id)));
  // Imported 2.x models retain an ID lookup table. Drop only records belonging
  // to deleted objects, just as we remove their entries from source sets.
  for (const option of g.list(g.source, 'modelOptions'))
    if (option.tagName === 'CompatibilityOption_Cubism21to30') {
      const list = g.field(option, 'idSets');
      if (list) {
        for (const entry of children(list))
          if (removed.has(g.guid(g.field(entry, 'guid30'))!)) list.removeChild(entry);
        list.setAttribute('count', String(children(list).length));
      }
    }
  const lists = ['partSourceSet', 'drawableSourceSet', 'deformerSourceSet', 'affecterSourceSet']
    .map((name) => g.field(g.field(g.source, name), '_sources'))
    .filter((n): n is Element => !!n);
  const entries = new Set(
    lists.flatMap((list) => children(list).filter((n) => sources.has(g.resolve(n)!))),
  );
  const visited = new Set<Element>();
  const check = (node: Element, path: string[] = []) => {
    if (entries.has(node) || node.getAttribute('xs.n') === '_childGuids') return;
    const resolved = g.resolve(node)!;
    if (
      sources.has(resolved) ||
      (resolved.tagName.endsWith('Guid') && removed.has(g.guid(resolved)!))
    )
      throw new Error(
        `An object is still referenced by native model data (${[...path, node.getAttribute('xs.n') || node.tagName].join('.')}). Remove that link first.`,
      );
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const child of children(resolved))
      check(child, [...path, node.getAttribute('xs.n') || node.tagName]);
  };
  check(g.source);
  for (const part of document.model.objects.filter(
    (o) => o.kind === 'part' && !removed.has(o.guid),
  )) {
    const ids = g.field(e.source(part.guid), '_childGuids')!;
    for (const child of children(ids)) if (removed.has(g.guid(child)!)) ids.removeChild(child);
    ids.setAttribute('count', String(children(ids).length));
  }
  const owned = new Set<Element>();
  const collect = (node: Element) => {
    owned.add(node);
    children(node).forEach(collect);
  };
  entries.forEach(collect);
  for (const node of g.elements)
    if (!owned.has(node) && node.hasAttribute('xs.ref') && owned.has(g.resolve(node)!))
      node.parentNode?.replaceChild(e.copyOwned(node), node);
  for (const entry of entries) entry.parentNode!.removeChild(entry);
  for (const list of lists) list.setAttribute('count', String(children(list).length));
}
