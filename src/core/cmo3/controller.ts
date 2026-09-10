import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { readSourceScene } from './scene';
import { ModelEvaluator, type Point } from '../model/evaluate';
import { keyformAt, inversePoint } from '../model/selection';
import { surfacePoint, sampleSurface } from '../model/topology';
import { closestOnCurve } from '../model/controller';
import type { Element } from '@xmldom/xmldom';

export function createController(
  document: Cmo3Document,
  guid: string,
  points: Point[],
  width: number,
  hardness: number,
  values: Record<string, number>,
) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    source = e.source(guid),
    scene = readSourceScene(document).scene;
  const mesh = new ModelEvaluator(scene).evaluate(values).find((m) => m.source.guid === guid);
  if (source.tagName !== 'CArtMeshSource' || !mesh)
    throw new Error('Select one ArtMesh for the deform path.');
  const form = keyformAt(mesh.source, values);
  if (!form) throw new Error('Align parameters with existing key values before adding a path.');
  const existing = g
    .list(source, '_extensions')
    .find((n) => n.tagName === 'CControllerExtension' && g.number(n, 'editLevel') === 2);
  const extension = existing || e.identified(e.node('CControllerExtension')),
    curve = e.identified(e.node('CControllerCurve')),
    curveGuid = e.identified(e.guid('CControllerCurveGuid', 'curveId'));
  const vector = (name: string, p: Point) =>
    e.node('GVector2', name, {}, [
      e.scalar('f', 'x', Math.fround(p[0])),
      e.scalar('f', 'y', Math.fround(p[1])),
    ]);
  const controlPoints = points.map((p) => {
    const local = inversePoint(mesh.toCanvas, p, p),
      binding = surfacePoint(form.positions, mesh.source.indices, ...local);
    return e.identified(
      e.node('CControllerPoint', undefined, {}, [
        e.ref(curve, 'assignedCurve'),
        e.scalar('b', 'isCorner', false),
        e.coord(),
        e.node(
          'PointInTriangle',
          'pointInTriangle',
          {},
          binding.indices.flatMap((id, i) => [
            e.scalar('i', 'ptIndex' + (i + 1), id),
            e.scalar('f', 'weight' + (i + 1), Math.fround(binding.weights[i])),
          ]),
        ),
        vector('pointOnCanvasForRecovery', p),
        e.scalar('f', 'totalEffectToPointInTriangle', 1),
        e.ref(extension, '_owner'),
        e.guid('CControllerPointGuid', 'ctrlPtId'),
        vector('posOnLocalOfDefaultKeyform', local),
      ]),
    );
  });
  for (const n of [
    e.scalar('f', 'lineWidth', width),
    e.scalar('f', 'lineHardnessPercent', hardness * 100),
    e.scalar('b', 'isOpen', true),
    e.list(
      'carray_list',
      '_curvePoints',
      controlPoints.map((p) => e.ref(p)),
    ),
    curveGuid,
  ])
    curve.appendChild(n);
  if (existing) {
    for (const p of controlPoints) e.append(g.field(existing, 'controlPoints')!, p);
    e.append(g.field(existing, 'controlCurves')!, curve);
  } else
    for (const n of [
      e.node('ACExtension', 'super', {}, [
        e.guid('CExtensionGuid', 'guid'),
        e.ref(source, '_owner'),
      ]),
      e.scalar('i', 'editLevel', 2),
      e.scalar('i', 'maxBindCount', 3),
      e.node('BindMethod', 'bindMethod', { v: 'LINE_AND_DIRECTION' }),
      e.list('carray_list', 'controlPoints', controlPoints),
      e.list('carray_list', 'controlCurves', [curve]),
      e.list('carray_list', 'targetPoints'),
      e.list('array_list', 'subArtMeshGuids'),
    ])
      extension.appendChild(n);
  if (!existing) {
    const extensions = g.field(source, '_extensions')!;
    e.append(extensions, extension);
    const observer = g
      .list(source, '_extensions')
      .find((n) => n.tagName === 'CTopologyObserverExtension');
    if (observer) e.append(g.field(observer, 'observers')!, e.ref(extension));
    else
      e.append(
        extensions,
        e.node('CTopologyObserverExtension', undefined, {}, [
          e.node('ACExtension', 'super', {}, [
            e.guid('CExtensionGuid', 'guid'),
            e.ref(source, '_owner'),
          ]),
          e.list('carray_list', 'observers', [e.ref(extension)]),
        ]),
      );
  }
  e.imports([
    'com.live2d.cubism.doc.model.extension.structureObserver.CTopologyObserverExtension',
    'com.live2d.cubism.doc.model.extension.controller.CControllerExtension',
    'com.live2d.cubism.doc.model.extension.controller.CControllerCurve',
    'com.live2d.cubism.doc.model.extension.controller.CControllerPoint',
    'com.live2d.cubism.doc.model.extension.controller.CControllerExtension$BindMethod',
    'com.live2d.cubism.doc.model.extension.controller.CControllerExtension$TargetPoint',
    'com.live2d.cubism.doc.model.extension.controller.CControllerExtension$Effect',
    'com.live2d.cubism.doc.model.extension.controller.CControllerExtension$PointOnCurve',
    'com.live2d.cubism.doc.model.drawable.artMesh.MeshPointRef',
    'com.live2d.cubism.doc.model.drawable.artMesh.PointInTriangle',
    'com.live2d.graphics3d.type.GVector2',
    'com.live2d.type.CControllerPointGuid',
    'com.live2d.type.CControllerCurveGuid',
  ]);
  document.graph.normalize();
  document.refreshModel();
  bindControllers(document, guid);
  document.graph.normalize();
  return document.xml();
}

/** Refresh native path caches after topology changes, retaining curve attachments. */
export function bindControllers(
  document: Cmo3Document,
  guid: string,
  oldPositions?: number[],
  oldIndices?: number[],
) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    source = e.source(guid);
  const scene = readSourceScene(document).scene,
    mesh = scene.meshes.find((m) => m.guid === guid)!,
    values = Object.fromEntries(scene.parameters.map((p) => [p.id, p.default])),
    defaultForm = keyformAt(mesh, values),
    form =
      g.list(source, 'keyforms').find((f) => g.guid(g.field(f, 'guid')) === defaultForm?.guid) ||
      g.list(source, 'keyforms')[0],
    positions = g.numbers(form, 'positions'),
    indices = g.numbers(source, 'indices'),
    canvasPositions = new ModelEvaluator(scene)
      .evaluate(values)
      .find((m) => m.source.guid === guid)!.positions;
  const editable = g
    .list(source, '_extensions')
    .find((n) => n.tagName === 'CEditableMeshExtension');
  const uids = g.numbers(g.field(editable || null, 'editableMesh'), 'pointUid');
  const vector = (name: string, p: Point) =>
    e.node('GVector2', name, {}, [
      e.scalar('f', 'x', Math.fround(p[0])),
      e.scalar('f', 'y', Math.fround(p[1])),
    ]);
  for (const ext of g
    .list(source, '_extensions')
    .filter((n) => n.tagName === 'CControllerExtension')) {
    const controlPoints = g.list(ext, 'controlPoints');
    if (oldPositions && oldIndices)
      for (const cp of controlPoints) {
        const binding = g.field(cp, 'pointInTriangle')!,
          p = sampleSurface(oldPositions, {
            indices: [1, 2, 3].map((i) => g.number(binding, 'ptIndex' + i)) as [
              number,
              number,
              number,
            ],
            weights: [1, 2, 3].map((i) => g.number(binding, 'weight' + i)) as [
              number,
              number,
              number,
            ],
          });
        const next = surfacePoint(positions, indices, ...p);
        [1, 2, 3].forEach((i, j) => {
          e.value(binding, 'ptIndex' + i, next.indices[j]);
          e.value(binding, 'weight' + i, Math.fround(next.weights[j]));
        });
      }
    const curves = g.list(ext, 'controlCurves').map((curve) => ({
      curve,
      points: g.list(curve, '_curvePoints').map((cp) => {
        const b = g.field(cp, 'pointInTriangle')!;
        return sampleSurface(canvasPositions, {
          indices: [1, 2, 3].map((i) => g.number(b, 'ptIndex' + i)) as [number, number, number],
          weights: [1, 2, 3].map((i) => g.number(b, 'weight' + i)) as [number, number, number],
        });
      }),
    }));
    const targets: Element[] = Array.from({ length: positions.length / 2 }, (_, i) => {
      const point: Point = [canvasPositions[i * 2], canvasPositions[i * 2 + 1]],
        nearest = curves
          .map((c) => ({ ...c, ...closestOnCurve(point, c.points) }))
          .sort((a, b) => a.distance - b.distance)[0];
      return e.node('TargetPoint', undefined, {}, [
        e.node('MeshPointRef', '_point', {}, [
          e.scalar('l', 'pointUid', uids[i] ?? i),
          e.coord(),
          e.ref(form, 'keyForm'),
          e.ref(g.field(form, 'positions')!, 'positions'),
          e.scalar('i', 'step', 0),
          e.ref(source, '_artMeshSource'),
          e.scalar('i', '_index', i),
          e.ref(g.field(source, 'guid')!, 'artMeshGuid'),
        ]),
        e.list(
          'carray_list',
          'effects',
          nearest
            ? [
                e.node('Effect', undefined, {}, [
                  e.node('PointOnCurve', 'effectorPt', {}, [
                    e.ref(g.field(nearest.curve, 'curveId')!, 'curveId'),
                    e.scalar('f', 'totalT', nearest.totalT),
                    e.scalar('f', 'distance', nearest.distance),
                    vector('_posOnLocal', nearest.closest),
                  ]),
                  e.scalar('f', 'weight', 1),
                ]),
              ]
            : [],
        ),
      ]);
    });
    e.field(ext, 'targetPoints', e.list('carray_list', 'targetPoints', targets));
  }
}
