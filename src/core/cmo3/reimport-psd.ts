import type { Element } from '@xmldom/xmldom';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { projectIndex } from './project';
import { children } from './xml';
import { matchPsdLayers } from './psd-layer-matching';
import { refreshModelImageMeshes } from './image-mesh';

/** Reconnect an imported PSD to existing model images, keeping the old source for native history. */
export function reimportPsd(d: Cmo3Document, oldKey: string, newKey: string, groupKey: string) {
  const index = projectIndex(d),
    e = new XmlEdit(d.graph),
    g = e.g;
  const oldSource = index.data.resources.find((r) => r.key === oldKey && r.kind === 'sourceImage');
  if (!oldSource || oldKey === newKey) throw new Error('Select an existing PSD source to replace.');
  const oldGuid = oldSource.guid!,
    newGuid = newKey.slice('source:'.length);
  const layers = (key: string) =>
    index.data.resources
      .filter((r) => r.sourceKey === key && r.kind === 'sourceLayer' && r.image)
      .map((r) => index.nodes.get(r.key)!);
  const pairs = matchPsdLayers(g, layers(oldKey), layers(newKey));
  const newGroup = index.nodes.get(groupKey)!;
  const targetGroup =
    g
      .list(g.field(g.source, 'textureManager'), '_modelImageGroups')
      .find(
        (n) =>
          n !== newGroup && g.list(n, '_linkedRawImageGuids').some((id) => g.guid(id) === oldGuid),
      ) || newGroup;
  const addedKeys = new Set<string>(),
    matchedKeys = new Map<string, string>(),
    updatedKeys = new Set<string>();
  const env = (image: Element) => {
    const values = g.list(g.field(image, 'inputFilterEnv'), 'envValues');
    const owner = (key: string) =>
      g.field(
        values.find((n) => g.field(n, 'key')?.getAttribute('idstr') === key) || null,
        'value',
      );
    return {
      current: owner('mi_currentImageGuid'),
      selector: g.field(owner('mi_input_layerInputData'), 'value'),
    };
  };
  const newImages = new Map<string, { key: string; image: Element }>();
  for (const image of g.list(newGroup, '_modelImages')) {
    e.ref(image);
    const key = `model:${g.guid(g.field(image, 'guid'))}`;
    const entry = g.list(env(image).selector, '_imageToLayerInput')[0];
    const input = children(g.field(entry, 'value')).map((n) => g.resolve(n)!)[0];
    const layerId = g.guid(g.field(g.field(input, 'layer'), 'guid'))!;
    newImages.set(layerId, { key, image });
    addedKeys.add(key);
  }
  for (const layer of pairs.values()) {
    const next = newImages.get(g.guid(g.field(layer, 'guid'))!);
    if (next) addedKeys.delete(next.key);
  }
  for (const resource of index.data.resources.filter(
    (r) => r.kind === 'modelImage' && r.parent !== groupKey,
  )) {
    const image = index.nodes.get(resource.key)!,
      inputs = env(image);
    const entry = g
      .list(inputs.selector, '_imageToLayerInput')
      .find((n) => g.guid(g.field(n, 'key')) === oldGuid);
    if (!entry) continue;
    const links = children(g.field(entry, 'value')).map((n) => g.resolve(n)!);
    const replacements = links.map((n) => pairs.get(g.guid(g.field(g.field(n, 'layer'), 'guid'))!));
    if (!replacements.some(Boolean)) continue;
    const filters = g
      .list(g.field(image, 'inputFilter'), 'filterMap')
      .map((n) => g.field(n, 'value')?.getAttribute('filterName'));
    if (
      !inputs.current ||
      !inputs.selector ||
      filters.length !== 2 ||
      !filters.includes('CLayerSelector') ||
      !filters.includes('CLayerFilter')
    )
      throw new Error(`${resource.name}: custom model-image filters cannot be reimported yet.`);
    // A compound filter needs its own raster compositor; never replace it with a single layer.
    if (links.length !== 1)
      throw new Error(`${resource.name}: compound model-image inputs cannot be reimported yet.`);
    const link = links[0],
      layer = replacements[0]!,
      transform = g.field(link, 'affine');
    if (
      ['m00', 'm11', 'm01', 'm10', 'm02', 'm12'].some(
        (k) =>
          Math.abs(
            g.number(transform, k, k === 'm00' || k === 'm11' ? 1 : 0) -
              (k === 'm00' || k === 'm11' ? 1 : 0),
          ) > 1e-7,
      ) ||
      g.field(link, 'clippingOnTexturePx')
    )
      throw new Error(
        `${resource.name}: transformed or cropped source filters cannot be reimported yet.`,
      );
    const next = newImages.get(g.guid(g.field(layer, 'guid'))!)!;
    const selectorList = g.field(inputs.selector, '_imageToLayerInput')!;
    e.append(
      selectorList,
      e.node('entry', undefined, {}, [
        e.guid('CLayeredImageGuid', 'key', newGuid),
        e.list('array_list', 'value', [
          e.node('CLayerInputData', undefined, {}, [
            e.ref(layer, 'layer'),
            e.copyOwned(transform!),
            e.node('null', 'clippingOnTexturePx'),
          ]),
        ]),
      ]),
    );
    e.field(inputs.current!, 'value', e.guid('CLayeredImageGuid', 'value', newGuid));
    for (const name of ['_filteredImage', 'cachedImageManager'])
      e.field(image, name, e.ref(g.field(next.image, name)!, name));
    e.field(
      image,
      '_materialLocalToCanvasTransform',
      e.copyOwned(g.field(next.image, '_materialLocalToCanvasTransform')!),
    );
    const linked = g.field(image, 'linkedRawImageGuids');
    if (linked) e.append(linked, e.guid('CLayeredImageGuid', '', newGuid));
    matchedKeys.set(next.key, resource.key);
    updatedKeys.add(resource.key);
  }
  e.value(index.wrappers.get(oldKey)!, 'isReplaced', true);
  // Cached-image managers just acquired IDs; move them out of temporary images before pruning.
  g.normalize();
  const manager = g.field(g.source, 'textureManager')!;
  const remaining = g
    .list(newGroup, '_modelImages')
    .filter((image) => addedKeys.has(`model:${g.guid(g.field(image, 'guid'))}`));
  e.field(
    newGroup,
    '_modelImages',
    e.list(
      'carray_list',
      '_modelImages',
      remaining.map((n) => e.ref(n)),
    ),
  );
  if (targetGroup !== newGroup) {
    const targetImages = g.field(targetGroup, '_modelImages')!;
    for (const image of remaining) {
      e.field(image, '_group', e.ref(targetGroup, '_group'));
      e.append(targetImages, e.ref(image));
    }
    // Normalize before removing the temporary group so shared image definitions remain reachable.
    g.normalize();
    const groups = g.field(manager, '_modelImageGroups')!;
    const ref = children(groups).find((n) => g.resolve(n) === newGroup)!;
    groups.removeChild(ref);
    groups.setAttribute('count', String(children(groups).length));
  }
  const groupLinks = g.field(targetGroup, '_linkedRawImageGuids')!;
  if (!children(groupLinks).some((n) => g.guid(n) === newGuid))
    e.append(groupLinks, e.guid('CLayeredImageGuid', '', newGuid));
  d.graph.normalize();
  d.refreshModel();
  refreshModelImageMeshes(d, updatedKeys);
  const unmatched = layers(oldKey).length - pairs.size;
  return { addedKeys, matchedKeys, updatedKeys, unmatched };
}
