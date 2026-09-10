import type { Cmo3Document } from './document';
import { XmlEdit, ROOT_DEFORMER } from './edit';
import { readSourceScene } from './scene';
import { ModelEvaluator } from '../model/evaluate';
import { boundsOf, inversePoint, related, locked, keyformAt } from '../model/selection';
import { RotationOriginEdit } from '../model/rotation-origin';
import { writeFormScene } from './form-edit';
import type { SourceScene } from '../../shared/scene';
import type { CreateDeformer } from '../../shared/types';
import { children } from './xml';

export function createDeformer(
  document: Cmo3Document,
  input: CreateDeformer,
  values: Record<string, number>,
) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    scene = readSourceScene(document).scene;
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  const chosen = [...new Set(input.guids)].map((id) => objects.get(id));
  if (
    chosen.some(
      (o) =>
        !o || !['mesh', 'warp', 'rotation', 'artpath'].includes(o.kind) || locked(objects, o.guid),
    )
  )
    throw new Error('Select unlocked meshes or deformers.');
  const top = chosen.filter(
    (o) => !chosen.some((p) => p !== o && related(objects, o!.guid, p!.guid)),
  ) as NonNullable<(typeof chosen)[number]>[];
  const parent = input.placement === 'child' ? top[0]?.guid : top[0]?.deformerGuid || ROOT_DEFORMER;
  if (
    input.placement === 'child' &&
    (top.length !== 1 || !['warp', 'rotation'].includes(top[0].kind))
  )
    throw new Error('Select one parent deformer.');
  if (input.placement === 'parent' && top.some((o) => (o.deformerGuid || ROOT_DEFORMER) !== parent))
    throw new Error('Selected objects must share a parent deformer.');
  const parentGuid = top[0]?.parentGuid || document.model.rootPartGuid!;
  const evaluator = new ModelEvaluator(scene),
    meshes = evaluator.evaluate(values);
  const parentTransform =
    evaluator.evaluatedDeformers.find((d) => d.source.guid === parent)?.transform ||
    ((x: number, y: number) => [x, y] as [number, number]);
  const targets = input.placement === 'parent' ? top : [];
  const selectedMeshes = meshes.filter((m) =>
    top.some((o) => related(objects, m.source.guid, o.guid)),
  );
  const local: number[] = [];
  for (const mesh of selectedMeshes)
    for (let i = 0; i < mesh.positions.length; i += 2)
      local.push(
        ...inversePoint(parentTransform, [mesh.positions[i], mesh.positions[i + 1]], [0, 0]),
      );
  const bounds = local.length ? boundsOf(local) : { x: 0, y: 0, width: 200, height: 200 };
  const center: [number, number] = [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2],
    canvasCenter = parentTransform(...center),
    east = inversePoint(parentTransform, [canvasCenter[0] + 10, canvasCenter[1]], center),
    south = inversePoint(parentTransform, [canvasCenter[0], canvasCenter[1] + 10], center);
  // Warp parents use normalized coordinates; the minimum size is ten canvas pixels.
  const width = Math.max(Math.hypot(east[0] - center[0], south[0] - center[0]), bounds.width * 1.1),
    height = Math.max(Math.hypot(east[1] - center[1], south[1] - center[1]), bounds.height * 1.1);
  const x = bounds.x + (bounds.width - width) / 2,
    y = bounds.y + (bounds.height - height) / 2;
  const origin = input.origin
    ? inversePoint(parentTransform, input.origin, [x + width / 2, y + height / 2])
    : [x + width / 2, y + height / 2];
  const parentOrigin = parentTransform(origin[0], origin[1]),
    parentUp = parentTransform(origin[0], origin[1] - 0.01),
    parentAngle =
      (Math.atan2(parentUp[0] - parentOrigin[0], parentOrigin[1] - parentUp[1]) * 180) / Math.PI,
    angle = input.angle === undefined ? 0 : input.angle - parentAngle;
  const kind = input.kind,
    tag = kind === 'warp' ? 'CWarpDeformerSource' : 'CRotationDeformerSource',
    formTag = kind === 'warp' ? 'CWarpDeformerForm' : 'CRotationDeformerForm';
  const source = e.identified(e.node(tag)),
    guid = e.identified(e.guid('CDeformerGuid', 'guid')),
    formGuid = e.identified(e.guid('CFormGuid', 'guid'));
  const idBase = kind === 'warp' ? 'Warp' : 'Rotation';
  let id = idBase,
    n = 1;
  while (document.model.objects.some((o) => o.id === id)) id = idBase + ++n;
  const extensions = [];
  if (kind === 'warp')
    for (const [level, col, row] of [
      [2, input.bezierColumns, input.bezierRows],
      [3, 1, 1],
    ])
      extensions.push(
        e.node('CWarpDeformerBezierExtension', undefined, {}, [
          e.node('ACExtension', 'super', {}, [
            e.guid('CExtensionGuid', 'guid'),
            e.ref(source, '_owner'),
          ]),
          e.scalar('i', 'editLevel', level),
          e.scalar('i', 'bezierCol', col),
          e.scalar('i', 'bezierRow', row),
        ]),
      );
  source.appendChild(
    e.node('ACDeformerSource', 'super', {}, [
      e.control(input.name, parentGuid, formGuid, extensions),
      guid,
      e.node('CDeformerId', 'id', { idstr: id }),
      e.guid('CDeformerGuid', 'targetDeformerGuid', parent),
    ]),
  );
  const formBase = e.node('ACDeformerForm', 'super', {}, [
    e.formBase(source, formGuid),
    ...e.formAppearance(),
  ]);
  if (kind === 'warp') {
    const positions = [];
    for (let r = 0; r <= input.rows; r++)
      for (let c = 0; c <= input.columns; c++)
        positions.push(x + (c / input.columns) * width, y + (r / input.rows) * height);
    source.appendChild(e.scalar('i', 'col', input.columns));
    source.appendChild(e.scalar('i', 'row', input.rows));
    source.appendChild(e.scalar('b', 'isQuadTransform', false));
    source.appendChild(
      e.list('carray_list', 'keyforms', [
        e.node(formTag, undefined, {}, [formBase, e.array('float-array', 'positions', positions)]),
      ]),
    );
  } else {
    source.appendChild(e.scalar('b', 'useBoneUi_testImpl', true));
    source.appendChild(
      e.list('carray_list', 'keyforms', [
        e.node(
          formTag,
          undefined,
          {
            angle,
            originX: origin[0],
            originY: origin[1],
            scale: 1,
            isReflectX: false,
            isReflectY: false,
          },
          [formBase],
        ),
      ]),
    );
    source.appendChild(
      e.scalar('f', 'handleLengthOnCanvas', input.handleLength || Math.max(60, height * 0.6)),
    );
    source.appendChild(e.scalar('f', 'circleRadiusOnCanvas', 30));
    source.appendChild(e.scalar('f', 'baseAngle', 0));
  }
  e.addSource('deformerSourceSet', source, parentGuid);
  document.graph.normalize();
  document.refreshModel();
  const newEvaluator = new ModelEvaluator(readSourceScene(document).scene);
  newEvaluator.evaluate(values);
  const created = newEvaluator.evaluatedDeformers.find(
    (d) => d.source.guid === guid.getAttribute('uuid'),
  )!;
  const normalize = (px: number, py: number) =>
    inversePoint(
      created.transform,
      parentTransform(px, py),
      kind === 'warp' ? [(px - x) / width, (py - y) / height] : [px - origin[0], py - origin[1]],
    );
  for (const target of targets) {
    const node = e.source(target.guid),
      arrays = new Set();
    for (const form of g.list(node, 'keyforms')) {
      const positions = g.field(form, 'positions');
      if (positions?.tagName === 'carray_list') {
        for (const p of g.list(form, 'positions')) {
          const point = g.field(g.field(p, 'curvePointPosition'), 'point')!,
            next = normalize(g.number(point, 'x'), g.number(point, 'y'));
          e.value(point, 'x', next[0]);
          e.value(point, 'y', next[1]);
        }
      } else if (positions && !arrays.has(positions)) {
        arrays.add(positions);
        const p = g.numbers(form, 'positions');
        for (let i = 0; i < p.length; i += 2) {
          const point = normalize(p[i], p[i + 1]);
          p[i] = point[0];
          p[i + 1] = point[1];
        }
        positions.textContent = p.map(Math.fround).join(' ');
      }
      if (target.kind === 'rotation') {
        const ox = g.number(form, 'originX'),
          oy = g.number(form, 'originY'),
          p = normalize(ox, oy),
          oldCenter = parentTransform(ox, oy),
          oldUp = parentTransform(ox, oy - 0.01),
          newCenter = created.transform(...p),
          newUp = created.transform(p[0], p[1] - 0.01),
          oldAngle = Math.atan2(oldUp[0] - oldCenter[0], oldCenter[1] - oldUp[1]),
          newAngle = Math.atan2(newUp[0] - newCenter[0], newCenter[1] - newUp[1]);
        e.value(form, 'angle', g.number(form, 'angle') + ((oldAngle - newAngle) * 180) / Math.PI);
        e.value(form, 'originX', p[0]);
        e.value(form, 'originY', p[1]);
      }
      e.field(form, 'coordType', e.coord());
    }
    e.field(node, 'targetDeformerGuid', e.ref(guid, 'targetDeformerGuid'));
  }
  e.imports([
    'com.live2d.cubism.doc.model.deformer.ACDeformerSource',
    'com.live2d.cubism.doc.model.deformer.ACDeformerForm',
    'com.live2d.cubism.doc.model.id.CDeformerId',
    'com.live2d.type.CDeformerGuid',
    'com.live2d.doc.CoordType',
    `com.live2d.cubism.doc.model.deformer.${kind}.${tag}`,
    `com.live2d.cubism.doc.model.deformer.${kind}.${formTag}`,
    'com.live2d.cubism.doc.model.extension.warpBezier.CWarpDeformerBezierExtension',
    'com.live2d.cubism.doc.model.extension.ACExtension',
    'com.live2d.type.CExtensionGuid',
  ]);
  if (kind === 'rotation') e.versions({ CRotationDeformerForm: 1 });
  // Preserve all newly written IDs through a fresh graph before validation.
  return guid.getAttribute('uuid')!;
}

export function editRotation(
  document: Cmo3Document,
  scene: SourceScene,
  guid: string,
  parameters: Record<string, number>,
  value: { x?: number; y?: number; angle?: number; scale?: number },
  preserveChildren = false,
) {
  const e = new XmlEdit(document.graph),
    node = e.source(guid);
  if (node.tagName !== 'CRotationDeformerSource') throw new Error('Select a rotation deformer.');
  if (preserveChildren) {
    if (value.angle !== undefined || value.scale !== undefined)
      throw new Error('Preserving children is supported when moving the rotation origin.');
    const after = new RotationOriginEdit(scene, guid, parameters).apply(value);
    if (after === scene) return [];
    for (const child of [...scene.deformers, ...scene.meshes])
      if (
        (child.guid === guid || child.deformerGuid === guid) &&
        e.g.list(e.g.field(e.source(child.guid), 'keyformMorphTargetSet'), '_morphTargets').length
      )
        throw new Error('Preserving children with blend-shape targets is not supported yet.');
    return writeFormScene(document, scene, after);
  }
  const source = scene.deformers.find((d) => d.guid === guid)!,
    current = keyformAt(source, parameters);
  if (!current) throw new Error('Align parameters with existing key values before editing.');
  const form = e.g
    .list(node, 'keyforms')
    .find((f) => e.g.guid(e.g.field(f, 'guid')) === current.guid);
  if (!form) throw new Error('Rotation keyform not found.');
  for (const [key, v] of Object.entries(value))
    if (v !== undefined)
      e.value(
        form,
        { x: 'originX', y: 'originY', angle: 'angle', scale: 'scale' }[key]!,
        Math.fround(v),
      );
  return [guid];
}
