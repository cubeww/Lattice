/** Squared Euclidean distance to zero-valued sites, separable in linear time. */
function distanceTransform(data: Float32Array, width: number, height: number) {
  const size = Math.max(width, height),
    values = new Float64Array(size),
    sites = new Int32Array(size),
    boundaries = new Float64Array(size + 1);
  const line = (start: number, stride: number, length: number) => {
    for (let q = 0; q < length; q++) values[q] = data[start + q * stride];
    let k = 0;
    sites[0] = 0;
    boundaries[0] = -Infinity;
    boundaries[1] = Infinity;
    for (let q = 1; q < length; q++) {
      let s: number;
      do {
        const p = sites[k];
        s = (values[q] - values[p] + q * q - p * p) / (2 * (q - p));
        if (s > boundaries[k]) break;
        k--;
      } while (k >= 0);
      k++;
      sites[k] = q;
      boundaries[k] = s!;
      boundaries[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < length; q++) {
      while (boundaries[k + 1] < q) k++;
      const p = sites[k];
      data[start + q * stride] = (q - p) ** 2 + values[p];
    }
  };
  for (let x = 0; x < width; x++) line(x, width, height);
  for (let y = 0; y < height; y++) line(y * width, 1, width);
}

/** Pixel-centre distance, positive inside the alpha silhouette. */
export function signedDistance(mask: Uint8Array, width: number, height: number) {
  const inside = new Float32Array(mask.length),
    outside = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    inside[i] = mask[i] ? 1e12 : 0;
    outside[i] = mask[i] ? 0 : 1e12;
  }
  distanceTransform(inside, width, height);
  distanceTransform(outside, width, height);
  for (let i = 0; i < mask.length; i++)
    inside[i] = mask[i] ? Math.sqrt(inside[i]) - 0.5 : 0.5 - Math.sqrt(outside[i]);
  return inside;
}
