import type { Element } from '@xmldom/xmldom';
import type { Cmo3Document } from './document';
import { XmlEdit, ROOT_DEFORMER } from './edit';
import { projectIndex } from './project';
import { children } from './xml';
import { locked } from '../model/selection';
import { readSourceScene } from './scene';

type Matrix = number[];
const identity = [1, 0, 0, 1, 0, 0];
const affine = (g: Cmo3Document['graph'], n: Element | null): Matrix => [
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
  if (Math.abs(det) < 1e-12) throw new Error('Image transform is singular.');
  return [d / det, -b / det, -c / det, a / det, (c * y - d * x) / det, (b * x - a * y) / det];
};
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const transform = (m: Matrix, points: number[]) =>
  points.map((v, i) =>
    i % 2 ? m[1] * points[i - 1] + m[3] * v + m[5] : m[0] * v + m[2] * points[i + 1] + m[4],
  );
const matrixNode = (e: XmlEdit, name: string, m: Matrix) =>
  e.node('CAffine', name, { m00: m[0], m10: m[1], m01: m[2], m11: m[3], m02: m[4], m12: m[5] });

function texture(e: XmlEdit, resource: Element, name: string) {
  e.imports([
    ...[
      'GTexture',
      'GTexture$FilterMode',
      'GTexture2D',
      'WrapMode',
      'MinFilter',
      'MagFilter',
      'Anisotropy',
    ].map((name) => 'com.live2d.graphics3d.texture.' + name),
    'com.live2d.type.GTextureGuid',
    'com.live2d.type.CAffine',
  ]);
  const g = e.g,
    width = g.number(resource, 'width'),
    height = g.number(resource, 'height');
  if (width < 1 || height < 1) throw new Error('Image dimensions must be positive.');
  const w = Math.ceil(width / 64) * 64,
    h = Math.ceil(height / 64) * 64;
  const node = e.identified(e.node('GTexture2D', 'texture'));
  node.appendChild(
    e.node('GTexture', 'super', {}, [
      e.scalar('s', 'name', name),
      e.node('WrapMode', 'wrapMode', { v: 'CLAMP_TO_BORDER' }),
      e.node('FilterMode', 'filterMode', {}, [
        e.node('MinFilter', 'minFilter', { v: 'LINEAR_MIPMAP_LINEAR' }),
        e.node('MagFilter', 'magFilter', { v: 'LINEAR' }),
        e.ref(node, 'owner'),
      ]),
      e.guid('GTextureGuid', 'guid'),
      e.node('Anisotropy', 'anisotropy', { v: 'ON' }),
    ]),
  );
  for (const child of [
    e.ref(resource, 'srcImageResource'),
    matrixNode(e, 'transformImageResource01toLogical01', [width / w, 0, 0, height / h, 0, 0]),
    e.scalar('i', 'mipmapLevel', 64),
    e.scalar('b', 'isPremultiplied', true),
  ])
    node.appendChild(child);
  return { node, w, h };
}

function imageNode(d: Cmo3Document, key: string) {
  const index = projectIndex(d),
    item = index.data.resources.find((r) => r.key === key);
  if (item?.kind !== 'modelImage' || !item.image) throw new Error('Select a model image.');
  return index.nodes.get(key)!;
}

function setMeshTexture(
  e: XmlEdit,
  mesh: Element,
  resource: Element,
  pixels: number[],
  name: string,
) {
  const tex = texture(e, resource, name);
  e.field(mesh, 'texture', tex.node);
  e.field(
    mesh,
    'uvs',
    e.array(
      'float-array',
      'uvs',
      pixels.map((v, i) => v / (i % 2 ? tex.h : tex.w)),
    ),
  );
}

function setBasicPositions(e: XmlEdit, mesh: Element, points: number[]) {
  e.field(mesh, 'positions', e.array('float-array', 'positions', points));
  const editable = e.g.field(
    e.g.list(mesh, '_extensions').find((n) => n.tagName === 'CEditableMeshExtension') || null,
    'editableMesh',
  );
  if (editable) e.field(editable, 'point', e.array('float-array', 'point', points));
}

export function createMeshesFromImages(d: Cmo3Document, keys: string[], selected: string[]) {
  const images = [...new Set(keys)].map((key) => imageNode(d, key)),
    e = new XmlEdit(d.graph),
    g = e.g;
  const first = d.model.objects.find((o) => o.guid === selected[0]),
    parent = first?.kind === 'part' ? first.guid : first?.parentGuid || d.model.rootPartGuid!;
  const objects = new Map(d.model.objects.map((o) => [o.guid, o]));
  if (locked(objects, parent)) throw new Error('The parent part is locked.');
  const part = e.source(parent),
    childList = g.field(part, '_childGuids')!;
  const before =
    children(childList).find((n) => g.guid(n) === first?.guid) || children(childList)[0];
  const usedIds = new Set(d.model.objects.map((o) => o.id));
  const created = images.map((image) => {
    const source = e.identified(e.node('CArtMeshSource')),
      guid = e.identified(e.guid('CDrawableGuid', 'guid')),
      formGuid = e.identified(e.guid('CFormGuid', 'guid'));
    const name = g.text(image, 'name'),
      base = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'ArtMesh';
    let id = base,
      suffix = 1;
    while (usedIds.has(id)) id = base + suffix++;
    usedIds.add(id);
    const resource = g.field(image, '_filteredImage')!,
      width = g.number(resource, 'width'),
      height = g.number(resource, 'height');
    const pixels = [width + 1, -1, -1, -1, width + 1, height + 1, -1, height + 1];
    const positions = transform(
      affine(g, g.field(image, '_materialLocalToCanvasTransform')),
      pixels,
    );
    const extensionBase = () =>
      e.node('ACExtension', 'super', {}, [
        e.guid('CExtensionGuid', 'guid'),
        e.ref(source, '_owner'),
      ]);
    const editable = e.node('CEditableMeshExtension', undefined, {}, [
      extensionBase(),
      e.node(
        'GEditableMesh2',
        'editableMesh',
        { nextPointUid: 4, useDelaunayTriangulation: true },
        [
          e.array('float-array', 'point', positions),
          e.array('byte-array', 'pointPriority', [20, 20, 20, 20]),
          e.array('short-array', 'edge', [0, 1, 0, 2, 1, 3, 2, 3, 1, 2]),
          e.array('byte-array', 'edgePriority', [30, 30, 30, 30, 10]),
          e.array('int-array', 'pointUid', [0, 1, 2, 3]),
          e.guid('GEditableMeshGuid', 'meshGuid'),
          e.coord('Basic Coord'),
        ],
      ),
      e.scalar('b', 'isLocked', false),
    ]);
    const inputExt = e.identified(e.node('CTextureInputExtension')),
      input = e.identified(
        e.node('CTextureInput_ModelImage', undefined, {}, [
          e.node('ACTextureInput', 'super', {}, [
            matrixNode(e, 'optionalTransformOnCanvas', identity),
            e.ref(inputExt, '_owner'),
          ]),
          e.ref(g.field(image, 'guid')!, '_modelImageGuid'),
        ]),
      );
    for (const n of [
      extensionBase(),
      e.list('carray_list', '_textureInputs', [input]),
      e.ref(input, 'currentTextureInputData'),
    ])
      inputExt.appendChild(n);
    const generator = e.node('CMeshGeneratorExtension', undefined, {}, [
      extensionBase(),
      e.node('MeshGenerateSetting', 'meshGenerateSetting', {}, [
        ...Object.entries({
          polygonOuterDensity: 100,
          polygonInnerDensity: 100,
          polygonMargin: 20,
          polygonInnerMargin: 20,
          polygonMinMargin: 5,
          polygonMinBoundsPt: 5,
          thresholdAlpha: 0,
        }).map(([k, v]) => e.scalar('i', k, v)),
      ]),
    ]);
    source.appendChild(
      e.node('ACDrawableSource', 'super', {}, [
        e.control(name, parent, formGuid, [editable, inputExt, generator]),
        e.node('CDrawableId', 'id', { idstr: id }),
        guid,
        e.guid('CDeformerGuid', 'targetDeformerGuid', ROOT_DEFORMER),
        e.list('carray_list', 'clipGuidList'),
        e.scalar('b', 'invertClippingMask', false),
        e.node('CImageIcon', 'icon32', {}, [e.node('null', 'image')]),
        e.node('CImageIcon', 'icon16', {}, [e.node('null', 'image')]),
      ]),
    );
    source.appendChild(e.array('int-array', 'indices', [1, 0, 2, 2, 3, 1]));
    source.appendChild(
      e.list('carray_list', 'keyforms', [
        e.node('CArtMeshForm', undefined, {}, [
          e.node('ACDrawableForm', 'super', {}, [
            e.formBase(source, formGuid),
            e.scalar('i', 'drawOrder', 500),
            ...e.formAppearance().filter((n) => n.getAttribute('xs.n') !== 'coordType'),
            e.coord('Canvas'),
          ]),
          e.array('float-array', 'positions', positions),
        ]),
      ]),
    );
    source.appendChild(e.array('float-array', 'positions', positions));
    setMeshTexture(e, source, resource, pixels, name);
    source.appendChild(e.node('ColorComposition', 'colorComposition', { v: 'NORMAL' }));
    source.appendChild(e.node('AlphaComposition', 'alphaComposition', { v: 'OVER' }));
    source.appendChild(e.scalar('b', 'culling', false));
    source.appendChild(e.node('TextureState', 'textureState', { v: 'MODEL_IMAGE' }));
    source.appendChild(e.scalar('s', 'userData', ''));
    e.addSource('drawableSourceSet', source, parent);
    const last = childList.lastChild!;
    if (before) childList.insertBefore(last, before);
    return guid.getAttribute('uuid')!;
  });
  // Cubism reveals the destination when creating artwork in a hidden part.
  e.value(part, 'isVisible', true);
  e.imports([
    'com.live2d.cubism.doc.model.drawable.artMesh.CArtMeshSource',
    'com.live2d.doc.CoordType',
    'com.live2d.type.CDeformerGuid',
    'com.live2d.cubism.doc.model.drawable.artMesh.CArtMeshForm',
    'com.live2d.cubism.doc.model.drawable.ACDrawableSource',
    'com.live2d.cubism.doc.model.drawable.ACDrawableForm',
    'com.live2d.cubism.doc.model.drawable.TextureState',
    'com.live2d.cubism.doc.model.drawable.ColorComposition',
    'com.live2d.cubism.doc.model.drawable.AlphaComposition',
    'com.live2d.cubism.doc.model.id.CDrawableId',
    'com.live2d.cubism.doc.model.extension.ACExtension',
    'com.live2d.cubism.doc.model.extension.editableMesh.CEditableMeshExtension',
    'com.live2d.cubism.doc.model.extension.meshGenerator.CMeshGeneratorExtension',
    'com.live2d.cubism.doc.model.extension.meshGenerator.MeshGenerateSetting',
    'com.live2d.cubism.doc.model.extension.textureInput.ACTextureInput',
    'com.live2d.cubism.doc.model.extension.textureInput.CTextureInputExtension',
    'com.live2d.cubism.doc.model.extension.textureInput.CTextureInput_ModelImage',
    'com.live2d.graphics3d.editableMesh.GEditableMesh2',
    'com.live2d.type.GEditableMeshGuid',
    'com.live2d.type.CDrawableGuid',
    'com.live2d.type.CExtensionGuid',
    'com.live2d.type.CFormGuid',
    'com.live2d.type.CImageIcon',
  ]);
  return created;
}

export function assignModelImage(d: Cmo3Document, key: string, guids: string[]) {
  const image = imageNode(d, key),
    e = new XmlEdit(d.graph),
    g = e.g;
  const objects = new Map(d.model.objects.map((o) => [o.guid, o]));
  for (const id of new Set(guids)) {
    if (objects.get(id)?.kind !== 'mesh' || locked(objects, id))
      throw new Error('Choose unlocked ArtMeshes.');
    const mesh = e.source(id),
      extension = g.list(mesh, '_extensions').find((n) => n.tagName === 'CTextureInputExtension');
    const input = g
      .list(extension || null, '_textureInputs')
      .find((n) => n.tagName === 'CTextureInput_ModelImage');
    if (!extension || !input) throw new Error('This mesh does not have a model-image input.');
    const imageGuid = g.guid(g.field(image, 'guid'))!;
    if (g.guid(g.field(input, '_modelImageGuid')) === imageGuid) continue;
    e.field(input, '_modelImageGuid', e.guid('CModelImageGuid', '_modelImageGuid', imageGuid));
    const imageToCanvas = multiply(
      affine(g, g.field(input, 'optionalTransformOnCanvas')),
      affine(g, g.field(image, '_materialLocalToCanvasTransform')),
    );
    const pixels = transform(inverse(imageToCanvas), g.numbers(mesh, 'positions'));
    setMeshTexture(e, mesh, g.field(image, '_filteredImage')!, pixels, g.text(image, 'name'));
    // The old atlas input belongs to a different image and must be removed.
    const inputs = g.field(extension, '_textureInputs')!;
    for (const n of children(inputs)) if (g.resolve(n) !== input) inputs.removeChild(n);
    inputs.setAttribute('count', String(children(inputs).length));
    e.field(extension, 'currentTextureInputData', e.ref(input, 'currentTextureInputData'));
    e.field(mesh, 'textureState', e.node('TextureState', 'textureState', { v: 'MODEL_IMAGE' }));
  }
}

/** Refresh PSD pixels/UVs while retaining every mesh vertex, keyform and deformer binding. */
export function refreshModelImageMeshes(d: Cmo3Document, keys: Set<string>) {
  const e = new XmlEdit(d.graph),
    g = e.g,
    index = projectIndex(d);
  for (const mesh of g.sources('drawableSourceSet').filter((n) => n.tagName === 'CArtMeshSource')) {
    const extension = g
      .list(mesh, '_extensions')
      .find((n) => n.tagName === 'CTextureInputExtension');
    const input = g
      .list(extension || null, '_textureInputs')
      .find((n) => n.tagName === 'CTextureInput_ModelImage');
    if (!input || !extension) continue;
    const key = `model:${g.guid(g.field(input, '_modelImageGuid'))}`;
    if (!keys.has(key)) continue;
    const image = index.nodes.get(key)!;
    const toCanvas = multiply(
      affine(g, g.field(input, 'optionalTransformOnCanvas')),
      affine(g, g.field(image, '_materialLocalToCanvasTransform')),
    );
    setMeshTexture(
      e,
      mesh,
      g.field(image, '_filteredImage')!,
      transform(inverse(toCanvas), g.numbers(mesh, 'positions')),
      g.text(image, 'name'),
    );
    e.field(extension, 'currentTextureInputData', e.ref(input, 'currentTextureInputData'));
    e.field(mesh, 'textureState', e.node('TextureState', 'textureState', { v: 'MODEL_IMAGE' }));
  }
}

export function setTextureMode(d: Cmo3Document, mode: 'modelImage' | 'atlas') {
  const e = new XmlEdit(d.graph),
    g = e.g,
    index = projectIndex(d),
    manager = g.field(g.source, 'textureManager')!;
  const scene = readSourceScene(d).scene,
    atlases = g.list(manager, '_textureAtlases');
  for (const mesh of g.sources('drawableSourceSet').filter((n) => n.tagName === 'CArtMeshSource')) {
    if (
      g.field(mesh, 'textureState')?.getAttribute('v') ===
      (mode === 'atlas' ? 'TEXTURE_ATLAS' : 'MODEL_IMAGE')
    )
      continue;
    const extension = g
      .list(mesh, '_extensions')
      .find((n) => n.tagName === 'CTextureInputExtension');
    const input = g
      .list(extension || null, '_textureInputs')
      .find((n) => n.tagName === 'CTextureInput_ModelImage');
    if (!extension || !input) throw new Error('This mesh does not have a model-image input.');
    const id = g.guid(g.field(input, '_modelImageGuid'))!,
      image = index.nodes.get(`model:${id}`);
    if (!image) throw new Error('The mesh model image is missing.');
    const atlas = atlases.find((a) =>
      g.list(a, 'modelImages').some((n) => g.guid(g.field(n, 'modelImageGuid')) === id),
    );
    const entry =
      atlas &&
      g.list(atlas, 'modelImages').find((n) => g.guid(g.field(n, 'modelImageGuid')) === id);
    if (!atlas || !entry)
      throw new Error(
        `${g.text(image, 'name')}: arrange this model image in a texture atlas first.`,
      );
    const imageToCanvas = affine(g, g.field(image, '_materialLocalToCanvasTransform')),
      atlasToCanvas = affine(g, g.field(entry, 'atlasLocalToCanvasTransform'));
    const original = scene.meshes.find((m) => m.guid === g.guid(g.field(mesh, 'guid')))!,
      oldTexture = scene.textures[original.texture];
    const oldPixels = original.uvs.map(
      (v, i) => v * (i % 2 ? oldTexture.height : oldTexture.width),
    );
    const pixels = transform(
      mode === 'atlas'
        ? multiply(inverse(atlasToCanvas), imageToCanvas)
        : multiply(inverse(imageToCanvas), atlasToCanvas),
      oldPixels,
    );
    const toCanvas = multiply(
      affine(g, g.field(input, 'optionalTransformOnCanvas')),
      mode === 'atlas' ? atlasToCanvas : imageToCanvas,
    );
    setBasicPositions(e, mesh, transform(toCanvas, pixels));
    setMeshTexture(
      e,
      mesh,
      g.field(
        mode === 'atlas' ? atlas : image,
        mode === 'atlas' ? 'cachedAtlasImage' : '_filteredImage',
      )!,
      pixels,
      g.text(image, 'name'),
    );
    let active = input;
    if (mode === 'atlas') {
      active = g
        .list(extension, '_textureInputs')
        .find((n) => n.tagName === 'CTextureInput_TextureAtlasRegion')!;
      if (!active) {
        e.imports([
          'com.live2d.cubism.doc.model.extension.textureInput.CTextureInput_TextureAtlasRegion',
        ]);
        active = e.identified(
          e.node('CTextureInput_TextureAtlasRegion', undefined, {}, [
            e.node('ACTextureInput', 'super', {}, [
              matrixNode(e, 'optionalTransformOnCanvas', identity),
              e.ref(extension, '_owner'),
            ]),
          ]),
        );
        e.append(g.field(extension, '_textureInputs')!, active);
      }
      e.field(active, 'textureAtlasGuid', e.ref(g.field(atlas, 'guid')!, 'textureAtlasGuid'));
      e.field(
        active,
        'inputImageLocalToCanvasTransform',
        matrixNode(e, 'inputImageLocalToCanvasTransform', toCanvas),
      );
    }
    e.field(extension, 'currentTextureInputData', e.ref(active, 'currentTextureInputData'));
    e.field(
      mesh,
      'textureState',
      e.node('TextureState', 'textureState', {
        v: mode === 'atlas' ? 'TEXTURE_ATLAS' : 'MODEL_IMAGE',
      }),
    );
  }
  if (g.text(manager, 'isTextureInputModelImageMode') !== String(mode === 'modelImage'))
    e.value(manager, 'isTextureInputModelImageMode', mode === 'modelImage');
}
