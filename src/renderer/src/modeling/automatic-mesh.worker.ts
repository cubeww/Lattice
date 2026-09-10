import { generateAutomaticMesh } from '../../../core/model/automatic-mesh';
import { topologyPreview, type TopologyPreview } from '../../../core/model/topology-preview';
import { modelImageScene } from '../../../core/model/model-image-scene';
import type {
  AutomaticMeshInput,
  AutomaticMeshSettings,
  GeneratedMesh,
} from '../../../shared/automatic-mesh';
import type { SourceScene } from '../../../shared/scene';

export type MeshWorkerRequest =
  | { type: 'load'; inputs: AutomaticMeshInput[]; guids: string[]; scene: SourceScene }
  | { type: 'generate'; id: number; settings: AutomaticMeshSettings };
export type MeshWorkerResponse =
  | { type: 'ready'; scene: SourceScene }
  | { type: 'error'; id?: number; message: string }
  | { type: 'result'; id: number; meshes: GeneratedMesh[]; geometry: TopologyPreview };
let loaded: Promise<{
  inputs: AutomaticMeshInput[];
  scene: SourceScene;
  images: Map<string, Uint8Array>;
}>;
const send = (response: MeshWorkerResponse) => postMessage(response);
async function readImages(inputs: AutomaticMeshInput[]) {
  const images = new Map<string, Uint8Array>();
  for (const { image } of inputs) {
    if (images.has(image.url)) continue;
    if (image.width * image.height > 67_108_864) throw new Error('The source image is too large.');
    const response = await fetch(image.url);
    if (!response.ok) throw new Error('Could not read the model image.');
    const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
    try {
      if (bitmap.width !== image.width || bitmap.height !== image.height)
        throw new Error('Source image dimensions do not match.');
      const canvas = new OffscreenCanvas(image.width, image.height),
        context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, image.width, image.height).data,
        alpha = new Uint8Array(image.width * image.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      images.set(image.url, alpha);
    } finally {
      bitmap.close();
    }
  }
  return images;
}
onmessage = async (event: MessageEvent<MeshWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      const scene = modelImageScene(request.scene, request.inputs),
        inputs = request.inputs
          .filter((i) => request.guids.includes(i.guid))
          .map((i) => ({
            ...i,
            toTexture: [
              1 / i.image.width,
              0,
              0,
              1 / i.image.height,
              0,
              0,
            ] as AutomaticMeshInput['toTexture'],
          }));
      loaded = readImages(inputs).then((images) => ({ inputs, scene, images }));
      await loaded;
      send({ type: 'ready', scene });
    } else {
      const { inputs, scene, images } = await loaded,
        meshes = inputs.map((input) =>
          generateAutomaticMesh(input, images.get(input.image.url)!, request.settings),
        );
      send({ type: 'result', id: request.id, meshes, geometry: topologyPreview(scene, meshes) });
    }
  } catch (error) {
    send({
      type: 'error',
      id: request.type === 'generate' ? request.id : undefined,
      message: (error as Error).message,
    });
  }
};
