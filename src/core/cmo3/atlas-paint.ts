import { PNG } from 'pngjs';
import { atlasMatrix, atlasBounds, type AtlasItem } from '../../shared/atlas';

/** Render one source image; the atlas page clips artwork extending outside its bounds. */
export function paintAtlasImage(png: PNG, item: AtlasItem) {
  const image = item,
    bounds = atlasBounds(item);
  const bitmap = PNG.sync.read(Buffer.from(image.url.split(',')[1], 'base64')),
    matrix = atlasMatrix(item),
    inv = invert(matrix);
  for (
    let y = Math.max(0, Math.floor(bounds.y));
    y < Math.min(png.height, Math.ceil(bounds.y + bounds.height));
    y++
  )
    for (
      let x = Math.max(0, Math.floor(bounds.x));
      x < Math.min(png.width, Math.ceil(bounds.x + bounds.width));
      x++
    ) {
      const u = inv[0] * (x + 0.5) + inv[2] * (y + 0.5) + inv[4] - 0.5,
        v = inv[1] * (x + 0.5) + inv[3] * (y + 0.5) + inv[5] - 0.5;
      if (u < -0.5 || v < -0.5 || u >= bitmap.width - 0.5 || v >= bitmap.height - 0.5) continue;
      // Bilinear sampling in premultiplied alpha avoids dark fringes at rotated edges.
      const rgba = [0, 0, 0, 0],
        ix = Math.floor(u),
        iy = Math.floor(v),
        fx = u - ix,
        fy = v - iy;
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const px = ix + dx,
            py = iy + dy;
          if (px < 0 || py < 0 || px >= bitmap.width || py >= bitmap.height) continue;
          const offset = (py * bitmap.width + px) * 4,
            w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy),
            alpha = bitmap.data[offset + 3] / 255;
          rgba[3] += alpha * w;
          for (let c = 0; c < 3; c++) rgba[c] += bitmap.data[offset + c] * alpha * w;
        }
      const offset = (y * png.width + x) * 4,
        alpha = rgba[3],
        oldAlpha = png.data[offset + 3] / 255,
        out = alpha + oldAlpha * (1 - alpha);
      for (let c = 0; c < 3; c++)
        png.data[offset + c] = out
          ? (rgba[c] + png.data[offset + c] * oldAlpha * (1 - alpha)) / out
          : 0;
      png.data[offset + 3] = out * 255;
    }
}

const invert = (m: readonly number[]) => {
  const [a, b, c, d, x, y] = m,
    det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('Atlas transform is singular.');
  return [d / det, -b / det, -c / det, a / det, (c * y - d * x) / det, (b * x - a * y) / det];
};
