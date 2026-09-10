import type { GeneratedMesh } from '../../shared/automatic-mesh';
import type { SourceMesh, SourceScene } from '../../shared/scene';
import { surfacePoint, sampleSurface } from './topology';
import { keyformAt } from './selection';

/** Mirror native keyform resampling without mutating the document or its textures. */
export function topologyPreview(scene: SourceScene, generated: GeneratedMesh[]) {
  const defaults = Object.fromEntries(scene.parameters.map((p) => [p.id, p.default])),
    byGuid = new Map(generated.map((result) => [result.guid, result])),
    remaps = new Map(
      generated.map((result) => [
        result.guid,
        new Map(
          result.vertices.flatMap((v, i) =>
            v.sourceIndex === undefined ? [] : [[v.sourceIndex, i]],
          ),
        ),
      ]),
    );
  const meshes: SourceMesh[] = generated.map((result) => {
    const mesh = scene.meshes.find((m) => m.guid === result.guid);
    if (!mesh) throw new Error('The source mesh is no longer available.');
    const mappings = result.vertices.map((v) => surfacePoint(mesh.uvs, mesh.indices, v.u, v.v)),
      forms = mesh.forms.map((form) => ({
        ...form,
        positions: mappings.flatMap((p) => sampleSurface(form.positions, p).map(Math.fround)),
      })),
      original = keyformAt(mesh, defaults) || mesh.forms[0],
      next = forms[mesh.forms.indexOf(original)];
    return {
      ...mesh,
      forms,
      uvs: result.vertices.flatMap((v) => [v.u, v.v]),
      indices: result.indices,
      controllers: mesh.controllers?.map((c) => ({
        ...c,
        points: c.points.map((p) =>
          surfacePoint(next.positions, result.indices, ...sampleSurface(original.positions, p)),
        ),
      })),
    };
  });
  const glues =
    scene.glues
      ?.filter((g) => byGuid.has(g.meshA) || byGuid.has(g.meshB))
      .map((glue) => ({
        ...glue,
        pairs: glue.pairs.map((pair) => ({
          ...pair,
          indexA: remaps.get(glue.meshA)?.get(pair.indexA) ?? pair.indexA,
          indexB: remaps.get(glue.meshB)?.get(pair.indexB) ?? pair.indexB,
        })),
      })) || [];
  return { meshes, glues };
}
export type TopologyPreview = ReturnType<typeof topologyPreview>;
