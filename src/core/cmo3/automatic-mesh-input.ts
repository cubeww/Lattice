import type { Cmo3Document } from './document';
import { readAtlasWorkspace } from './atlas';
import { atlasMatrix } from '../../shared/atlas';
import type { Affine, SourceScene } from '../../shared/scene';
import type { AutomaticMeshInput, MeshGenerationWorkspace } from '../../shared/automatic-mesh';

/** Read original layer images even when the mesh currently uses a rotated/scaled atlas. */
export function readAutomaticMeshInputs(
  document: Cmo3Document,
  scene: SourceScene,
  imageUrl: (path: string) => string,
): Omit<MeshGenerationWorkspace, 'revision'> {
  const g = document.graph,
    workspace = readAtlasWorkspace(document, imageUrl),
    images = [...workspace.unassigned, ...workspace.atlases.flatMap((a) => a.items)],
    nodes = new Map(g.sources('drawableSourceSet').map((n) => [g.guid(g.field(n, 'guid')), n])),
    inputs: AutomaticMeshInput[] = [],
    errors: Record<string, string> = {};
  for (const mesh of scene.meshes) {
    if (mesh.path) continue;
    try {
      const image = images.find((i) => i.meshGuids.includes(mesh.guid)),
        node = nodes.get(mesh.guid);
      if (!image || !node) throw new Error('This mesh has no source model image.');
      const texture = scene.textures[mesh.texture];
      let matrix: Affine = [1, 0, 0, 1, 0, 0];
      if (g.field(node, 'textureState')?.getAttribute('v') === 'TEXTURE_ATLAS') {
        const ext = g.list(node, '_extensions').find((n) => n.tagName === 'CTextureInputExtension'),
          active = g.field(ext || null, 'currentTextureInputData'),
          atlasGuid = g.guid(g.field(active, 'textureAtlasGuid')),
          atlas = workspace.atlases.find((a) => a.guid === atlasGuid),
          item = atlas?.items.find((i) => i.guid === image.guid);
        if (!item) throw new Error('The source image is missing from the active atlas.');
        matrix = [...atlasMatrix(item)];
      }
      const toTexture = matrix.map(
          (v, i) => v / (i % 2 ? texture.height : texture.width),
        ) as Affine,
        [a, b, c, d, x, y] = toTexture,
        det = a * d - b * c;
      if (Math.abs(det) < 1e-14) throw new Error('The model image transform is singular.');
      const anchors = new Set<number>();
      for (const glue of scene.glues || [])
        for (const pair of glue.pairs) {
          if (glue.meshA === mesh.guid) anchors.add(pair.indexA);
          if (glue.meshB === mesh.guid) anchors.add(pair.indexB);
        }
      inputs.push({
        guid: mesh.guid,
        name: g.text(node, 'name') || mesh.id,
        image: { url: image.url, width: image.width, height: image.height },
        toTexture,
        anchors: [...anchors]
          .sort((a, b) => a - b)
          .map((sourceIndex) => {
            const u = mesh.uvs[sourceIndex * 2] - x,
              v = mesh.uvs[sourceIndex * 2 + 1] - y;
            return { sourceIndex, x: (d * u - c * v) / det, y: (a * v - b * u) / det };
          }),
      });
    } catch (error) {
      errors[mesh.guid] = (error as Error).message;
    }
  }
  return { inputs, errors };
}
