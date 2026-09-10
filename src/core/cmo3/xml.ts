import { DOMParser, type Element } from '@xmldom/xmldom';

export const children = (node: Element | null): Element[] =>
  node ? (Array.from(node.childNodes).filter((n) => n.nodeType === 1) as Element[]) : [];

/** Cubism's XML is a shared object graph with explicit inheritance fields. */
export class Cmo3Xml {
  readonly document;
  readonly source: Element;
  private readonly refs = new Map<string, Element>();
  private nextId = 1;

  get elements(): Element[] {
    return Array.from(this.document.getElementsByTagName('*'));
  }

  identify(node: Element) {
    const id = `#${this.nextId++}`;
    node.setAttribute('xs.id', id);
    this.refs.set(id, node);
  }

  reindex() {
    this.refs.clear();
    for (const node of this.elements) {
      const id = node.getAttribute('xs.id');
      if (!id) continue;
      if (this.refs.has(id)) throw new Error(`Duplicate XML reference: ${id}`);
      this.refs.set(id, node);
      this.nextId = Math.max(this.nextId, (Number(id.slice(1)) || 0) + 1);
    }
  }

  definition(id: string) {
    const node = this.refs.get(id);
    if (!node) throw new Error(`Unresolved CMO3 reference: ${id}`);
    return node;
  }

  /** Normalize an isolated authoring draft before installing it in the editor. */
  normalize() {
    const shared = children(this.document.documentElement).find((n) => n.tagName === 'shared')!;
    for (const node of this.elements) {
      const id = node.getAttribute('xs.id');
      if (!id || node.parentNode === shared) continue;
      const ref = this.document.createElement(node.tagName);
      ref.setAttribute('xs.ref', id);
      const name = node.getAttribute('xs.n');
      if (name) {
        ref.setAttribute('xs.n', name);
        node.removeAttribute('xs.n');
      }
      node.parentNode!.replaceChild(ref, node);
      shared.appendChild(node);
    }
    this.reindex();
  }

  constructor(xml: string) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error('CMO3 XML declarations are not supported.');
    this.document = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') throw new Error(`Invalid CMO3 XML: ${message}`);
      },
    }).parseFromString(xml, 'application/xml');
    this.reindex();
    const source = children(this.document.getElementsByTagName('main')[0]).find(
      (n) => n.tagName === 'CModelSource',
    );
    if (!source) throw new Error('This archive is not a Cubism model project.');
    this.source = source;
  }

  resolve(node: Element | null): Element | null {
    const seen = new Set<Element>();
    while (node?.getAttribute('xs.ref')) {
      if (seen.has(node)) throw new Error('Cyclic CMO3 XML reference.');
      seen.add(node);
      const ref = node.getAttribute('xs.ref')!;
      const target = this.refs.get(ref);
      if (!target) throw new Error(`Unresolved CMO3 reference: ${ref}`);
      node = target;
    }
    return node;
  }

  field(node: Element | null, name: string): Element | null {
    let current = this.resolve(node);
    const seen = new Set<Element>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const list = children(current);
      const value = list.find((n) => n.getAttribute('xs.n') === name);
      if (value) return value.tagName === 'null' ? null : this.resolve(value);
      current = this.resolve(list.find((n) => n.getAttribute('xs.n') === 'super') || null);
    }
    return null;
  }
  list(node: Element | null, name: string): Element[] {
    return children(this.field(node, name)).map((n) => this.resolve(n)!);
  }
  guid(node: Element | null): string | null {
    return this.resolve(node)?.getAttribute('uuid') || null;
  }
  text(node: Element | null, name: string, initial = ''): string {
    return this.resolve(node)?.getAttribute(name) ?? this.field(node, name)?.textContent ?? initial;
  }
  number(node: Element | null, name: string, initial = 0): number {
    const raw = this.text(node, name);
    if (!raw) return initial;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid CMO3 numeric field: ${name}`);
    return value;
  }
  numbers(node: Element | null, name: string): number[] {
    const array = this.field(node, name);
    if (!array) return [];
    const text = array.textContent?.trim() || '';
    const values = text ? text.split(/\s+/).map(Number) : [];
    if (
      values.some((v) => !Number.isFinite(v)) ||
      values.length !== Number(array.getAttribute('count'))
    )
      throw new Error(`Invalid CMO3 array: ${name}`);
    return values;
  }
  sources(name: string): Element[] {
    return children(this.field(this.source, name))
      .flatMap((n) => children(this.resolve(n)))
      .map((n) => this.resolve(n)!);
  }
}
