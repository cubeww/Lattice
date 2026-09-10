import {
  readPsd,
  initializeCanvas,
  getLayerImageData,
  getLayerMaskImageData,
  getCompositeImageData,
  type Layer,
  type PixelData,
  type LayerMaskData,
} from 'ag-psd';
import { PNG } from 'pngjs';

export interface PsdLayer {
  name: string;
  layerId: number;
  visible: boolean;
  opacity: number;
  clipping: boolean;
  blend: 'normal' | 'multiply' | 'add';
  x: number;
  y: number;
  width: number;
  height: number;
  png?: Buffer;
  children?: PsdLayer[];
}

// Decode straight RGBA without a browser canvas or platform-specific native module.
initializeCanvas(
  () => {
    throw new Error('PSD canvas decoding is not used.');
  },
  (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    colorSpace: 'srgb',
  }),
);

export function decodePsd(bytes: Buffer) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== '8BPS' || bytes.readUInt16BE(4) !== 1)
    throw new Error('Invalid PSD file. Open a Photoshop .psd document.');
  if (bytes.readUInt16BE(22) !== 8 || bytes.readUInt16BE(24) !== 3)
    throw new Error(
      'PSD import requires RGB color and 8 bits per channel. Convert the document in Photoshop and save it again.',
    );
  const psd = readPsd(bytes, { useRawData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const size = (width: number, height: number, limit = 8192) => {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 0 ||
      height < 0 ||
      width > limit ||
      height > limit ||
      width * height > 64 * 1024 * 1024
    )
      throw new Error('PSD image dimensions exceed the supported limit.');
  };
  size(psd.width, psd.height, 30000);
  if (!psd.width || !psd.height) throw new Error('PSD canvas must have positive dimensions.');
  let count = 0,
    decodedBytes = 0;
  const budget = (width: number, height: number) => {
    size(width, height);
    decodedBytes += width * height * 4;
    if (decodedBytes > 512 * 1024 * 1024)
      throw new Error('PSD layer pixels exceed the 512 MB import limit.');
  };
  const warnings: string[] = [];
  const encode = (pixels: PixelData) => {
    const png = new PNG({ width: pixels.width, height: pixels.height });
    png.data = Buffer.from(pixels.data as Uint8ClampedArray);
    return PNG.sync.write(png);
  };
  const fail = (layer: Layer, detail: string): never => {
    throw new Error(
      `PSD layer “${layer.name || 'Layer'}”: ${detail} Rasterize or merge this effect in Photoshop before importing.`,
    );
  };
  const applyMask = (
    pixels: PixelData,
    layer: Layer,
    mask: LayerMaskData,
    decoded: PixelData | undefined,
  ) => {
    if (mask.disabled) return;
    if ((mask.userMaskFeather || mask.vectorMaskFeather || 0) > 0)
      fail(layer, 'Feathered layer masks are not supported.');
    const relative = mask.positionRelativeToLayer;
    const left = (mask.left || 0) + (relative ? layer.left || 0 : 0),
      top = (mask.top || 0) + (relative ? layer.top || 0 : 0),
      density = mask.userMaskDensity ?? mask.vectorMaskDensity ?? 1;
    for (let y = 0; y < pixels.height; y++)
      for (let x = 0; x < pixels.width; x++) {
        const mx = x + (layer.left || 0) - left,
          my = y + (layer.top || 0) - top;
        const alpha =
          decoded && mx >= 0 && my >= 0 && mx < decoded.width && my < decoded.height
            ? decoded.data[(my * decoded.width + mx) * 4]
            : (mask.defaultColor ?? 255);
        const i = (y * pixels.width + x) * 4 + 3;
        pixels.data[i] = Math.round(pixels.data[i] * (1 - density + (alpha / 255) * density));
      }
  };
  const visit = (layers: Layer[], depth = 0): PsdLayer[] => {
    if (depth > 64) throw new Error('PSD folder nesting exceeds the supported limit.');
    // PSD reader arrays run bottom-to-top; the editor's object tree runs top-to-bottom.
    return [...layers].reverse().map((layer): PsdLayer => {
      if (++count > 1000) throw new Error('PSD contains more than 1000 layers and folders.');
      if (layer.adjustment) fail(layer, 'Adjustment layers are not supported.');
      if ((layer.fillOpacity ?? 1) !== 1) fail(layer, 'Layer fill opacity is not supported.');
      if (layer.vectorMask || layer.realMask || layer.mask?.fromVectorData)
        fail(layer, 'Vector and combined layer masks are not supported.');
      if (
        layer.effects &&
        !layer.effects.disabled &&
        Object.keys(layer.effects).some((k) => !['disabled', 'scale'].includes(k))
      )
        fail(layer, 'Layer effects are not supported.');
      const group = !!layer.children,
        blend = layer.blendMode || 'normal';
      if (
        !(group ? ['normal', 'pass through'] : ['normal', 'multiply', 'linear dodge']).includes(
          blend,
        )
      )
        fail(layer, `The “${blend}” blend mode is not supported.`);
      if (group && ((layer.opacity ?? 1) !== 1 || layer.clipping || layer.mask || layer.vectorMask))
        fail(layer, 'Folder opacity, masks and folder clipping are not supported.');
      if (group && blend === 'normal') {
        const nonNormal = (nodes: Layer[]): boolean =>
          nodes.some(
            (n) =>
              (n.blendMode && !['normal', 'pass through'].includes(n.blendMode)) ||
              (n.children && nonNormal(n.children)),
          );
        if (nonNormal(layer.children!))
          fail(layer, 'Isolated folders with blend modes are not supported.');
      }
      const width = (layer.right || 0) - (layer.left || 0),
        height = (layer.bottom || 0) - (layer.top || 0);
      budget(width, height);
      if (layer.mask)
        budget(
          (layer.mask.right || 0) - (layer.mask.left || 0),
          (layer.mask.bottom || 0) - (layer.mask.top || 0),
        );
      let pixels = layer.imageData || getLayerImageData(layer);
      if (pixels && layer.mask) applyMask(pixels, layer, layer.mask, getLayerMaskImageData(layer));
      if (!group && !pixels && (layer.text || layer.placedLayer || layer.vectorFill))
        fail(layer, 'Saved layer pixels are missing.');
      if (!group && (!pixels || !width || !height))
        warnings.push(`Skipped empty PSD layer: ${layer.name || 'Layer'}`);
      const result: PsdLayer = {
        name: (layer.name || `Layer ${count}`).replace(
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
          '',
        ),
        layerId: layer.id ?? count,
        visible: !layer.hidden,
        opacity: layer.opacity ?? 1,
        clipping: !!layer.clipping,
        blend: blend === 'multiply' ? 'multiply' : blend === 'linear dodge' ? 'add' : 'normal',
        x: layer.left || 0,
        y: layer.top || 0,
        width,
        height,
        png: pixels && width && height ? encode(pixels) : undefined,
        children: group ? visit(layer.children!, depth + 1) : undefined,
      };
      pixels = undefined;
      delete layer.rawData;
      return result;
    });
  };
  let layers: PsdLayer[];
  if (psd.children?.length) layers = visit(psd.children);
  else {
    budget(psd.width, psd.height);
    const image = getCompositeImageData(psd);
    if (!image) throw new Error('PSD contains no saved layer or composite pixels.');
    layers = visit([
      {
        name: 'Background',
        left: 0,
        top: 0,
        right: psd.width,
        bottom: psd.height,
        imageData: image,
      },
    ]);
  }
  return { width: psd.width, height: psd.height, layers, warnings };
}
