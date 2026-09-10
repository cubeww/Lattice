import type { Element } from '@xmldom/xmldom';
import type {
  ProjectResources,
  ProjectResource,
  ProjectResourceProperties,
} from '../../shared/project';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { children } from './xml';

/** The Project tree follows the active texture manager, not the shared XML pool. */
export function projectIndex(
  document: Cmo3Document,
  imageUrl: (path: string) => string = () => '',
) {
  const g = document.graph,
    manager = g.field(g.source, 'textureManager');
  const resources: ProjectResource[] = [],
    nodes = new Map<string, Element>();
  const wrappers = new Map<string, Element>();
  const add = (
    kind: ProjectResource['kind'],
    key: string,
    name: string,
    parent: string | null,
    node?: Element,
  ) => {
    if (resources.some((r) => r.key === key)) throw new Error('Duplicate Project resource.');
    const resource: ProjectResource = {
      key,
      kind,
      name,
      parent,
      children: [],
      meshGuids: [],
      modelImageKeys: [],
      atlasGuids: [],
      editable: [],
    };
    resources.push(resource);
    if (node) nodes.set(key, node);
    if (parent) resources.find((r) => r.key === parent)!.children.push(key);
    return resource;
  };
  const bitmap = (node: Element | null) => {
    const path = g.field(node, 'imageFileBuf')?.getAttribute('path');
    if (!path) return undefined;
    const width = g.number(node, 'width'),
      height = g.number(node, 'height');
    return { url: imageUrl(path), width, height };
  };
  const guid = (node: Element) => {
    const value = g.guid(g.field(node, 'guid'));
    if (!value) throw new Error('Project resource GUID is missing.');
    return value;
  };
  const root = add('document', 'document', document.model.name, null);
  add('sourceRoot', 'sourceRoot', '', root.key);
  add('modelRoot', 'modelRoot', '', root.key);
  const rawImages = g.list(manager, '_rawImages');
  for (const wrapper of rawImages) {
    const image = g.field(wrapper, 'image');
    if (!image) throw new Error('Source image is missing.');
    const id = guid(image),
      r = add('sourceImage', `source:${id}`, g.text(image, 'name'), 'sourceRoot', image);
    wrappers.set(r.key, wrapper);
    Object.assign(r, {
      guid: id,
      memo: g.text(image, 'memo'),
      width: g.number(image, 'width'),
      height: g.number(image, 'height'),
      importedAt: g.number(wrapper, 'importedTimeMSec', -1),
      modifiedAt: g.number(wrapper, 'lastModifiedTimeMSec', -1),
      replaced: g.text(wrapper, 'isReplaced') === 'true',
      editable: ['name', 'memo', 'replaced'],
    });
    const visit = (layer: Element, parent: string) => {
      const id = guid(layer),
        group = layer.tagName === 'CLayerGroup';
      const item = add(
        group ? 'sourceGroup' : 'sourceLayer',
        `layer:${id}`,
        g.text(layer, 'name'),
        parent,
        layer,
      );
      Object.assign(item, {
        guid: id,
        memo: g.text(layer, 'memo'),
        sourceKey: r.key,
        editable: group ? ['name', 'memo'] : ['name', 'memo', 'layerId'],
      });
      if (group) for (const child of g.list(layer, '_children')) visit(child, item.key);
      else {
        item.image = bitmap(g.field(layer, 'imageResource'));
        item.layerId = g.text(g.field(layer, 'layerIdentifier'), 'layerId');
        const bounds = g.field(layer, 'boundsOnImageDoc');
        item.width = g.number(bounds, 'width');
        item.height = g.number(bounds, 'height');
      }
    };
    for (const layer of g.list(g.field(image, '_rootLayer'), '_children')) visit(layer, r.key);
  }
  const meshByImage = new Map<string, string[]>();
  for (const mesh of g.sources('drawableSourceSet').filter((n) => n.tagName === 'CArtMeshSource')) {
    const extension = g
      .list(mesh, '_extensions')
      .find((n) => n.tagName === 'CTextureInputExtension');
    for (const input of g
      .list(extension || null, '_textureInputs')
      .filter((n) => n.tagName === 'CTextureInput_ModelImage')) {
      const id = g.guid(g.field(input, '_modelImageGuid'));
      if (id) meshByImage.set(id, [...(meshByImage.get(id) || []), guid(mesh)]);
    }
  }
  const atlases = g.list(manager, '_textureAtlases'),
    atlasByImage = new Map<string, string[]>();
  for (const atlas of atlases)
    for (const entry of g.list(atlas, 'modelImages')) {
      const id = g.guid(g.field(entry, 'modelImageGuid'));
      if (id) atlasByImage.set(id, [...(atlasByImage.get(id) || []), guid(atlas)]);
    }
  g.list(manager, '_modelImageGroups').forEach((group, index) => {
    // Native model-image groups have no GUID. Their address is an ordered collection slot.
    const parent = add(
      'modelGroup',
      `modelGroup:${index}`,
      g.text(group, 'groupName'),
      'modelRoot',
      group,
    );
    Object.assign(parent, { memo: g.text(group, 'memo'), editable: ['name', 'memo'] });
    for (const image of g.list(group, '_modelImages')) {
      const id = guid(image),
        r = add('modelImage', `model:${id}`, g.text(image, 'name'), parent.key, image);
      Object.assign(r, {
        guid: id,
        memo: g.text(image, 'memo'),
        image: bitmap(g.field(image, '_filteredImage')),
        editable: ['name', 'memo'],
        meshGuids: meshByImage.get(id) || [],
        modelImageKeys: [r.key],
        atlasGuids: atlasByImage.get(id) || [],
      });
      const values = g
        .list(g.field(image, 'inputFilterEnv'), 'envValues')
        .map((n) => g.field(g.field(n, 'value'), 'value'));
      const current = values.find((n) => n?.tagName === 'CLayeredImageGuid');
      const selector = values.find((n) => n?.tagName === 'CLayerSelectorMap');
      for (const entry of g.list(selector || null, '_imageToLayerInput')) {
        const rawGuid = g.guid(g.field(entry, 'key'));
        if (!rawGuid) continue;
        const sourceKey = `source:${rawGuid}`,
          raw = resources.find((n) => n.key === sourceKey);
        const input = add('imageInput', `input:${id}:${rawGuid}`, raw?.name || rawGuid, r.key);
        Object.assign(input, {
          sourceKey,
          current: rawGuid === g.guid(current || null),
          modelImageKeys: [r.key],
          meshGuids: [...r.meshGuids],
          atlasGuids: [...r.atlasGuids],
        });
        for (const link of children(g.field(entry, 'value')).map((n) => g.resolve(n)!)) {
          const layer = g.field(link, 'layer'),
            layerGuid = layer && guid(layer);
          const linked = resources.find((n) => n.key === `layer:${layerGuid}`);
          if (linked) linked.modelImageKeys.push(r.key);
        }
        if (raw) raw.modelImageKeys.push(r.key);
      }
    }
  });
  const byKey = new Map(resources.map((r) => [r.key, r]));
  for (const r of [...resources].reverse()) {
    if (r.kind.startsWith('source')) {
      r.meshGuids.push(...r.modelImageKeys.flatMap((key) => byKey.get(key)?.meshGuids || []));
      r.atlasGuids.push(...r.modelImageKeys.flatMap((key) => byKey.get(key)?.atlasGuids || []));
    }
    for (const field of ['modelImageKeys', 'meshGuids', 'atlasGuids'] as const) {
      r[field] = [
        ...new Set([...r[field], ...r.children.flatMap((key) => byKey.get(key)![field])]),
      ];
    }
  }
  const data: ProjectResources = {
    resources,
    textureMode:
      g.text(manager, 'isTextureInputModelImageMode') === 'false' ? 'atlas' : 'modelImage',
    sourceCount: rawImages.length,
    modelImageCount: resources.filter((r) => r.kind === 'modelImage').length,
    atlasCount: atlases.length,
  };
  return { data, nodes, wrappers };
}

export function editProjectResource(
  document: Cmo3Document,
  key: string,
  values: ProjectResourceProperties,
) {
  const index = projectIndex(document),
    resource = index.data.resources.find((r) => r.key === key),
    node = index.nodes.get(key);
  if (!resource || !node) throw new Error('Choose an editable Project resource.');
  const e = new XmlEdit(document.graph),
    g = e.g;
  for (const [field, value] of Object.entries(values)) {
    if (!resource.editable.includes(field as keyof ProjectResourceProperties))
      throw new Error('This resource property is read-only.');
    if (
      typeof value === 'string' &&
      (value.length > (field === 'memo' ? 16384 : 256) ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    )
      throw new Error('Invalid resource text.');
    if (resource[field as keyof ProjectResourceProperties] === value) continue;
    if (field === 'replaced') e.value(index.wrappers.get(key)!, 'isReplaced', value);
    else if (field === 'layerId') {
      const identifier = g.field(node, 'layerIdentifier');
      if (!identifier) throw new Error('This layer does not have an identifier.');
      e.field(
        identifier,
        'layerId',
        value ? e.scalar('s', 'layerId', value) : e.node('null', 'layerId'),
      );
    } else {
      e.value(
        node,
        field === 'name' && resource.kind === 'modelGroup' ? 'groupName' : field,
        value,
      );
      if (field === 'name' && resource.kind === 'sourceLayer') {
        const identifier = g.field(node, 'layerIdentifier');
        if (identifier) e.value(identifier, 'layerName', value);
      }
    }
  }
}

export function projectImageBytes(document: Cmo3Document, key: string) {
  const index = projectIndex(document),
    resource = index.data.resources.find((r) => r.key === key),
    node = index.nodes.get(key);
  if (!node || !resource?.image)
    throw new Error('Choose a source layer or model image with pixels.');
  const g = document.graph,
    image = g.field(node, resource.kind === 'modelImage' ? '_filteredImage' : 'imageResource');
  const path = g.field(image, 'imageFileBuf')?.getAttribute('path');
  if (!path) throw new Error('Image pixels are missing.');
  return document.archive.read(path);
}

/** Remove only unreferenced model images. Original layers and archive pixels remain intact. */
export function deleteProjectImages(document: Cmo3Document, keys: string[]) {
  const index = projectIndex(document),
    g = document.graph;
  const selected = [...new Set(keys)].map((key) => {
    const r = index.data.resources.find((r) => r.key === key);
    if (r?.kind !== 'modelImage') throw new Error('Choose model images to delete.');
    if (r.meshGuids.length || r.atlasGuids.length)
      throw new Error(`${r.name}: this image is still used by an ArtMesh or texture atlas.`);
    return r;
  });
  const removed = new Set(selected.map((r) => index.nodes.get(r.key)!)),
    guids = new Set(selected.map((r) => r.guid));
  const lists = g
    .list(g.field(g.source, 'textureManager'), '_modelImageGroups')
    .map((n) => g.field(n, '_modelImages')!);
  const entries = lists.flatMap((list) => children(list).filter((n) => removed.has(g.resolve(n)!)));
  const skipped = new Set(entries),
    visited = new Set<Element>();
  const check = (node: Element) => {
    if (skipped.has(node)) return;
    const resolved = g.resolve(node)!;
    if (
      removed.has(resolved) ||
      (resolved.tagName === 'CModelImageGuid' && guids.has(g.guid(resolved)!))
    )
      throw new Error('The model image is referenced by other native data.');
    if (visited.has(resolved)) return;
    visited.add(resolved);
    children(resolved).forEach(check);
  };
  check(g.source);
  // Move shared definitions out of inline collection entries before detaching them.
  const owned = new Set<Element>();
  const collect = (n: Element) => {
    owned.add(n);
    children(n).forEach(collect);
  };
  entries.forEach(collect);
  const shared = g.document.getElementsByTagName('shared')[0];
  for (const node of g.elements)
    if (!owned.has(node) && node.hasAttribute('xs.ref')) {
      const target = g.resolve(node)!;
      if (owned.has(target)) {
        shared.appendChild(target);
        owned.delete(target);
      }
    }
  for (const entry of entries)
    if (lists.includes(entry.parentNode as Element)) entry.parentNode!.removeChild(entry);
  for (const list of lists) list.setAttribute('count', String(children(list).length));
}
