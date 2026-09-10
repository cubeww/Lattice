import type { AutomaticMeshInput } from '../../shared/automatic-mesh';
import type { SourceScene, SourceTexture } from '../../shared/scene';

/** Mesh editing uses original layer pixels, as the native editor does. */
export function modelImageScene(scene: SourceScene, inputs: AutomaticMeshInput[]): SourceScene {
  const textures: SourceTexture[] = [],
    byUrl = new Map<string, number>(),
    byGuid = new Map(inputs.map((i) => [i.guid, i]));
  const textureIndex = (image: SourceTexture) => {
    let index = byUrl.get(image.url);
    if (index === undefined) {
      index = textures.length;
      byUrl.set(image.url, index);
      textures.push(image);
    }
    return index;
  };
  const meshes = scene.meshes.map((mesh) => {
    const input = byGuid.get(mesh.guid);
    if (mesh.path) return { ...mesh, texture: textureIndex(scene.textures[mesh.texture]) };
    if (!input) throw new Error(`${mesh.id}: the original model image is unavailable.`);
    const [a, b, c, d, x, y] = input.toTexture,
      det = a * d - b * c;
    return {
      ...mesh,
      texture: textureIndex(input.image),
      uvs: mesh.uvs.map((value, i, uv) => {
        const u = uv[i - (i % 2)] - x,
          v = uv[i - (i % 2) + 1] - y;
        return i % 2
          ? (a * v - b * u) / (det * input.image.height)
          : (d * u - c * v) / (det * input.image.width);
      }),
    };
  });
  return { ...scene, meshes, textures };
}
