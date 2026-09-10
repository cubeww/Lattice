import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Element } from '@xmldom/xmldom';
import type { Locale } from '../../shared/types';
import { decodePsd, type PsdLayer } from '../psd';
import { Cmo3Document } from './document';
import { newModel } from './new-model';
import { XmlEdit } from './edit';
import { partSource } from './parts';
import { imageFilter, imageAffine } from './image-filter';
import { createMeshesFromImages, setTextureMode } from './image-mesh';
import { reimportPsd } from './reimport-psd';
import { projectIndex } from './project';
import { refreshPsdAtlases } from './atlas';
import type { PsdImportOptions } from '../../shared/psd';

/** Build native source layers, model images, Part folders and editable ArtMeshes. */
export function importPsd(
  bytes: Buffer,
  path: string,
  locale: Locale,
  modifiedAt: number,
  target?: { document: Cmo3Document; options: Exclude<PsdImportOptions, { mode: 'newModel' }> },
) {
  const psd = decodePsd(bytes),
    name = basename(path, extname(path));
  let document = target
    ? target.document.withXml(target.document.xml())
    : newModel(locale, {
        name,
        width: psd.width,
        height: psd.height,
        defaultParts: false,
      });
  if (target) setTextureMode(document, 'modelImage');
  const e = new XmlEdit(document.graph),
    g = e.g;
  // Cubism initializes classes while reading imports. The blend registry must
  // load before concrete modes to avoid their circular static initializers.
  e.imports(['com.live2d.graphics.psd.blend.ACBlend']);
  const raw = e.identified(e.node('CLayeredImage')),
    rawGuid = e.guid('CLayeredImageGuid', 'guid'),
    rawId = rawGuid.getAttribute('uuid')!,
    group = e.identified(e.node('CModelImageGroup')),
    modelImages = e.list('carray_list', '_modelImages'),
    resources = new Map<string, Buffer>(),
    layerEntries: Element[] = [],
    meshLayers: { layer: PsdLayer; key: string }[] = [],
    partIds = new Map<PsdLayer, string>();
  const resourcePrefix = `psd-${randomUUID()}`;
  const icon = (name: string) => e.node('CImageIcon', name, {}, [e.node('null', 'image')]);
  const createLayer = (layer: PsdLayer, parent: Element | null): Element => {
    const node = e.identified(e.node(layer.children ? 'CLayerGroup' : 'CLayer'));
    layerEntries.push(node);
    const blend = layer.children
      ? 'CBlend_PassThrough'
      : { normal: 'CBlend_Normal', multiply: 'CBlend_Multiply', add: 'CBlend_LinearDodge' }[
          layer.blend
        ];
    const common = e.node('ACLayerEntry', 'super', {}, [
      e.scalar('s', 'name', layer.name),
      e.scalar('s', 'memo', ''),
      e.scalar('b', 'isVisible', layer.visible),
      e.scalar('b', 'isClipping', layer.clipping),
      e.node(blend, 'blend', {}, [e.node('ACBlend', 'super')]),
      e.guid('CLayerGuid', 'guid'),
      parent ? e.ref(parent, 'group') : e.node('null', 'group'),
      e.scalar('i', 'opacity255', Math.round(layer.opacity * 255)),
      e.scalar('b', 'isTransparencyShapesLayer', true),
      e.node('hash_map', '_optionOfIOption', { count: 0, keyType: 'string' }),
      e.ref(raw, '_layeredImage'),
    ]);
    e.imports(['com.live2d.graphics.psd.blend.' + blend]);
    if (layer.children) {
      node.appendChild(
        e.node('ACLayerGroup', 'super', {}, [
          common,
          e.list(
            'carray_list',
            '_children',
            layer.children.map((child) => createLayer(child, node)),
          ),
        ]),
      );
    } else {
      node.appendChild(e.node('ACImageLayer', 'super', {}, [common]));
      let image: Element;
      if (layer.png) {
        const entry = `${resourcePrefix}-${resources.size}.png`;
        resources.set(entry, layer.png);
        image = e.identified(
          e.node(
            'CImageResource',
            'imageResource',
            {
              width: layer.width,
              height: layer.height,
              type: 'INT_ARGB',
              imageFileBuf_size: layer.png.length,
              previewFileBuf_size: 0,
            },
            [e.node('file', 'imageFileBuf', { path: entry })],
          ),
        );
      } else image = e.node('null', 'imageResource');
      for (const field of [
        image,
        e.node('CRect', 'boundsOnImageDoc', {}, [
          e.scalar('i', 'x', layer.x),
          e.scalar('i', 'y', layer.y),
          e.scalar('i', 'width', layer.width),
          e.scalar('i', 'height', layer.height),
        ]),
        e.node('CLayerIdentifier', 'layerIdentifier', {}, [
          e.scalar('s', 'layerName', layer.name),
          e.scalar(
            's',
            'layerId',
            (layer.layerId >>> 0).toString(16).padStart(8, '0').match(/../g)!.join('-'),
          ),
          e.scalar('i', 'layerIdValue_testImpl', layer.layerId),
        ]),
        icon('icon16'),
        icon('icon64'),
        e.node('linked_map', 'layerInfo', { count: 0, keyType: 'string' }),
        e.node('hash_map', '_optionOfIOption', { count: 0, keyType: 'string' }),
      ])
        node.appendChild(field);
      if (layer.png) {
        const guid = e.guid('CModelImageGuid', 'guid'),
          key = 'model:' + guid.getAttribute('uuid');
        const model = e.node('CModelImage', undefined, { modelImageVersion: 0 }, [
          guid,
          e.scalar('s', 'name', layer.name),
          ...imageFilter(e, node, rawId),
          e.ref(image, '_filteredImage'),
          icon('icon16'),
          imageAffine(e, '_materialLocalToCanvasTransform', layer.x, layer.y),
          e.ref(group, '_group'),
          e.list('carray_list', 'linkedRawImageGuids', [e.guid('CLayeredImageGuid', '', rawId)]),
          e.node('CCachedImageManager', 'cachedImageManager', {}, [
            e.node('CachedImageType', 'defaultCacheType', { v: 'SCALE_1' }),
            e.ref(image, 'rawImage'),
            e.list('array_list', 'cachedImages', [
              e.node('CCachedImage', undefined, {}, [
                e.ref(image, '_cachedImageResource'),
                e.scalar('b', 'isSharedImage', true),
                e.node('CSize', 'rawImageSize', { width: layer.width, height: layer.height }),
                e.scalar('i', 'reductionRatio', 1),
                e.scalar('i', 'mipmapLevel', 64),
                e.scalar('b', 'hasMargin', false),
                e.scalar('b', 'isCleaned', false),
                imageAffine(
                  e,
                  'transformRawImageToCachedImage',
                  0,
                  0,
                  layer.width / (Math.ceil(layer.width / 64) * 64),
                  layer.height / (Math.ceil(layer.height / 64) * 64),
                ),
              ]),
            ]),
            e.scalar('i', 'requiredMipmapLevel', 64),
          ]),
          e.scalar('s', 'memo', ''),
        ]);
        e.append(modelImages, model);
        meshLayers.push({ layer, key });
      }
    }
    return node;
  };
  const rootLayer = createLayer(
    {
      name: 'root',
      layerId: 0,
      visible: true,
      opacity: 1,
      clipping: false,
      blend: 'normal',
      x: 0,
      y: 0,
      width: psd.width,
      height: psd.height,
      children: psd.layers,
    },
    null,
  );
  for (const field of [
    e.scalar('s', 'name', basename(path)),
    e.scalar('s', 'memo', ''),
    e.scalar('i', 'width', psd.width),
    e.scalar('i', 'height', psd.height),
    e.scalar('file', 'psdFile', path),
    e.scalar('s', 'description', ''),
    rawGuid,
    e.node('null', 'psdBytes'),
    e.scalar('l', 'psdFileLastModified', Math.floor(modifiedAt)),
    rootLayer,
    e.node('LayerSet', 'layerSet', {}, [
      e.ref(raw, '_layeredImage'),
      e.list(
        'carray_list',
        '_layerEntryList',
        layerEntries.map((n) => e.ref(n)),
      ),
    ]),
    e.node('null', 'icon16'),
    e.node('null', 'icon64'),
  ])
    raw.appendChild(field);
  rootLayer.setAttribute('xs.n', '_rootLayer');
  for (const field of [
    e.scalar('s', 'memo', ''),
    e.scalar('s', 'groupName', name),
    e.list('carray_list', '_linkedRawImageGuids', [e.guid('CLayeredImageGuid', '', rawId)]),
    modelImages,
  ])
    group.appendChild(field);
  const manager = g.field(g.source, 'textureManager')!;
  e.append(
    g.field(manager, '_rawImages')!,
    e.node('LayeredImageWrapper', undefined, {}, [
      raw,
      e.scalar('l', 'importedTimeMSec', Date.now()),
      e.scalar('l', 'lastModifiedTimeMSec', Math.floor(modifiedAt)),
      e.scalar('b', 'isReplaced', false),
    ]),
  );
  raw.setAttribute('xs.n', 'image');
  e.append(g.field(manager, '_modelImageGroups')!, group);
  e.imports([
    'com.live2d.cubism.doc.model.texture.LayeredImageWrapper',
    ...['CModelImage', 'CModelImageGroup'].map(
      (s) => 'com.live2d.cubism.doc.model.texture.modelImage.' + s,
    ),
    ...[
      'ACImageLayer',
      'ACLayerEntry',
      'ACLayerGroup',
      'CLayer',
      'CLayerGroup',
      'CLayerIdentifier',
      'CLayeredImage',
      'LayerSet',
    ].map((s) => 'com.live2d.cubism.doc.resources.' + s),
    'com.live2d.graphics.CImageResource',
    ...['CCachedImage', 'CCachedImageManager', 'CachedImageType'].map(
      (s) => 'com.live2d.graphics.cachedImage.' + s,
    ),
    ...['CLayerGuid', 'CLayeredImageGuid', 'CModelImageGuid', 'CRect', 'CSize'].map(
      (s) => 'com.live2d.type.' + s,
    ),
  ]);
  e.versions({ CModelImage: 3, CArtMeshSource: 5 });
  resources.set(document.archive.mainPath, Buffer.from(document.xml()));
  document = document.withArchive(document.archive.replace(resources));
  const groupKey = `modelGroup:${document.graph.list(document.graph.field(document.graph.source, 'textureManager'), '_modelImageGroups').length - 1}`;
  const replaced =
    target?.options.mode === 'replaceSource'
      ? reimportPsd(document, target.options.sourceKey, `source:${rawId}`, groupKey)
      : null;
  if (replaced?.unmatched)
    psd.warnings.push(
      `${replaced.unmatched} previous PSD layer(s) had no matching replacement; their artwork and modeling were retained.`,
    );
  const added = meshLayers.filter((n) => !replaced || replaced.addedKeys.has(n.key));
  const addedLayers = new Set(added.map((n) => n.layer));
  const hasAdded = (layer: PsdLayer): boolean =>
    addedLayers.has(layer) || !!layer.children?.some(hasAdded);
  const parts = new XmlEdit(document.graph),
    usedIds = new Set(document.model.objects.map((o) => o.id));
  let nextId = 1;
  const addPart = (name: string, parent: string, visible: boolean) => {
    while (usedIds.has(`PartPSD${nextId}`)) nextId++;
    const id = `PartPSD${nextId++}`;
    usedIds.add(id);
    const part = partSource(parts, { name, id, drawOrder: 500 }, parent);
    parts.addSource('partSourceSet', part.source, parent);
    parts.value(part.source, 'isVisible', visible);
    return part.id;
  };
  const root =
    target && added.length
      ? addPart(basename(path), document.model.rootPartGuid!, true)
      : document.model.rootPartGuid!;
  if (target && added.length) {
    const siblings = parts.g.field(parts.source(document.model.rootPartGuid!), '_childGuids')!;
    siblings.insertBefore(siblings.lastChild!, siblings.firstChild);
  }
  const addParts = (layers: PsdLayer[], parent: string) => {
    for (const layer of layers)
      if (layer.children && hasAdded(layer)) {
        const id = addPart(layer.name, parent, layer.visible);
        partIds.set(layer, id);
        addParts(layer.children, id);
      }
  };
  addParts(psd.layers, root);
  document = document.withXml(document.xml());
  // Existing image-to-mesh authoring supplies native texture inputs, mesh topology
  // and editable keyforms. Restore the PSD tree order after creating the meshes.
  const ids = added.length
    ? createMeshesFromImages(
        document,
        added.map((n) => n.key),
        target && added.length ? [root] : [],
      )
    : [];
  document = document.withXml(document.xml());
  const writer = new XmlEdit(document.graph),
    meshIds = new Map(added.map((n, i) => [n.layer, ids[i]]));
  const currentImages = projectIndex(document).data.resources;
  const previousMesh = new Map(
    meshLayers.flatMap((n): [PsdLayer, string][] => {
      const key = replaced?.matchedKeys.get(n.key);
      const guid = key && currentImages.find((r) => r.key === key)?.meshGuids[0];
      return guid ? [[n.layer, guid]] : [];
    }),
  );
  const arrange = (layers: PsdLayer[], parent: string) => {
    const children = layers.flatMap((layer) => {
      const id = partIds.get(layer) || meshIds.get(layer);
      if (!id) return [];
      const node = writer.source(id);
      writer.field(node, 'parentGuid', writer.guid('CPartGuid', 'parentGuid', parent));
      if (layer.children) arrange(layer.children, id);
      else {
        writer.value(node, 'isVisible', layer.visible);
        writer.value(writer.g.list(node, 'keyforms')[0], 'opacity', layer.opacity);
        writer.field(
          node,
          'colorComposition',
          writer.node('ColorComposition', 'colorComposition', {
            v: { normal: 'NORMAL', multiply: 'MULTIPLY', add: 'ADD' }[layer.blend],
          }),
        );
        if (layer.clipping) {
          const base = layers.slice(layers.indexOf(layer) + 1).find((n) => !n.clipping);
          const clip = base && (meshIds.get(base) || previousMesh.get(base));
          if (!clip)
            throw new Error(`PSD layer “${layer.name}”: clipping requires a raster base layer.`);
          writer.field(
            node,
            'clipGuidList',
            writer.list('carray_list', 'clipGuidList', [writer.guid('CDrawableGuid', '', clip)]),
          );
        }
      }
      return [writer.guid(layer.children ? 'CPartGuid' : 'CDrawableGuid', '', id)];
    });
    writer.field(
      writer.source(parent),
      '_childGuids',
      writer.list('carray_list', '_childGuids', children),
    );
  };
  if (added.length) arrange(psd.layers, root);
  document.graph.normalize();
  document.refreshModel();
  if (replaced) {
    const archive = refreshPsdAtlases(document, replaced.updatedKeys);
    if (archive) document = document.withArchive(archive);
  }
  return {
    document: target ? document : new Cmo3Document(document.serialize(), null, undefined, ''),
    warnings: psd.warnings,
    addedGuids: target && added.length ? [root] : ids,
    sourceKey: `source:${rawId}`,
  };
}
