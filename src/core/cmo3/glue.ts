import type { Cmo3Document } from './document';
import { XmlEdit, ROOT_DEFORMER } from './edit';
import { children } from './xml';

export interface GlueInput {
  name: string;
  meshA: string;
  meshB: string;
  pairs: { indexA: number; indexB: number; weightA: number; weightB: number }[];
}
export function editGlueWeights(
  document: Cmo3Document,
  guid: string,
  changes: { index: number; weightA: number; weightB: number }[],
) {
  const e = new XmlEdit(document.graph),
    source = e.source(guid);
  if (source.tagName !== 'CGlueSource') throw new Error('Glue not found.');
  const weights = e.g.numbers(source, 'weights');
  for (const change of changes) {
    if (change.index < 0 || change.index * 2 + 1 >= weights.length)
      throw new Error('Glue pair not found.');
    weights[change.index * 2] = change.weightA;
    weights[change.index * 2 + 1] = change.weightB;
  }
  e.field(source, 'weights', e.array('float-array', 'weights', weights));
}
export function setGlue(document: Cmo3Document, input: GlueInput, guid?: string) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    a = e.source(input.meshA),
    b = e.source(input.meshB);
  if (a === b || a.tagName !== 'CArtMeshSource' || b.tagName !== 'CArtMeshSource')
    throw new Error('Glue requires two different ArtMeshes.');
  const uids = (node: typeof a) => {
    const ext = g.list(node, '_extensions').find((n) => n.tagName === 'CEditableMeshExtension');
    return g.numbers(g.field(ext || null, 'editableMesh'), 'pointUid');
  };
  const ua = uids(a),
    ub = uids(b),
    seenA = new Set<number>(),
    seenB = new Set<number>();
  for (const p of input.pairs) {
    if (
      ua[p.indexA] === undefined ||
      ub[p.indexB] === undefined ||
      seenA.has(p.indexA) ||
      seenB.has(p.indexB)
    )
      throw new Error('Each glue vertex must exist and may be paired only once.');
    seenA.add(p.indexA);
    seenB.add(p.indexB);
  }
  const pairs = input.pairs.flatMap((p) => [ua[p.indexA], ub[p.indexB]]),
    weights = input.pairs.flatMap((p) => [p.weightA, p.weightB]);
  if (guid) {
    const source = e.source(guid);
    if (source.tagName !== 'CGlueSource') throw new Error('Glue not found.');
    e.field(source, 'bindVertexUids', e.array('long-array', 'bindVertexUids', pairs));
    e.field(source, 'weights', e.array('float-array', 'weights', weights));
    e.field(source, 'targetArtMeshA_guid', e.ref(g.field(a, 'guid')!, 'targetArtMeshA_guid'));
    e.field(source, 'targetArtMeshB_guid', e.ref(g.field(b, 'guid')!, 'targetArtMeshB_guid'));
    e.value(source, 'localName', input.name);
    return guid;
  }
  const source = e.identified(e.node('CGlueSource')),
    sourceGuid = e.identified(e.guid('CAffecterGuid', 'guid')),
    formGuid = e.identified(e.guid('CFormGuid', 'guid')),
    parent = g.guid(g.field(a, 'parentGuid')) || document.model.rootPartGuid!;
  let id = 'Glue',
    n = 1;
  while (document.model.objects.some((o) => o.id === id)) id = 'Glue' + ++n;
  source.appendChild(
    e.node('ACAffecterSource', 'super', {}, [
      e.control(input.name, parent, formGuid),
      sourceGuid,
      e.node('CAffecterId', 'id', { idstr: id }),
      e.guid('CDeformerGuid', 'targetDeformerGuid', ROOT_DEFORMER),
      e.scalar('i', 'editVersion', 0),
    ]),
  );
  for (const node of [
    e.list('carray_list', 'keyforms', [
      e.node('CGlueForm', undefined, {}, [
        e.node('ACAffecterForm', 'super', {}, [e.formBase(source, formGuid)]),
        e.scalar('f', 'intensity', 1),
      ]),
    ]),
    e.ref(g.field(a, 'guid')!, 'targetArtMeshA_guid'),
    e.ref(g.field(b, 'guid')!, 'targetArtMeshB_guid'),
    e.array('float-array', 'weights', weights),
    e.array('long-array', 'bindVertexUids', pairs),
    e.scalar('b', 'isEditing', false),
    e.node('GVector2', 'tabPosOnCanvas', {}, [e.scalar('f', 'x', 0), e.scalar('f', 'y', 0)]),
  ])
    source.appendChild(node);
  e.addSource('affecterSourceSet', source, parent);
  e.imports([
    'com.live2d.cubism.doc.model.affecter.glue.CGlueSource',
    'com.live2d.cubism.doc.model.affecter.glue.CGlueForm',
    'com.live2d.cubism.doc.model.affecter.ACAffecterSource',
    'com.live2d.cubism.doc.model.affecter.ACAffecterForm',
    'com.live2d.cubism.doc.model.id.CAffecterId',
    'com.live2d.type.CAffecterGuid',
    'com.live2d.graphics3d.type.GVector2',
  ]);
  return sourceGuid.getAttribute('uuid')!;
}

export function removeGlue(document: Cmo3Document, guid: string) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    source = e.source(guid);
  if (source.tagName !== 'CGlueSource') throw new Error('Glue not found.');
  const sources = g.field(g.field(g.source, 'affecterSourceSet'), '_sources')!,
    part = e.source(g.guid(g.field(source, 'parentGuid'))!),
    ids = g.field(part, '_childGuids')!;
  for (const list of [sources, ids]) {
    for (const child of children(list)) {
      if (list === sources ? g.resolve(child) === source : g.guid(child) === guid)
        list.removeChild(child);
    }
    list.setAttribute('count', String(children(list).length));
  }
}

export function pruneGlueVertices(document: Cmo3Document, meshGuid: string) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    mesh = e.source(meshGuid),
    ext = g.list(mesh, '_extensions').find((n) => n.tagName === 'CEditableMeshExtension'),
    uids = new Set(g.numbers(g.field(ext || null, 'editableMesh'), 'pointUid'));
  for (const glue of g.sources('affecterSourceSet').filter((n) => n.tagName === 'CGlueSource')) {
    const side =
      g.guid(g.field(glue, 'targetArtMeshA_guid')) === meshGuid
        ? 0
        : g.guid(g.field(glue, 'targetArtMeshB_guid')) === meshGuid
          ? 1
          : -1;
    if (side < 0) continue;
    const pairs = g.numbers(glue, 'bindVertexUids'),
      weights = g.numbers(glue, 'weights'),
      keep = Array.from({ length: pairs.length / 2 }, (_, i) => i).filter((i) =>
        uids.has(pairs[i * 2 + side]),
      );
    e.field(
      glue,
      'bindVertexUids',
      e.array(
        'long-array',
        'bindVertexUids',
        keep.flatMap((i) => pairs.slice(i * 2, i * 2 + 2)),
      ),
    );
    e.field(
      glue,
      'weights',
      e.array(
        'float-array',
        'weights',
        keep.flatMap((i) => weights.slice(i * 2, i * 2 + 2)),
      ),
    );
  }
}
