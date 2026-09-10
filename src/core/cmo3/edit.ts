import { randomUUID } from 'node:crypto';
import type { Element } from '@xmldom/xmldom';
import { Cmo3Xml, children } from './xml';
import { recordField, recordValue, recordInstruction } from './field-edit';

export const ROOT_DEFORMER = '71fae776-e218-4aee-873e-78e8ac0cb48a';

/** Writes the editor's native graph; shared fields are replaced at their owner. */
export class XmlEdit {
  constructor(readonly g: Cmo3Xml) {}
  node(
    tag: string,
    name?: string,
    attrs: Record<string, string | number | boolean> = {},
    content?: string | Element[],
  ) {
    const node = this.g.document.createElement(tag);
    if (name) node.setAttribute('xs.n', name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (typeof content === 'string') node.textContent = content;
    else for (const child of content || []) node.appendChild(child);
    return node;
  }
  identified(node: Element) {
    this.g.identify(node);
    return node;
  }
  ref(node: Element, name?: string) {
    if (!node.hasAttribute('xs.id')) this.identified(node);
    return this.node(node.tagName, name, { 'xs.ref': node.getAttribute('xs.id')! });
  }
  guid(tag: string, name: string, uuid: string = randomUUID()) {
    return this.node(tag, name, { uuid, note: '(no debug info)' });
  }
  scalar(tag: string, name: string, value: string | number | boolean) {
    return this.node(tag, name, {}, String(value));
  }
  coord(value = 'DeformerLocal') {
    return this.node('CoordType', 'coordType', {}, [this.scalar('s', 'coordName', value)]);
  }
  list(tag: string, name: string, items: Element[] = []) {
    return this.node(tag, name, { count: items.length }, items);
  }
  array(tag: string, name: string, values: number[]) {
    return this.node(
      tag,
      name,
      { count: values.length },
      (tag === 'float-array' ? values.map(Math.fround) : values).join(' '),
    );
  }
  field(owner: Element, name: string, replacement: Element) {
    let node: Element | null = this.g.resolve(owner);
    while (node) {
      const field = children(node).find((n) => n.getAttribute('xs.n') === name);
      if (field) {
        replacement.setAttribute('xs.n', name);
        recordField(this.g, node, name, field, replacement);
        node.replaceChild(replacement, field);
        return replacement;
      }
      node = this.g.field(node, 'super');
    }
    replacement.setAttribute('xs.n', name);
    recordField(this.g, owner, name, null, replacement);
    owner.appendChild(replacement);
    return replacement;
  }
  value(owner: Element, name: string, value: number | string | boolean) {
    if (owner.hasAttribute(name)) {
      recordValue(this.g, owner, name, String(value));
      owner.setAttribute(name, String(value));
    } else {
      const field = this.g.field(owner, name);
      if (!field) throw new Error(`Missing native field: ${name}`);
      recordValue(this.g, field, null, String(value));
      field.textContent = String(value);
    }
  }
  /** Copy owned data without sharing mutable fields; preserve source and GUID links. */
  copyOwned(node: Element): Element {
    if (['_source', '_owner', '_gridSource'].includes(node.getAttribute('xs.n') || ''))
      return this.ref(this.g.resolve(node)!, node.getAttribute('xs.n') || undefined);
    if (node.tagName.endsWith('Guid'))
      return this.guid(node.tagName, node.getAttribute('xs.n') || '', this.g.guid(node)!);
    const resolved = this.g.resolve(node)!;
    const copy = resolved.cloneNode(false) as Element;
    for (const key of ['xs.id', 'xs.ref', 'xs.idx']) copy.removeAttribute(key);
    if (node.hasAttribute('xs.n')) copy.setAttribute('xs.n', node.getAttribute('xs.n')!);
    for (const child of Array.from(resolved.childNodes))
      copy.appendChild(
        child.nodeType === 1 ? this.copyOwned(child as Element) : child.cloneNode(true),
      );
    return copy;
  }
  append(list: Element, item: Element) {
    list.appendChild(item);
    list.setAttribute('count', String(children(list).length));
  }
  source(guid: string) {
    const node = ['drawableSourceSet', 'deformerSourceSet', 'partSourceSet', 'affecterSourceSet']
      .flatMap((name) => this.g.sources(name))
      .find((n) => this.g.guid(this.g.field(n, 'guid')) === guid);
    if (!node) throw new Error('Source object not found.');
    return node;
  }
  addSource(setName: string, node: Element, parentGuid: string) {
    const set = this.g.field(this.g.source, setName),
      list = this.g.field(set, '_sources');
    if (!list) throw new Error('Native source set not found.');
    this.append(list, node);
    const part = this.source(parentGuid),
      childGuids = this.g.field(part, '_childGuids');
    if (!childGuids) throw new Error('Native parent part not found.');
    const guid =
      this.g.field(node, 'guid') ||
      children(children(node)[0]).find((n) => n.getAttribute('xs.n') === 'guid');
    if (!guid) throw new Error('New source GUID not found.');
    this.append(childGuids, this.ref(guid));
  }
  imports(paths: string[]) {
    const existing = new Set(
      Array.from(this.g.document.childNodes)
        .filter((n) => n.nodeType === 7 && n.nodeName === 'import')
        .map((n) => n.nodeValue),
    );
    for (const path of paths)
      if (!existing.has(path)) {
        recordInstruction(this.g, 'import', path);
        this.g.document.insertBefore(
          this.g.document.createProcessingInstruction('import', path),
          this.g.document.documentElement,
        );
      }
  }
  versions(versions: Record<string, number>) {
    const existing = new Set(
      Array.from(this.g.document.childNodes)
        .filter((n) => n.nodeType === 7 && n.nodeName === 'version')
        .map((n) => n.nodeValue?.split(':')[0]),
    );
    for (const [name, value] of Object.entries(versions))
      if (!existing.has(name)) {
        recordInstruction(this.g, 'version', `${name}:${value}`);
        this.g.document.insertBefore(
          this.g.document.createProcessingInstruction('version', `${name}:${value}`),
          this.g.document.documentElement,
        );
      }
  }
  control(name: string, parentGuid: string | null, formGuid: Element, extensions: Element[] = []) {
    return this.node('ACParameterControllableSource', 'super', {}, [
      this.scalar('s', 'localName', name),
      this.scalar('b', 'isVisible', true),
      this.scalar('b', 'isLocked', false),
      parentGuid
        ? this.guid('CPartGuid', 'parentGuid', parentGuid)
        : this.node('null', 'parentGuid'),
      this.node('KeyformGridSource', 'keyformGridSource', {}, [
        this.list('array_list', 'keyformsOnGrid', [
          this.node('KeyformOnGrid', undefined, {}, [
            this.node('KeyformGridAccessKey', 'accessKey', {}, [
              this.list('array_list', '_keyOnParameterList'),
            ]),
            this.ref(formGuid, 'keyformGuid'),
          ]),
        ]),
        this.list('array_list', 'keyformBindings'),
      ]),
      this.node('KeyFormMorphTargetSet', 'keyformMorphTargetSet', {}, [
        this.list('carray_list', '_morphTargets'),
        this.node('MorphTargetBlendWeightConstraintSet', 'blendWeightConstraintSet', {}, [
          this.list('carray_list', '_constraints'),
        ]),
      ]),
      this.list('carray_list', '_extensions', extensions),
      this.node('null', 'internalColor_direct_argb'),
      this.node('CLabelColor', 'labelColor', { customizedColorInt: -1 }, [
        this.node('CLabelColorType', 'labelType', { v: 'UNDEFINED' }),
      ]),
    ]);
  }
  formBase(source: Element, guid: Element) {
    return this.node('ACForm', 'super', {}, [
      guid,
      this.scalar('b', 'isAnimatedForm', false),
      this.scalar('b', 'isLocalAnimatedForm', false),
      this.ref(source, '_source'),
      this.node('null', 'name'),
      this.scalar('s', 'notes', ''),
    ]);
  }
  formAppearance() {
    return [
      this.scalar('f', 'opacity', 1),
      this.node('CFloatColor', 'multiplyColor', { red: 1, green: 1, blue: 1, alpha: 1 }),
      this.node('CFloatColor', 'screenColor', { red: 0, green: 0, blue: 0, alpha: 1 }),
      this.coord(),
    ];
  }
}
