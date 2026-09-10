import { PNG } from 'pngjs';
import { randomUUID } from 'node:crypto';
import { paintAtlasImage } from './atlas-paint';
import type { Element } from '@xmldom/xmldom';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { children } from './xml';
import { readSourceScene } from './scene';
import {
  atlasMatrix,
  atlasBounds,
  type TextureAtlas,
  type AtlasEdit,
  type AtlasItem,
  type AtlasImage,
  type AtlasWorkspace,
} from '../../shared/atlas';

/** Active model images, including images which have never belonged to an atlas. */
export function readAtlasImages(
  document: Cmo3Document,
  imageUrl: (path: string) => string = (path) =>
    'data:image/png;base64,' + document.archive.read(path).toString('base64'),
): AtlasImage[] {
  const g = document.graph,
    meshes = new Map<string, string[]>();
  for (const mesh of g.sources('drawableSourceSet')) {
    if (mesh.tagName !== 'CArtMeshSource') continue;
    const extension = g
      .list(mesh, '_extensions')
      .find((n) => n.tagName === 'CTextureInputExtension');
    for (const input of g.list(extension || null, '_textureInputs'))
      if (input.tagName === 'CTextureInput_ModelImage') {
        const id = g.guid(g.field(input, '_modelImageGuid'))!;
        const references = meshes.get(id) || [];
        references.push(g.guid(g.field(mesh, 'guid'))!);
        meshes.set(id, references);
      }
  }
  return g
    .list(g.field(g.source, 'textureManager'), '_modelImageGroups')
    .flatMap((group) => g.list(group, '_modelImages'))
    .flatMap((image) => {
      const resource = g.field(image, '_filteredImage'),
        path = g.field(resource, 'imageFileBuf')?.getAttribute('path'),
        width = g.number(resource, 'width'),
        height = g.number(resource, 'height'),
        guid = g.guid(g.field(image, 'guid'))!;
      if (!path || width <= 0 || height <= 0) return [];
      return [
        {
          guid,
          name: g.text(image, 'name'),
          width,
          height,
          url: imageUrl(path),
          meshGuids: meshes.get(guid) || [],
        },
      ];
    });
}

export function readAtlasWorkspace(
  document: Cmo3Document,
  imageUrl?: (path: string) => string,
): AtlasWorkspace {
  const images = readAtlasImages(document, imageUrl),
    atlases = readAtlases(document, imageUrl, images),
    assigned = new Set(atlases.flatMap((a) => a.items.map((i) => i.guid)));
  return { atlases, unassigned: images.filter((i) => !assigned.has(i.guid)) };
}

export function readAtlases(
  document: Cmo3Document,
  imageUrl: (path: string) => string = (path) =>
    'data:image/png;base64,' + document.archive.read(path).toString('base64'),
  images = readAtlasImages(document, imageUrl),
): TextureAtlas[] {
  const g = document.graph,
    manager = g.field(g.source, 'textureManager'),
    modelImages = g
      .list(manager, '_modelImageGroups')
      .flatMap((group) => g.list(group, '_modelImages'));
  const list = g.field(manager, '_textureAtlases');
  return children(list || null)
    .map((n) => g.resolve(n)!)
    .map((atlas) => ({
      guid: g.guid(g.field(atlas, 'guid'))!,
      name: g.text(atlas, 'name'),
      width: g.number(atlas, 'width'),
      height: g.number(atlas, 'height'),
      items: g.list(atlas, 'modelImages').map((entry) => {
        const guid = g.guid(g.field(entry, 'modelImageGuid'))!,
          image = modelImages.find((i) => g.guid(g.field(i, 'guid')) === guid);
        if (!image) throw new Error('Atlas model image is missing.');
        const resource = g.field(image, '_filteredImage'),
          path = g.field(resource, 'imageFileBuf')?.getAttribute('path');
        if (!path) throw new Error('Atlas source image is missing.');
        const placement = g.field(entry, 'materialLocalToAtlasTransform'),
          position = g.field(placement, 'position'),
          scale = g.field(placement, 'scale');
        // Version 2 stores Atlas→Canvas; derive Image→Atlas when the optional editor transform is absent.
        let x = g.number(position, 'x'),
          y = g.number(position, 'y'),
          scaleX = g.number(scale, 'x', 1),
          scaleY = g.number(scale, 'y', 1),
          angle = g.number(placement, 'eulerAngle');
        if (!placement) {
          const a = affine(g.field(entry, 'atlasLocalToCanvasTransform'), g),
            b = affine(g.field(image, '_materialLocalToCanvasTransform'), g),
            m = multiply(inverse(a), b);
          x = m[4];
          y = m[5];
          scaleX = Math.hypot(m[0], m[1]);
          scaleY = Math.hypot(m[2], m[3]);
          angle = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
        }
        const info = images.find((i) => i.guid === guid);
        if (!info) throw new Error('Atlas source image is missing.');
        return {
          ...info,
          x,
          y,
          scaleX,
          scaleY,
          angle,
        };
      }),
    }));
}
type Matrix = readonly number[];
const affine = (n: Element | null, g: Cmo3Document['graph']) => [
  g.number(n, 'm00', 1),
  g.number(n, 'm10'),
  g.number(n, 'm01'),
  g.number(n, 'm11', 1),
  g.number(n, 'm02'),
  g.number(n, 'm12'),
];
const inverse = (m: Matrix) => {
  const [a, b, c, d, x, y] = m,
    det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('Atlas transform is singular.');
  return [d / det, -b / det, -c / det, a / det, (c * y - d * x) / det, (b * x - a * y) / det];
};
const multiply = (a: Matrix, b: Matrix) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** Refresh PSD artwork in place, retaining the native atlas-to-canvas mapping. */
export function refreshPsdAtlases(document: Cmo3Document, modelKeys: Set<string>): Buffer | null {
  const e = new XmlEdit(document.graph),
    g = e.g;
  const atlases = g
    .list(g.field(g.source, 'textureManager'), '_textureAtlases')
    .filter((atlas) =>
      g
        .list(atlas, 'modelImages')
        .some((entry) => modelKeys.has(`model:${g.guid(g.field(entry, 'modelImageGuid'))}`)),
    );
  if (!atlases.length) return null;
  for (const atlas of atlases)
    for (const entry of g.list(atlas, 'modelImages')) {
      // This optional editor transform is a snapshot of the previous PSD bounds.
      // Version 2's atlas-to-canvas transform remains authoritative after reimport.
      if (modelKeys.has(`model:${g.guid(g.field(entry, 'modelImageGuid'))}`))
        e.field(
          entry,
          'materialLocalToAtlasTransform',
          e.node('null', 'materialLocalToAtlasTransform'),
        );
    }
  const layouts = readAtlases(document),
    replacements = new Map<string, Buffer>();
  for (const atlas of atlases) {
    const layout = layouts.find((a) => a.guid === g.guid(g.field(atlas, 'guid')))!;
    const png = new PNG({ width: layout.width, height: layout.height });
    layout.items.forEach((item) => paintAtlasImage(png, item));
    const bytes = PNG.sync.write(png),
      resource = g.field(atlas, 'cachedAtlasImage')!;
    const path = g.field(resource, 'imageFileBuf')!.getAttribute('path')!;
    replacements.set(path, bytes);
    e.value(resource, 'imageFileBuf_size', bytes.length);
    e.field(atlas, 'lockCachedAtlasImage', e.scalar('b', 'lockCachedAtlasImage', false));
    e.field(
      atlas,
      'cachedImageManager',
      e.node('CCachedImageManager', 'cachedImageManager', {}, [
        e.node('CachedImageType', 'defaultCacheType', { v: 'SCALE_1' }),
        e.ref(resource, 'rawImage'),
        e.list('array_list', 'cachedImages'),
        e.scalar('i', 'requiredMipmapLevel', 64),
      ]),
    );
  }
  replacements.set(document.archive.mainPath, Buffer.from(document.xml()));
  return document.archive.replace(replacements);
}

export function editAtlases(document: Cmo3Document, input: AtlasEdit[]): Buffer {
  if (new Set(input.map((a) => a.guid)).size !== input.length)
    throw new Error('Atlas page GUIDs must be unique.');
  const e = new XmlEdit(document.graph),
    g = e.g,
    images = readAtlasImages(document),
    existing = readAtlases(document, undefined, images),
    oldItems = new Map(existing.flatMap((a) => a.items).map((i) => [i.guid, i])),
    allItems = new Map(images.map((i) => [i.guid, i])),
    seen = new Set<string>(),
    replacements = new Map<string, Buffer>(),
    sourceScene = readSourceScene(document).scene;
  const oldAtlases = g.elements.filter(
      (n) => n.tagName === 'CTextureAtlas' && !n.hasAttribute('xs.ref'),
    ),
    list = g.field(g.field(g.source, 'textureManager'), '_textureAtlases');
  if (!list) throw new Error('Texture atlas collection not found.');
  const vector = (name: string, x: number, y: number) =>
    e.node('GVector2', name, {}, [
      e.scalar('f', 'x', Math.fround(x)),
      e.scalar('f', 'y', Math.fround(y)),
    ]);
  const toAffine = (name: string, m: Matrix) =>
    e.node('CAffine', name, { m00: m[0], m10: m[1], m01: m[2], m11: m[3], m02: m[4], m12: m[5] });
  const imageAtlases = new Map<string, { guid: string; transform: Matrix }>();
  const atlasNodes = input.map((value) => {
    const original = oldAtlases.find((a) => g.guid(g.field(a, 'guid')) === value.guid),
      atlas = original || e.identified(e.node('CTextureAtlas'));
    const png = new PNG({ width: value.width, height: value.height }),
      entries: Element[] = [];
    for (const placement of value.items) {
      const image = allItems.get(placement.guid);
      if (!image) throw new Error('The model image no longer exists. Reopen the atlas editor.');
      if (seen.has(image.guid)) throw new Error('A model image can belong to only one atlas.');
      seen.add(image.guid);
      const item: AtlasItem = { ...placement, ...image },
        bounds = atlasBounds(item);
      if (
        bounds.x < -0.01 ||
        bounds.y < -0.01 ||
        bounds.x + bounds.width > value.width + 0.01 ||
        bounds.y + bounds.height > value.height + 0.01
      )
        throw new Error(
          `${image.name}: image exceeds atlas bounds. Use automatic layout or a larger atlas.`,
        );
      const matrix = atlasMatrix(item);
      paintAtlasImage(png, item);
      const modelImage = g.elements.find(
        (n) =>
          n.tagName === 'CModelImage' &&
          !n.hasAttribute('xs.ref') &&
          g.guid(g.field(n, 'guid')) === item.guid,
      )!;
      const imageToCanvas = affine(g.field(modelImage, '_materialLocalToCanvasTransform'), g),
        atlasToCanvas = multiply(imageToCanvas, inverse(matrix));
      imageAtlases.set(item.guid, { guid: value.guid, transform: atlasToCanvas });
      entries.push(
        e.node('ModelImageEntry', undefined, {}, [
          e.ref(atlas, 'atlas'),
          e.ref(g.field(modelImage, 'guid')!, 'modelImageGuid'),
          toAffine('atlasLocalToCanvasTransform', atlasToCanvas),
          e.node('GTransform2', 'materialLocalToAtlasTransform', {}, [
            vector('position', item.x, item.y),
            vector('scale', item.scaleX, item.scaleY),
            e.scalar('f', 'eulerAngle', item.angle),
          ]),
        ]),
      );
    }
    const data = PNG.sync.write(png),
      oldResource = original ? g.field(original, 'cachedAtlasImage') : null,
      path =
        g.field(oldResource, 'imageFileBuf')?.getAttribute('path') || `atlas_${randomUUID()}.png`,
      resource = e.identified(
        e.node(
          'CImageResource',
          'cachedAtlasImage',
          {
            width: value.width,
            height: value.height,
            type: 'INT_ARGB',
            imageFileBuf_size: data.length,
            previewFileBuf_size: 0,
          },
          [e.node('file', 'imageFileBuf', { path })],
        ),
      );
    replacements.set(path, data);
    e.field(atlas, 'name', e.scalar('s', 'name', value.name));
    e.field(atlas, 'width', e.scalar('i', 'width', value.width));
    e.field(atlas, 'height', e.scalar('i', 'height', value.height));
    e.field(atlas, 'cachedAtlasImage', resource);
    e.field(atlas, 'lockCachedAtlasImage', e.scalar('b', 'lockCachedAtlasImage', false));
    e.field(atlas, 'modelImages', e.list('carray_list', 'modelImages', entries));
    if (!original) e.field(atlas, 'guid', e.guid('CTextureAtlasGuid', 'guid', value.guid));
    e.field(
      atlas,
      'cachedImageManager',
      e.node('CCachedImageManager', 'cachedImageManager', {}, [
        e.node('CachedImageType', 'defaultCacheType', { v: 'SCALE_1' }),
        e.ref(resource, 'rawImage'),
        e.list('array_list', 'cachedImages'),
        e.scalar('i', 'requiredMipmapLevel', 64),
      ]),
    );
    return atlas;
  });
  while (list.firstChild) list.removeChild(list.firstChild);
  atlasNodes.forEach((n) => e.append(list, e.ref(n)));
  // New definitions must remain attached to the document for shared-reference serialization.
  const shared = g.document.getElementsByTagName('shared')[0];
  for (const atlas of atlasNodes) if (!atlas.parentNode) shared.appendChild(atlas);
  // Retain model-image coordinates when atlas pixels move; the editor derives atlas UVs from entries.
  for (const mesh of g.sources('drawableSourceSet').filter((n) => n.tagName === 'CArtMeshSource')) {
    const ext = g.list(mesh, '_extensions').find((n) => n.tagName === 'CTextureInputExtension');
    if (!ext) continue;
    const modelInput = g
      .list(ext, '_textureInputs')
      .find((n) => n.tagName === 'CTextureInput_ModelImage');
    if (!modelInput) throw new Error('Mesh requires a model image before editing its atlas.');
    if (g.field(mesh, 'textureState')?.getAttribute('v') === 'TEXTURE_ATLAS') {
      const id = g.guid(g.field(modelInput, '_modelImageGuid')),
        image = g.elements.find(
          (n) =>
            n.tagName === 'CModelImage' &&
            !n.hasAttribute('xs.ref') &&
            g.guid(g.field(n, 'guid')) === id,
        );
      if (!image) throw new Error('Mesh model image is missing.');
      const resource = g.field(image, '_filteredImage')!,
        width = g.number(resource, 'width'),
        height = g.number(resource, 'height'),
        original = sourceScene.meshes.find((m) => m.guid === g.guid(g.field(mesh, 'guid')))!,
        oldTexture = sourceScene.textures[original.texture],
        oldPlacement = oldItems.get(id!);
      if (!oldPlacement) throw new Error('The current mesh atlas placement is missing.');
      const imageFromAtlas = inverse(atlasMatrix(oldPlacement)),
        pixels = original.uvs.map((v, i) =>
          i % 2
            ? imageFromAtlas[1] * original.uvs[i - 1] * oldTexture.width +
              imageFromAtlas[3] * v * oldTexture.height +
              imageFromAtlas[5]
            : imageFromAtlas[0] * v * oldTexture.width +
              imageFromAtlas[2] * original.uvs[i + 1] * oldTexture.height +
              imageFromAtlas[4],
        );
      // Cubism pads GPU textures to the mipmap alignment. Its serialized UVs use
      // that logical size, while the PNG and our renderer use the image size.
      const logicalWidth = Math.ceil(width / 64) * 64,
        logicalHeight = Math.ceil(height / 64) * 64,
        uv = pixels.map((v, i) => v / (i % 2 ? logicalHeight : logicalWidth));
      e.field(mesh, 'uvs', e.array('float-array', 'uvs', uv));
      const toCanvas = multiply(
          affine(g.field(modelInput, 'optionalTransformOnCanvas'), g),
          affine(g.field(image, '_materialLocalToCanvasTransform'), g),
        ),
        positions = pixels.map((v, i) =>
          i % 2
            ? toCanvas[1] * pixels[i - 1] + toCanvas[3] * v + toCanvas[5]
            : toCanvas[0] * v + toCanvas[2] * pixels[i + 1] + toCanvas[4],
        );
      e.field(mesh, 'positions', e.array('float-array', 'positions', positions));
      const editable = g.field(
        g.list(mesh, '_extensions').find((n) => n.tagName === 'CEditableMeshExtension') || null,
        'editableMesh',
      );
      if (editable) e.field(editable, 'point', e.array('float-array', 'point', positions));
      const texture = e.identified(e.node('GTexture2D', 'texture'));
      texture.appendChild(
        e.node('GTexture', 'super', {}, [
          e.scalar('s', 'name', g.text(image, 'name')),
          e.node('WrapMode', 'wrapMode', { v: 'CLAMP_TO_BORDER' }),
          e.node('FilterMode', 'filterMode', {}, [
            e.ref(texture, 'owner'),
            e.node('MinFilter', 'minFilter', { v: 'LINEAR_MIPMAP_LINEAR' }),
            e.node('MagFilter', 'magFilter', { v: 'LINEAR' }),
          ]),
          e.guid('GTextureGuid', 'guid'),
          e.node('Anisotropy', 'anisotropy', { v: 'ON' }),
        ]),
      );
      for (const n of [
        e.ref(resource, 'srcImageResource'),
        toAffine('transformImageResource01toLogical01', [
          width / logicalWidth,
          0,
          0,
          height / logicalHeight,
          0,
          0,
        ]),
        e.scalar('i', 'mipmapLevel', 64),
        e.scalar('b', 'isPremultiplied', true),
      ])
        texture.appendChild(n);
      e.field(mesh, 'texture', texture);
    }
    let atlasInput = g
      .list(ext, '_textureInputs')
      .find((n) => n.tagName === 'CTextureInput_TextureAtlasRegion');
    const placement = imageAtlases.get(g.guid(g.field(modelInput, '_modelImageGuid'))!);
    if (placement) {
      if (!atlasInput) {
        atlasInput = e.identified(
          e.node('CTextureInput_TextureAtlasRegion', undefined, {}, [
            e.node('ACTextureInput', 'super', {}, [
              toAffine('optionalTransformOnCanvas', [1, 0, 0, 1, 0, 0]),
              e.ref(ext, '_owner'),
            ]),
          ]),
        );
        e.append(g.field(ext, '_textureInputs')!, atlasInput);
      }
      e.field(
        atlasInput,
        'textureAtlasGuid',
        e.guid('CTextureAtlasGuid', 'textureAtlasGuid', placement.guid),
      );
      e.field(
        atlasInput,
        'inputImageLocalToCanvasTransform',
        toAffine(
          'inputImageLocalToCanvasTransform',
          multiply(
            affine(g.field(modelInput, 'optionalTransformOnCanvas'), g),
            placement.transform,
          ),
        ),
      );
    } else if (atlasInput) {
      const inputs = g.field(ext, '_textureInputs')!;
      for (const input of children(inputs))
        if (g.resolve(input) === atlasInput) inputs.removeChild(input);
      inputs.setAttribute('count', String(children(inputs).length));
    }
    e.field(ext, 'currentTextureInputData', e.ref(modelInput, 'currentTextureInputData'));
    e.field(mesh, 'textureState', e.node('TextureState', 'textureState', { v: 'MODEL_IMAGE' }));
  }
  e.value(g.field(g.source, 'textureManager')!, 'isTextureInputModelImageMode', true);
  e.imports([
    'com.live2d.graphics.CImageResource',
    'com.live2d.cubism.doc.model.texture.textureAtlas.CTextureAtlas',
    'com.live2d.cubism.doc.model.texture.textureAtlas.CTextureAtlas$ModelImageEntry',
    'com.live2d.type.CTextureAtlasGuid',
    'com.live2d.graphics3d.type.GVector2',
    'com.live2d.graphics3d.component.GTransform2',
    'com.live2d.cubism.doc.model.extension.textureInput.CTextureInput_TextureAtlasRegion',
  ]);
  e.versions({ 'com.live2d.cubism.doc.model.texture.textureAtlas.ModelImageEntry': 2 });
  replacements.set(document.archive.mainPath, Buffer.from(document.xml()));
  return document.archive.replace(replacements);
}
