import type { Element } from '@xmldom/xmldom';
import type { FormEdit } from '../../shared/form-edit';
import type { SourceScene } from '../../shared/scene';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { canvasForm, formDepth, formNodes } from '../model/form-edit';
import { ModelEvaluator, warpPoint, type Point } from '../model/evaluate';
import { inversePoint, keyformAt } from '../model/selection';
import { writeFormScene } from './form-edit';

const packageName = 'com.live2d.cubism.doc.model.extension.deformerOriginalShape';
const extensionTag = 'CDeformerOriginalShapeExtension';

export function updateOriginalForms(
  document: Cmo3Document,
  scene: SourceScene,
  guids: string[],
  values: Record<string, number>,
  method: 'MANUAL' | 'DEFORMER_CREATED' = 'MANUAL',
) {
  const e = new XmlEdit(document.graph),
    g = e.g;
  for (const guid of guids) {
    const node = scene.deformers.find((d) => d.guid === guid);
    if (!node) throw new Error('Select deformers to update their original shapes.');
    const source = e.source(guid),
      shape = canvasForm(scene, node, values),
      rotation = shape.rotation;
    const fields = (): Element[] => [
      e.array('float-array', 'positions', rotation ? [rotation.x, rotation.y] : shape.positions),
      e.scalar('s', 'lastUpdatedTimeString', new Date().toISOString()),
      e.scalar('b', 'autoRefreshIsAvailable', method === 'DEFORMER_CREATED'),
      e.node('CreationMethod', 'creationMethod', { v: method }),
      ...(rotation
        ? [
            e.scalar('f', 'baseAngle', node.baseAngle),
            e.scalar('f', 'globalAngle', rotation.angle),
            e.scalar('f', 'globalScale', rotation.scale),
            e.scalar(
              'f',
              'circleRadiusTimesScale',
              g.number(source, 'circleRadiusOnCanvas', 30) * rotation.scale,
            ),
            e.scalar('f', 'handleLength', node.handleLength || 80),
            e.scalar('b', 'isReflectX', rotation.reflectX),
            e.scalar('b', 'isReflectY', rotation.reflectY),
          ]
        : [e.scalar('i', 'col', node.columns), e.scalar('i', 'row', node.rows)]),
    ];
    const original = e.node(
      rotation ? 'RotationDeformerOriginalShape' : 'WarpDeformerOriginalShape',
      'originalShape',
      {},
      [e.node('ACDeformerOriginalShape', 'super', {}, fields()), ...fields()],
    );
    const extensions = g
      .list(source, '_extensions')
      .filter((ext) => ext.tagName !== extensionTag)
      .map((ext) => e.copyOwned(ext));
    extensions.push(
      e.node(extensionTag, undefined, {}, [
        e.node('ACExtension', 'super', {}, [
          e.guid('CExtensionGuid', 'guid'),
          e.ref(source, '_owner'),
        ]),
        original,
      ]),
    );
    e.field(source, '_extensions', e.list('carray_list', '_extensions', extensions));
  }
  e.imports(
    [
      'CDeformerOriginalShapeExtension',
      'ACDeformerOriginalShape',
      'ACDeformerOriginalShape$CreationMethod',
      'WarpDeformerOriginalShape',
      'RotationDeformerOriginalShape',
    ].map((name) => `${packageName}.${name}`),
  );
  e.imports([
    'com.live2d.cubism.doc.model.extension.ACExtension',
    'com.live2d.type.CExtensionGuid',
  ]);
  e.versions({
    ACDeformerOriginalShape: 1,
    WarpDeformerOriginalShape: 1,
    RotationDeformerOriginalShape: 1,
  });
}

export function editOriginalForms(
  document: Cmo3Document,
  scene: SourceScene,
  edit: FormEdit,
  values: Record<string, number>,
): string[] {
  const e = new XmlEdit(document.graph),
    g = e.g;
  if (edit.action === 'deleteOriginals') {
    const changed: string[] = [];
    for (const node of scene.deformers) {
      const source = e.source(node.guid),
        extensions = g.list(source, '_extensions');
      if (!extensions.some((ext) => ext.tagName === extensionTag)) continue;
      e.field(
        source,
        '_extensions',
        e.list(
          'carray_list',
          '_extensions',
          extensions.filter((ext) => ext.tagName !== extensionTag).map((ext) => e.copyOwned(ext)),
        ),
      );
      changed.push(node.guid);
    }
    return changed;
  }
  if (edit.action === 'updateOriginal') {
    updateOriginalForms(document, scene, edit.guids, values);
    return edit.guids;
  }
  if (edit.action !== 'revert') throw new Error('Invalid original-shape action.');
  const draft = structuredClone(scene),
    nodes = new Map(formNodes(draft).map((n) => [n.guid, n]));
  const selected = [...new Set(edit.guids)]
    .map((guid) => {
      const node = nodes.get(guid);
      if (!node || !['mesh', 'rotation', 'warp'].includes(node.kind))
        throw new Error('Select meshes or deformers.');
      return node;
    })
    .sort((a, b) => formDepth(a, nodes) - formDepth(b, nodes));
  const sourceChanges: { source: Element; radius: number; length: number }[] = [];
  for (const node of selected) {
    const form = keyformAt(node, values);
    if (!form?.guid)
      throw new Error(
        `${node.id}: Align the parameters with an existing keyform before reverting.`,
      );
    const source = e.source(node.guid),
      evaluator = new ModelEvaluator(draft),
      meshes = evaluator.evaluate(values);
    const evaluated = [...meshes, ...evaluator.evaluatedDeformers].find(
      (n) => n.source.guid === node.guid,
    )!;
    let positions: number[];
    if (node.kind === 'mesh') {
      if (node.path) throw new Error('ArtPaths do not have an original ArtMesh shape.');
      positions = g.numbers(source, 'positions');
      if (positions.length !== form.positions.length)
        throw new Error(`${node.id}: Original mesh topology does not match.`);
    } else {
      const extension = g.list(source, '_extensions').find((ext) => ext.tagName === extensionTag);
      const original = g.field(extension || null, 'originalShape');
      if (!original || !g.text(original, 'lastUpdatedTimeString'))
        throw new Error(
          `${node.id}: No original shape is stored. Use Update Original Shape of Deformers first.`,
        );
      positions = g.numbers(original, 'positions');
      if (node.kind === 'warp') {
        const col = g.number(original, 'col'),
          row = g.number(original, 'row');
        if (col < 1 || row < 1 || positions.length !== (col + 1) * (row + 1) * 2)
          throw new Error('Invalid original warp grid.');
        if (col !== node.columns || row !== node.rows)
          positions = Array.from({ length: (node.columns + 1) * (node.rows + 1) }, (_, i) =>
            warpPoint(
              positions,
              col,
              row,
              true,
              (i % (node.columns + 1)) / node.columns,
              Math.floor(i / (node.columns + 1)) / node.rows,
            ),
          ).flat();
      } else if (node.kind === 'rotation' && form.rotation) {
        if (positions.length !== 2) throw new Error('Invalid original rotation origin.');
        const global = canvasForm(draft, node, values).rotation!;
        const baseAngle = g.number(original, 'baseAngle');
        form.rotation.angle +=
          g.number(original, 'globalAngle') - global.angle - (baseAngle - node.baseAngle);
        node.baseAngle = baseAngle;
        form.rotation.scale *= g.number(original, 'globalScale', 1) / global.scale;
        [form.rotation.x, form.rotation.y] = inversePoint(evaluated.toCanvas, positions as Point, [
          form.rotation.x,
          form.rotation.y,
        ]);
        form.rotation.reflectX = g.text(original, 'isReflectX') === 'true';
        form.rotation.reflectY = g.text(original, 'isReflectY') === 'true';
        sourceChanges.push({
          source,
          radius: g.number(original, 'circleRadiusTimesScale', 30) / form.rotation.scale,
          length: g.number(original, 'handleLength', 80),
        });
        continue;
      }
    }
    form.positions = positions.flatMap((_, i) =>
      i % 2
        ? []
        : inversePoint(
            evaluated.toCanvas,
            [positions[i], positions[i + 1]],
            [form.positions[i], form.positions[i + 1]],
          ),
    );
  }
  const changed = writeFormScene(document, scene, draft);
  for (const { source, radius, length } of sourceChanges) {
    e.value(source, 'circleRadiusOnCanvas', Math.fround(radius));
    e.value(source, 'handleLengthOnCanvas', Math.fround(length));
    const guid = g.guid(g.field(source, 'guid'))!;
    if (!changed.includes(guid)) changed.push(guid);
  }
  return changed;
}
