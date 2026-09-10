import type { ModelObject, VertexEdit } from '../../shared/types';
import type { SourceScene } from '../../shared/scene';
import type { EvaluatedDeformer, EvaluatedMesh } from './evaluate';
import { locked, related } from './selection';

export interface ModelPoint {
  guid: string;
  index: number;
  x: number;
  y: number;
}

export function pointTriangles(scene: SourceScene, guid: string): number[] {
  const mesh = scene.meshes.find((m) => m.guid === guid);
  if (mesh) {
    if (!mesh.path) return mesh.indices;
    const count = mesh.forms[0].positions.length / 2;
    return Array.from({ length: mesh.path.closed ? count : count - 1 }, (_, i) => [
      i,
      (i + 1) % count,
      (i + 1) % count,
    ]).flat();
  }
  const warp = scene.deformers.find((d) => d.guid === guid && d.kind === 'warp');
  const indices: number[] = [];
  if (warp)
    for (let y = 0; y < warp.rows; y++)
      for (let x = 0; x < warp.columns; x++) {
        const a = y * (warp.columns + 1) + x,
          b = a + 1,
          c = a + warp.columns + 1,
          d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
  return indices;
}

/** The same visible, unlocked edit points used by the viewport and modeling commands. */
export function modelingPoints(
  meshes: EvaluatedMesh[],
  deformers: EvaluatedDeformer[],
  objects: Map<string, ModelObject>,
  guids: string[],
  allMeshes = false,
  lockedGuids?: ReadonlySet<string>,
): ModelPoint[] {
  const selected = meshes.filter(
    (m) =>
      m.visible &&
      m.opacity > 0.01 &&
      (allMeshes ||
        guids.some((guid) =>
          objects.get(guid)?.kind === 'part'
            ? related(objects, m.source.guid, guid)
            : guid === m.source.guid,
        )),
  );
  const warps = deformers.filter(
    (d) => d.visible && d.source.kind === 'warp' && guids.includes(d.source.guid),
  );
  return [...selected, ...warps]
    .filter((m) => !(lockedGuids ? lockedGuids.has(m.source.guid) : locked(objects, m.source.guid)))
    .flatMap((mesh) => {
      const points =
        'controlPositions' in mesh && mesh.controlPositions
          ? mesh.controlPositions
          : mesh.positions;
      return Array.from({ length: points.length / 2 }, (_, index) => ({
        guid: mesh.source.guid,
        index,
        x: points[index * 2],
        y: points[index * 2 + 1],
      }));
    });
}

export function groupVertexEdits(points: ModelPoint[]): VertexEdit[] {
  const edits = new Map<string, VertexEdit>();
  for (const p of points) {
    const edit = edits.get(p.guid) || { guid: p.guid, points: [] };
    edit.points.push({ index: p.index, x: p.x, y: p.y });
    edits.set(p.guid, edit);
  }
  return [...edits.values()];
}

/** Only commit affected vertices: untouched keyforms must not be rounded or added to history. */
export function changedVertexEdits(edits: VertexEdit[], before: ModelPoint[]): VertexEdit[] {
  const originals = new Map(before.map((p) => [`${p.guid}:${p.index}`, p]));
  return edits
    .map((edit) => ({
      ...edit,
      points: edit.points.filter((p) => {
        const original = originals.get(`${edit.guid}:${p.index}`)!;
        return Math.abs(original.x - p.x) > 1e-7 || Math.abs(original.y - p.y) > 1e-7;
      }),
    }))
    .filter((edit) => edit.points.length);
}
