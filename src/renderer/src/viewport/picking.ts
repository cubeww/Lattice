import type { EvaluatedMesh } from '../../../core/model/evaluate';
export interface AlphaTexture {
  width: number;
  height: number;
  alpha: Uint8Array;
}
export function textureAlpha(texture: AlphaTexture, u: number, v: number): number {
  const x = u * texture.width - 0.5,
    y = v * texture.height - 0.5,
    x0 = Math.floor(x),
    y0 = Math.floor(y),
    fx = x - x0,
    fy = y - y0;
  const sample = (x: number, y: number) =>
    x < 0 || y < 0 || x >= texture.width || y >= texture.height
      ? 0
      : texture.alpha[y * texture.width + x] / 255;
  return (
    sample(x0, y0) * (1 - fx) * (1 - fy) +
    sample(x0 + 1, y0) * fx * (1 - fy) +
    sample(x0, y0 + 1) * (1 - fx) * fy +
    sample(x0 + 1, y0 + 1) * fx * fy
  );
}
export function meshAlpha(
  mesh: EvaluatedMesh,
  textures: AlphaTexture[],
  x: number,
  y: number,
): number {
  if (!mesh.visible || mesh.opacity <= 0.01) return 0;
  const p = mesh.positions,
    uv = mesh.source.uvs,
    indices = mesh.source.indices;
  let alpha = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 2,
      b = indices[i + 1] * 2,
      c = indices[i + 2] * 2;
    const det = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1]);
    if (Math.abs(det) < 1e-10 || (mesh.source.culling && det <= 0)) continue;
    const u = ((x - p[a]) * (p[c + 1] - p[a + 1]) - (y - p[a + 1]) * (p[c] - p[a])) / det;
    const v = ((p[b] - p[a]) * (y - p[a + 1]) - (p[b + 1] - p[a + 1]) * (x - p[a])) / det;
    if (u < 0 || v < 0 || u + v > 1) continue;
    const fragment =
      mesh.opacity *
      textureAlpha(
        textures[mesh.source.texture],
        uv[a] * (1 - u - v) + uv[b] * u + uv[c] * v,
        uv[a + 1] * (1 - u - v) + uv[b + 1] * u + uv[c + 1] * v,
      );
    // Folded meshes can cover a pixel more than once. Match alpha compositing
    // instead of letting a transparent first triangle hide later fragments.
    alpha += (1 - alpha) * fragment;
    if (alpha >= 1) return 1;
  }
  return alpha;
}
export function pickMesh(
  meshes: EvaluatedMesh[],
  textures: AlphaTexture[],
  x: number,
  y: number,
  locked: Set<string>,
): string | null {
  const byGuid = new Map(meshes.map((mesh) => [mesh.source.guid, mesh]));
  for (let i = meshes.length - 1; i >= 0; i--) {
    const mesh = meshes[i];
    if (locked.has(mesh.source.guid)) continue;
    let alpha = meshAlpha(mesh, textures, x, y);
    if (alpha <= 0.04) continue;
    if (mesh.source.clips.length) {
      let outside = 1;
      for (const id of mesh.source.clips) {
        const mask = byGuid.get(id);
        if (mask) outside *= 1 - meshAlpha(mask, textures, x, y);
      }
      alpha *= mesh.source.inverted ? outside : 1 - outside;
    }
    if (alpha > 0.04) return mesh.source.guid;
  }
  return null;
}
