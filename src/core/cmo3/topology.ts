import { keyformAt } from '../model/selection';
import { bindControllers } from './controller';
import { pruneGlueVertices } from './glue';
import { PNG } from 'pngjs';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { readSourceScene } from './scene';
import { meshConnections, sampleSurface, surfacePoint, triangulate } from '../model/topology';
import type { TopologyVertex } from '../../shared/types';
import type { MeshEdge } from '../../shared/scene';
import { setTextureMode } from './image-mesh';
import { readAutomaticMeshInputs } from './automatic-mesh-input';
import { generateAutomaticMesh } from '../model/automatic-mesh';
import type { AutomaticMeshSettings } from '../../shared/automatic-mesh';

export function editTopology(
  document: Cmo3Document,
  guid: string,
  vertices: TopologyVertex[],
  providedIndices?: number[],
  providedEdges?: MeshEdge[],
) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    node = e.source(guid),
    scene = readSourceScene(document).scene,
    mesh = scene.meshes.find((m) => m.guid === guid);
  if (!mesh || node.tagName !== 'CArtMeshSource') throw new Error('Select an ArtMesh.');
  const uv = vertices.flatMap((v) => [v.u, v.v]),
    indices = providedIndices || triangulate(uv);
  if (!indices.length || indices.length % 3 || indices.some((i) => i < 0 || i >= vertices.length))
    throw new Error('A mesh requires valid triangles.');
  const connections = providedEdges ?? meshConnections(indices),
    edgeKeys = new Set<string>();
  for (const edge of connections) {
    const key = [edge.a, edge.b].sort((a, b) => a - b).join(',');
    if (
      ![edge.a, edge.b].every((i) => Number.isInteger(i) && i >= 0 && i < vertices.length) ||
      edge.a === edge.b ||
      ![10, 20, 30, 40].includes(edge.priority) ||
      edgeKeys.has(key)
    )
      throw new Error('Invalid editable mesh edge.');
    edgeKeys.add(key);
  }
  if (
    meshConnections(indices).some(
      ({ a, b }) => !edgeKeys.has([a, b].sort((a, b) => a - b).join(',')),
    )
  )
    throw new Error('Editable edges must include every triangle edge.');
  const defaultForm = keyformAt(
      mesh,
      Object.fromEntries(scene.parameters.map((p) => [p.id, p.default])),
    ),
    originalPositions = g.numbers(
      g.list(node, 'keyforms').find((f) => g.guid(g.field(f, 'guid')) === defaultForm?.guid) ||
        g.list(node, 'keyforms')[0],
      'positions',
    ),
    originalIndices = g.numbers(node, 'indices');
  const ids = vertices.flatMap((v) => (v.sourceIndex === undefined ? [] : [v.sourceIndex]));
  if (new Set(ids).size !== ids.length || ids.some((i) => i >= mesh.uvs.length / 2))
    throw new Error('Retained vertex indices must be unique and valid.');
  const mappings = vertices.map((v) => surfacePoint(mesh.uvs, mesh.indices, v.u, v.v));
  const extension = g.list(node, '_extensions').find((n) => n.tagName === 'CEditableMeshExtension'),
    editablePoints = g.numbers(g.field(extension || null, 'editableMesh'), 'point');
  const arrays = new Set();
  for (const owner of [node, ...g.list(node, 'keyforms')]) {
    const positions = g.field(owner, 'positions');
    if (!positions || arrays.has(positions)) continue;
    arrays.add(positions);
    const old = g.numbers(owner, 'positions');
    positions.textContent = mappings
      .flatMap((p) => sampleSurface(old, p))
      .map(Math.fround)
      .join(' ');
    positions.setAttribute('count', String(uv.length));
  }
  const rawUv = g.numbers(node, 'uvs');
  e.field(
    node,
    'uvs',
    e.array(
      'float-array',
      'uvs',
      mappings.flatMap((p) => sampleSurface(rawUv, p)),
    ),
  );
  e.field(node, 'indices', e.array('int-array', 'indices', indices));
  if (extension) {
    const editable = g.field(extension, 'editableMesh')!;
    const oldUids = g.numbers(editable, 'pointUid');
    let uid = g.number(editable, 'nextPointUid', Math.max(...oldUids) + 1);
    const uids = vertices.map((v) =>
        v.sourceIndex !== undefined && oldUids[v.sourceIndex] !== undefined
          ? oldUids[v.sourceIndex]
          : uid++,
      ),
      edges = connections.flatMap(({ a, b }) => [a, b]);
    e.field(
      editable,
      'point',
      e.array(
        'float-array',
        'point',
        mappings.flatMap((p) => sampleSurface(editablePoints, p)),
      ),
    );
    e.field(
      editable,
      'pointPriority',
      e.array(
        'byte-array',
        'pointPriority',
        vertices.map(() => 20),
      ),
    );
    e.field(editable, 'pointUid', e.array('int-array', 'pointUid', uids));
    e.field(editable, 'edge', e.array('short-array', 'edge', edges));
    e.field(
      editable,
      'edgePriority',
      e.array(
        'byte-array',
        'edgePriority',
        connections.map((edge) => edge.priority),
      ),
    );
    editable.setAttribute('nextPointUid', String(uid));
    editable.setAttribute('useDelaunayTriangulation', 'true');
  }
  bindControllers(document, guid, originalPositions, originalIndices);
  pruneGlueVertices(document, guid);
}

export function automaticMesh(
  document: Cmo3Document,
  guids: string[],
  settings: AutomaticMeshSettings,
) {
  setTextureMode(document, 'modelImage');
  const { scene } = readSourceScene(document),
    workspace = readAutomaticMeshInputs(document, scene, (path) => path);
  const images = new Map<string, Uint8Array>();
  for (const guid of new Set(guids)) {
    const input = workspace.inputs.find((i) => i.guid === guid);
    if (!input) throw new Error(workspace.errors[guid] || 'Select an ArtMesh.');
    let alpha = images.get(input.image.url);
    if (!alpha) {
      const png = PNG.sync.read(document.archive.read(input.image.url));
      alpha = new Uint8Array(png.width * png.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = png.data[i * 4 + 3];
      images.set(input.image.url, alpha);
    }
    const generated = generateAutomaticMesh(input, alpha, settings);
    editTopology(document, guid, generated.vertices, generated.indices);
  }
}
