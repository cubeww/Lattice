import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { children, type Cmo3Xml } from './xml';

// Native IDs survive save/reload and structural undo. Owned paths are relative to
// the nearest shared definition, so hoisting a definition does not invalidate history.
interface Location {
  id: string | null;
  path: number[];
}
export type FieldPatch =
  | { kind: 'field'; owner: Location; name: string; before: string | null; after: string | null }
  | { kind: 'value'; owner: Location; attribute: string | null; before: string; after: string }
  | { kind: 'instruction'; name: string; value: string; before: boolean; after: boolean };

const active = new WeakMap<Cmo3Xml, FieldPatch[]>();
const serialize = (node: Element | null) =>
  node ? new XMLSerializer().serializeToString(node) : null;

function location(g: Cmo3Xml, element: Element): Location {
  const path: number[] = [];
  let node = element;
  while (node !== g.document.documentElement && !node.hasAttribute('xs.id')) {
    const parent = node.parentNode as Element;
    if (!parent) throw new Error('Cannot edit a detached native field.');
    path.unshift(children(parent).indexOf(node));
    node = parent;
  }
  return { id: node.getAttribute('xs.id'), path };
}

function locate(g: Cmo3Xml, value: Location): Element {
  let node = value.id ? g.definition(value.id) : g.document.documentElement!;
  for (const index of value.path) node = children(node)[index];
  if (!node) throw new Error('Native edit target no longer exists.');
  return node;
}

export function changedFieldOwners(g: Cmo3Xml, patches: FieldPatch[]) {
  return patches.flatMap((patch) => (patch.kind === 'instruction' ? [] : [locate(g, patch.owner)]));
}

export function recordField(
  g: Cmo3Xml,
  owner: Element,
  name: string,
  before: Element | null,
  after: Element,
) {
  const patches = active.get(g);
  if (!patches) return;
  const oldXml = serialize(before),
    newXml = serialize(after);
  if (oldXml !== newXml)
    patches.push({ kind: 'field', owner: location(g, owner), name, before: oldXml, after: newXml });
}

export function recordValue(g: Cmo3Xml, owner: Element, attribute: string | null, after: string) {
  const patches = active.get(g);
  if (!patches) return;
  const before = (attribute ? owner.getAttribute(attribute) : owner.textContent) || '';
  if (before !== after)
    patches.push({ kind: 'value', owner: location(g, owner), attribute, before, after });
}

export function recordInstruction(g: Cmo3Xml, name: string, value: string) {
  active.get(g)?.push({ kind: 'instruction', name, value, before: false, after: true });
}

export function applyFields(g: Cmo3Xml, patches: FieldPatch[], direction: 'before' | 'after') {
  for (const patch of direction === 'before' ? [...patches].reverse() : patches) {
    if (patch.kind === 'instruction') {
      const existing = Array.from(g.document.childNodes).find(
        (n) => n.nodeType === 7 && n.nodeName === patch.name && n.nodeValue === patch.value,
      );
      if (patch[direction] && !existing)
        g.document.insertBefore(
          g.document.createProcessingInstruction(patch.name, patch.value),
          g.document.documentElement,
        );
      else if (!patch[direction] && existing) g.document.removeChild(existing);
      continue;
    }
    const owner = locate(g, patch.owner);
    if (patch.kind === 'value') {
      if (patch.attribute) owner.setAttribute(patch.attribute, patch[direction]);
      else owner.textContent = patch[direction];
    } else {
      const current = children(owner).find((n) => n.getAttribute('xs.n') === patch.name);
      const xml = patch[direction];
      if (xml === null) {
        if (current) owner.removeChild(current);
      } else {
        const element = new DOMParser().parseFromString(xml, 'application/xml').documentElement!;
        const replacement = g.document.importNode(element, true);
        if (current) owner.replaceChild(replacement, current);
        else owner.appendChild(replacement);
      }
    }
  }
}

/** Only field/value writers use this path; topology and hierarchy use document transactions. */
export function captureFields(g: Cmo3Xml, change: () => void): FieldPatch[] {
  if (active.has(g)) throw new Error('Nested native field edit.');
  const patches: FieldPatch[] = [];
  active.set(g, patches);
  try {
    change();
    return patches;
  } catch (error) {
    applyFields(g, patches, 'before');
    throw error;
  } finally {
    active.delete(g);
  }
}
