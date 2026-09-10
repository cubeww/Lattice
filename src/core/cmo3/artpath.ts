import type { Cmo3Document } from './document';
import { XmlEdit, ROOT_DEFORMER } from './edit';
import { readSourceScene } from './scene';
import { ModelEvaluator } from '../model/evaluate';
import { inversePoint, locked } from '../model/selection';
import type { Point } from '../model/evaluate';

export function createArtPath(
  document: Cmo3Document,
  points: Point[],
  options: {
    name: string;
    width: number;
    color: string;
    parentGuid: string | null;
    deformerGuid: string | null;
  },
  values: Record<string, number>,
) {
  const e = new XmlEdit(document.graph),
    scene = readSourceScene(document).scene,
    evaluator = new ModelEvaluator(scene);
  evaluator.evaluate(values);
  const parent = options.parentGuid || document.model.rootPartGuid!,
    deformer = options.deformerGuid || ROOT_DEFORMER,
    transform =
      evaluator.evaluatedDeformers.find((d) => d.source.guid === deformer)?.transform ||
      ((x: number, y: number) => [x, y] as Point);
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  if (
    objects.get(parent)?.kind !== 'part' ||
    (deformer !== ROOT_DEFORMER && !scene.deformers.some((d) => d.guid === deformer))
  )
    throw new Error('Choose a valid parent part and deformer.');
  if (locked(objects, parent) || (deformer !== ROOT_DEFORMER && locked(objects, deformer)))
    throw new Error('The selected parent is locked.');
  const source = e.identified(e.node('CArtPathSource')),
    guid = e.identified(e.guid('CDrawableGuid', 'guid')),
    formGuid = e.identified(e.guid('CFormGuid', 'guid'));
  let id = 'ArtPath',
    index = 1;
  while (document.model.objects.some((o) => o.id === id)) id = 'ArtPath' + ++index;
  source.appendChild(
    e.node('ACDrawableSource', 'super', {}, [
      e.control(options.name, parent, formGuid),
      e.node('CDrawableId', 'id', { idstr: id }),
      guid,
      e.guid('CDeformerGuid', 'targetDeformerGuid', deformer),
      e.list('carray_list', 'clipGuidList'),
      e.scalar('b', 'invertClippingMask', false),
      e.node('CImageIcon', 'icon32', {}, [e.node('null', 'image')]),
      e.node('CImageIcon', 'icon16', {}, [e.node('null', 'image')]),
    ]),
  );
  source.appendChild(
    e.guid('CArtPathBrushGuid', 'brushGuid', '00000000-0000-0000-0000-000000000000'),
  );
  const vector = (name: string, p: Point) =>
    e.node('GVector2', name, {}, [
      e.scalar('f', 'x', Math.fround(p[0])),
      e.scalar('f', 'y', Math.fround(p[1])),
    ]);
  const color = [1, 3, 5].map((i) => parseInt(options.color.slice(i, i + 2), 16) / 255);
  const pointNodes = points.map((p) =>
    e.node('CArtPathPoint', undefined, {}, [
      e.ref(guid, 'ownerGuid'),
      e.guid('CArtPathPointGuid', 'ctrlPtId'),
      e.node('CSplineCurvePoint', 'curvePointPosition', {}, [
        vector('point', inversePoint(transform, p, p)),
        vector('startVelocity', [0, 0]),
        vector('endVelocity', [0, 0]),
      ]),
      e.scalar('f', 'width', options.width),
      e.scalar('f', 'opacity', 1),
      ...['Red', 'Green', 'Blue'].map((channel, i) => e.scalar('f', 'color' + channel, color[i])),
      e.scalar('f', 'colorAlpha', 1),
      e.scalar('b', 'isCorner', false),
    ]),
  );
  source.appendChild(
    e.list('carray_list', 'keyforms', [
      e.node('CArtPathForm', undefined, {}, [
        e.node('ACDrawableForm', 'super', {}, [
          e.formBase(source, formGuid),
          e.scalar('i', 'drawOrder', 500),
          ...e.formAppearance(),
        ]),
        e.list('carray_list', 'positions', pointNodes),
      ]),
    ]),
  );
  source.appendChild(e.scalar('i', 'divNum', 20));
  source.appendChild(e.node('LineAlgorithm', 'lineAlgorithm', { v: 'LCNS' }));
  source.appendChild(e.node('LineAlignment', 'lineAlignment', { v: 'CENTER' }));
  source.appendChild(e.scalar('s', 'userData', ''));
  source.appendChild(e.scalar('b', 'isClosed', false));
  e.addSource('drawableSourceSet', source, parent);
  e.value(e.g.source, 'targetVersionNo', 9000000);
  e.imports(
    ['CArtPathSource', 'CArtPathForm', 'CArtPathPoint', 'LineAlgorithm', 'LineAlignment']
      .map((name) => 'com.live2d.cubism.doc.model.drawable.artPath.' + name)
      .concat([
        'com.live2d.type.CArtPathBrushGuid',
        'com.live2d.type.CArtPathPointGuid',
        'com.live2d.graphics.splineCurve.CSplineCurvePoint',
        'com.live2d.graphics3d.type.GVector2',
      ]),
  );
  e.versions({ CArtPathSource: 1, CArtPathForm: 1 });
  return guid.getAttribute('uuid')!;
}
