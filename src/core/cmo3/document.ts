import { XMLSerializer, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom';
import { basename } from 'node:path';
import type { ModelDocument, ModelObject, ObjectKind, Parameter } from '../../shared/types';
import { Cmo3Archive } from './archive';
import { readPhysics } from './physics';
import { Cmo3Xml, children } from './xml';
import { changedFieldOwners, recordValue, type FieldPatch } from './field-edit';

export class Cmo3Document {
  readonly archive: Cmo3Archive;
  model!: ModelDocument;
  readonly graph: Cmo3Xml;
  private readonly nameNodes = new Map<string, XmlElement>();
  private readonly baselineXml: string;
  private readonly baselinePayloadHash: string;
  private readonly payloadHash: string;
  private xmlChunks: Map<XmlNode, string> | null = null;

  constructor(
    bytes: Buffer | Cmo3Archive,
    path: string | null,
    editedXml?: string,
    baselineXml?: string,
    baselinePayloadHash?: string,
  ) {
    this.archive = bytes instanceof Cmo3Archive ? bytes : new Cmo3Archive(bytes);
    this.payloadHash = this.archive.payloadHash;
    this.baselinePayloadHash = baselinePayloadHash ?? this.payloadHash;
    this.graph = new Cmo3Xml(
      editedXml ?? this.archive.read(this.archive.mainPath).toString('utf8'),
    );
    this.baselineXml = baselineXml ?? new XMLSerializer().serializeToString(this.graph.document);
    this.refreshModel(path);
  }

  refreshModel(path = this.model.path) {
    this.nameNodes.clear();
    const { source } = this.graph;
    const canvas = this.field(source, 'canvas');
    const kinds: Record<string, ObjectKind> = {
      CPartSource: 'part',
      CArtMeshSource: 'mesh',
      CRotationDeformerSource: 'rotation',
      CWarpDeformerSource: 'warp',
      CArtPathSource: 'artpath',
      CGlueSource: 'glue',
    };
    // Enumerate the model's source sets, not every shared definition: extensions
    // and history may also contain objects which do not belong to this model.
    const nodes = ['partSourceSet', 'deformerSourceSet', 'drawableSourceSet', 'affecterSourceSet']
      .flatMap((key) => {
        const set = this.field(source, key);
        return children(set)
          .flatMap((list) => children(this.resolve(list)))
          .map((n) => this.resolve(n));
      })
      .filter((n): n is XmlElement => !!n && !!kinds[n.tagName]);
    const seen = new Set<string>();
    const objects: ModelObject[] = [];
    for (const node of nodes) {
      const guid = this.guid(this.field(node, 'guid'));
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      const id = this.field(node, 'id')?.getAttribute('idstr') || guid;
      const name = this.field(node, 'localName');
      if (name) {
        this.nameNodes.set(guid, name);
      }
      const keyforms = children(this.field(node, 'keyforms')).map((n) => this.resolve(n));
      const positions = this.field(node, 'positions');
      objects.push({
        guid,
        id,
        name: name?.textContent || '',
        kind: kinds[node.tagName],
        parentGuid: this.guid(this.field(node, 'parentGuid')),
        deformerGuid: this.guid(this.field(node, 'targetDeformerGuid')),
        visible: this.field(node, 'isVisible')?.textContent !== 'false',
        locked: this.field(node, 'isLocked')?.textContent === 'true',
        drawOrder: this.number(
          keyforms[0] || null,
          'drawOrder',
          this.number(node, 'defaultOrder_forEditor', 0),
        ),
        vertexCount: positions
          ? Number(positions.getAttribute('count') || 0) / 2
          : node.tagName === 'CArtPathSource'
            ? Number(this.field(keyforms[0] || null, 'positions')?.getAttribute('count') || 0)
            : 0,
        keyformCount: this.graph.list(this.field(node, 'keyformGridSource'), 'keyformsOnGrid')
          .length,
      });
    }
    // Native tree order follows part membership, not the source-set type buckets.
    const byGuid = new Map(nodes.map((node) => [this.guid(this.field(node, 'guid')), node]));
    const order = new Map<string, number>();
    const visit = (guid: string | null) => {
      if (!guid || order.has(guid)) return;
      order.set(guid, order.size);
      const node = byGuid.get(guid);
      if (node?.tagName === 'CPartSource')
        for (const child of this.graph.list(node, '_childGuids')) visit(this.guid(child));
    };
    visit(this.guid(this.field(this.field(source, 'rootPart'), 'guid')));
    objects.sort((a, b) => (order.get(a.guid) ?? Infinity) - (order.get(b.guid) ?? Infinity));
    const parameters: Parameter[] = [];
    const parameterKeys = new Map<string, Set<number>>();
    const parameterBindings = new Map<string, Record<string, number[]>>();
    for (const owner of nodes)
      for (const binding of this.graph.list(
        this.field(owner, 'keyformGridSource'),
        'keyformBindings',
      )) {
        const parameterGuid = this.guid(this.field(binding, 'parameterGuid'));
        if (!parameterGuid) continue;
        const keys = parameterKeys.get(parameterGuid) || new Set<number>();
        const values = this.graph
          .list(binding, 'keys')
          .map((key) => Number(key.textContent))
          .filter(Number.isFinite);
        for (const value of values) keys.add(value);
        const bindings = parameterBindings.get(parameterGuid) || {};
        bindings[this.guid(this.field(owner, 'guid'))!] = values;
        parameterBindings.set(parameterGuid, bindings);
        parameterKeys.set(parameterGuid, keys);
      }
    const set = this.field(source, 'parameterSourceSet');
    for (const n of children(set).flatMap((n) => children(this.resolve(n)))) {
      const node = this.resolve(n);
      if (!node || node.tagName !== 'CParameterSource') continue;
      const guid = this.guid(this.field(node, 'guid'));
      const id = this.field(node, 'id')?.getAttribute('idstr');
      if (!guid || !id) throw new Error('CMO3 parameter lacks an ID or GUID.');
      const keys = parameterKeys.get(guid) || new Set<number>();
      parameters.push({
        guid,
        id,
        name: this.field(node, 'name')?.textContent || id,
        min: this.number(node, 'minValue', 0),
        max: this.number(node, 'maxValue', 1),
        default: this.number(node, 'defaultValue', 0),
        keys: [...keys].sort((a, b) => a - b),
        bindings: parameterBindings.get(guid) || {},
        groupGuid: this.guid(this.field(node, 'parentGroupGuid'))!,
        combined: this.graph.text(node, 'combined') === 'true',
        repeat: this.graph.text(node, 'isRepeat') === 'true',
        description: this.graph.text(node, 'description'),
        decimalPlaces: this.number(node, 'decimalPlaces', 3),
        type: this.field(node, 'paramType')?.getAttribute('v') || 'NORMAL',
      });
    }
    this.model = {
      physics: readPhysics(this.graph, parameters),
      path,
      name:
        this.field(source, 'name')?.textContent ||
        (path ? basename(path, '.cmo3') : 'Untitled Model'),
      formatVersion:
        this.graph.document.documentElement?.getAttribute('fileFormatVersion') || 'unknown',
      canvas: {
        width: this.number(canvas, 'pixelWidth', 0),
        height: this.number(canvas, 'pixelHeight', 0),
      },
      objects,
      guides: this.graph
        .list(this.field(source, 'guides'), 'guidesModeling')
        .flatMap((guide, i) => {
          const type = this.field(guide, 'type')?.getAttribute('v');
          const guid = this.guid(this.field(guide, 'guid'));
          if (!guid || (type !== 'HORIZONTAL' && type !== 'VERTICAL')) return [];
          return [
            {
              guid,
              number: i + 1,
              direction: type === 'HORIZONTAL' ? ('horizontal' as const) : ('vertical' as const),
              position: this.number(guide, 'position', 0),
            },
          ];
        }),
      parameters,
      parameterGroups: this.graph.sources('parameterGroupSet').map((node) => ({
        guid: this.guid(this.field(node, 'guid'))!,
        id: this.field(node, 'id')?.getAttribute('idstr') || '',
        name: this.graph.text(node, 'name'),
        parentGuid: this.guid(this.field(node, 'parentGroupGuid')),
        children: this.graph.list(node, '_childGuids').map((n) => this.guid(n)!),
        expanded: this.graph.text(node, 'folderIsOpened') === 'true',
      })),
      rootParameterGroupGuid: this.guid(
        this.field(this.field(source, 'rootParameterGroup'), 'guid'),
      )!,
      rootPartGuid: this.guid(this.field(this.field(source, 'rootPart'), 'guid')),
      archiveEntries: this.archive.entries.length,
    };
  }

  private resolve(node: XmlElement | null): XmlElement | null {
    return this.graph.resolve(node);
  }

  private field(node: XmlElement | null, name: string): XmlElement | null {
    return this.graph.field(node, name);
  }

  private guid(node: XmlElement | null) {
    return this.graph.guid(node);
  }
  private number(node: XmlElement | null, name: string, defaultValue: number) {
    return this.graph.number(node, name, defaultValue);
  }

  rename(guid: string, value: string) {
    const node = this.nameNodes.get(guid);
    const object = this.model.objects.find((o) => o.guid === guid);
    if (!node || !object) throw new Error('This object does not have an editable name.');
    if (value.length > 256 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
      throw new Error('Invalid object name.');
    recordValue(this.graph, node, null, value);
    node.textContent = value;
    object.name = value;
  }

  get dirty() {
    return this.xml() !== this.baselineXml || this.payloadHash !== this.baselinePayloadHash;
  }

  /** Field transactions invalidate only their containing native definitions. */
  dirtyAfterFields(patches: FieldPatch[]) {
    if (!this.xmlChunks) return this.dirty;
    for (const owner of changedFieldOwners(this.graph, patches)) {
      let node: XmlNode | null = owner;
      while (node) {
        this.xmlChunks.delete(node);
        node = node.parentNode;
      }
    }
    return (
      this.serializeChunks() !== this.baselineXml || this.payloadHash !== this.baselinePayloadHash
    );
  }

  private serializeChunks() {
    const serializer = new XMLSerializer(),
      document = this.graph.document,
      shared = children(document.documentElement).find((n) => n.tagName === 'shared')!;
    return serializer.serializeToString(document, {
      nodeFilter: (node) => {
        if (node.nodeType !== 1 || (node.parentNode !== shared && node.nodeName !== 'main'))
          return node;
        let xml = this.xmlChunks!.get(node);
        if (xml === undefined) {
          xml = serializer.serializeToString(node);
          this.xmlChunks!.set(node, xml);
        }
        // xmldom explicitly supports serialized strings from nodeFilter; its
        // current declaration only describes the Node/null return variants.
        return xml as unknown as XmlNode;
      },
    });
  }

  xml() {
    // Cubism registers references only from direct children of <shared>.
    // Hoist new shared definitions before writing their references elsewhere.
    const original = this.graph.document;
    const originalShared = original.getElementsByTagName('shared')[0];
    const elements = this.graph.elements;
    this.xmlChunks = null;
    if (!elements.some((n) => n.hasAttribute('xs.id') && n.parentNode !== originalShared)) {
      // Namespaced extensions need the serializer's enclosing namespace context.
      // Native definitions have no XML namespaces and can be cached independently.
      if (
        elements.some((n) => n.namespaceURI || Array.from(n.attributes).some((a) => a.namespaceURI))
      )
        return new XMLSerializer().serializeToString(original);
      this.xmlChunks = new Map();
      return this.serializeChunks();
    }
    const document = original.cloneNode(true) as typeof this.graph.document;
    const shared = document.getElementsByTagName('shared')[0];
    for (const node of Array.from(document.getElementsByTagName('*'))) {
      const id = node.getAttribute('xs.id');
      if (!id || node.parentNode === shared) continue;
      const ref = document.createElement(node.tagName);
      ref.setAttribute('xs.ref', id);
      const name = node.getAttribute('xs.n');
      if (name) {
        ref.setAttribute('xs.n', name);
        node.removeAttribute('xs.n');
      }
      node.parentNode!.replaceChild(ref, node);
      shared.appendChild(node);
    }
    return new XMLSerializer().serializeToString(document);
  }
  withXml(xml: string) {
    return new Cmo3Document(
      this.archive,
      this.model.path,
      xml,
      this.baselineXml,
      this.baselinePayloadHash,
    );
  }
  withArchive(bytes: Buffer) {
    return new Cmo3Document(
      bytes,
      this.model.path,
      undefined,
      this.baselineXml,
      this.baselinePayloadHash,
    );
  }

  private meshPositionNode(guid: string, formGuid: string): XmlElement {
    const g = this.graph,
      node = [...g.sources('drawableSourceSet'), ...g.sources('deformerSourceSet')].find(
        (n) => g.guid(g.field(n, 'guid')) === guid,
      );
    if (
      !node ||
      !['CArtMeshSource', 'CWarpDeformerSource', 'CArtPathSource'].includes(node.tagName)
    )
      throw new Error('Editable geometry not found.');
    const form = g.list(node, 'keyforms').find((n) => g.guid(g.field(n, 'guid')) === formGuid);
    const positions = g.field(form || null, 'positions');
    if (!positions) throw new Error('Mesh keyform positions not found.');
    return positions;
  }
  meshPositions(guid: string, formGuid: string): string {
    const node = this.meshPositionNode(guid, formGuid),
      g = this.graph;
    return node.tagName === 'carray_list'
      ? children(node)
          .flatMap((p) => {
            const point = g.field(g.field(p, 'curvePointPosition'), 'point');
            return [g.number(point, 'x'), g.number(point, 'y')];
          })
          .join(' ')
      : node.textContent || '';
  }
  setMeshPositions(guid: string, formGuid: string, value: string) {
    const node = this.meshPositionNode(guid, formGuid),
      positions = value.trim().split(/\s+/).map(Number);
    if (
      positions.length !==
        Number(node.getAttribute('count')) * (node.tagName === 'carray_list' ? 2 : 1) ||
      positions.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e9)
    )
      throw new Error('Invalid edited mesh positions.');
    if (node.tagName === 'carray_list')
      children(node).forEach((p, i) => {
        const point = this.graph.field(this.graph.field(p, 'curvePointPosition'), 'point')!;
        const x = this.graph.field(point, 'x')!,
          y = this.graph.field(point, 'y')!;
        recordValue(this.graph, x, null, String(positions[i * 2]));
        recordValue(this.graph, y, null, String(positions[i * 2 + 1]));
        x.textContent = String(positions[i * 2]);
        y.textContent = String(positions[i * 2 + 1]);
      });
    else {
      recordValue(this.graph, node, null, value);
      node.textContent = value;
    }
  }

  serialize(): Buffer {
    const xml = this.xml();
    if (xml === this.baselineXml && this.payloadHash === this.baselinePayloadHash)
      return Buffer.from(this.archive.bytes);
    return this.archive.replace(new Map([[this.archive.mainPath, Buffer.from(xml, 'utf8')]]));
  }
}
