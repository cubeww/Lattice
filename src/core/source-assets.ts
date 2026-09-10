import { readAtlasWorkspace } from './cmo3/atlas';
import { readAutomaticMeshInputs } from './cmo3/automatic-mesh-input';
import { createHash, randomUUID } from 'node:crypto';
import { readSourceScene, type SceneImage } from './cmo3/scene';
import type { Cmo3Document } from './cmo3/document';
import type { SourcePreview, SourceScene } from '../shared/scene';
import { projectIndex } from './cmo3/project';
import type { ProjectResources } from '../shared/project';

type AssetFile = { bytes: Buffer; mime: string };
type ImageFile = { key: string; file: AssetFile };

/** One preview identity per open document; resource URLs identify image contents. */
export class SourceAssets {
  readonly files = new Map<string, AssetFile>();
  readonly descriptor: SourcePreview;
  scene: SourceScene;
  readonly project: ProjectResources;
  private sceneJson: string;
  private sceneImages: SceneImage[];
  private readonly images: Map<string, ImageFile>;
  private readonly archive: Cmo3Document['archive'];
  private document: Cmo3Document;
  private readonly imageUrl: (path: string) => string;
  constructor(
    document: Cmo3Document,
    previous?: SourceAssets | null,
    sceneChanged: boolean | string[] = true,
    resourcesChanged = true,
  ) {
    const id = previous?.descriptor.id || randomUUID();
    this.document = document;
    this.archive = document.archive;
    this.images = previous?.archive === this.archive ? previous.images : new Map();
    if (previous && !resourcesChanged)
      for (const [key, file] of previous.files) this.files.set(key, file);
    const imageUrl = (path: string, bytes?: Buffer) => {
      let image = this.images.get(path);
      if (!image) {
        bytes ??= document.archive.read(path);
        const key = `${id}/${createHash('sha256').update(bytes).digest('hex')}.png`;
        image = {
          key,
          file: this.files.get(key) || previous?.files.get(key) || { bytes, mime: 'image/png' },
        };
        this.images.set(path, image);
      }
      this.files.set(image.key, image.file);
      return `lattice-asset://source/${image.key}`;
    };
    this.imageUrl = imageUrl;
    this.files.delete(`${id}/mesh-generation.json`);
    if (previous && !sceneChanged) {
      this.scene = previous.scene;
      for (const texture of this.scene.textures) {
        const key = new URL(texture.url).pathname.slice(1);
        this.files.set(key, previous.files.get(key)!);
      }
      this.sceneJson = previous.sceneJson;
      this.sceneImages = previous.sceneImages;
    } else {
      const { scene, images } = readSourceScene(
        document,
        previous && Array.isArray(sceneChanged) && !previous.scene.warnings.length
          ? { scene: previous.scene, images: previous.sceneImages, changed: new Set(sceneChanged) }
          : undefined,
      );
      scene.textures.forEach((texture, i) => {
        texture.url = imageUrl(images[i].path, images[i].bytes);
      });
      this.scene = scene;
      this.sceneImages = images;
      this.sceneJson = JSON.stringify(scene);
    }
    this.project =
      previous && !resourcesChanged ? previous.project : projectIndex(document, imageUrl).data;
    // Atlas dialogs share images with the viewport instead of encoding every PNG
    // again whenever a checkbox or native field changes.
    if (!previous || resourcesChanged)
      this.files.set(`${id}/atlases.json`, {
        bytes: Buffer.from(JSON.stringify(readAtlasWorkspace(document, imageUrl))),
        mime: 'application/json',
      });
    const revision =
      (previous?.descriptor.revision ?? 0) +
      Number(!!previous && this.sceneJson !== previous.sceneJson);
    this.descriptor = {
      id,
      revision,
      sceneUrl: `lattice-asset://source/${id}/scene.json?v=${revision}`,
      atlasUrl: `lattice-asset://source/${id}/atlases.json`,
      meshGenerationUrl: `lattice-asset://source/${id}/mesh-generation.json`,
      meshCount: this.scene.meshes.length,
      textureCount: this.scene.textures.length,
      warnings: this.scene.warnings,
    };
    this.writeScene();
  }
  read(key: string): AssetFile | undefined {
    if (key === `${this.descriptor.id}/mesh-generation.json` && !this.files.has(key))
      this.files.set(key, {
        bytes: Buffer.from(
          JSON.stringify({
            revision: this.descriptor.revision,
            ...readAutomaticMeshInputs(this.document, this.scene, this.imageUrl),
          }),
        ),
        mime: 'application/json',
      });
    return this.files.get(key);
  }
  private writeScene() {
    // Requests overtaken by another edit receive the current scene and its actual
    // revision, so newer geometry cannot be mistaken for an older edit.
    this.files.set(`${this.descriptor.id}/scene.json`, {
      bytes: Buffer.from(`{"revision":${this.descriptor.revision},${this.sceneJson.slice(1)}`),
      mime: 'application/json',
    });
  }
  updateGeometry(document: Cmo3Document, guids: string[]) {
    this.document = document;
    this.files.delete(`${this.descriptor.id}/mesh-generation.json`);
    const { scene } = readSourceScene(
      document,
      !this.scene.warnings.length
        ? { scene: this.scene, images: this.sceneImages, changed: new Set(guids) }
        : undefined,
    );
    scene.textures.forEach((texture, i) => (texture.url = this.scene.textures[i].url));
    const json = JSON.stringify(scene);
    if (json === this.sceneJson) return;
    this.scene = scene;
    this.sceneJson = json;
    this.descriptor.revision++;
    this.descriptor.sceneUrl = `lattice-asset://source/${this.descriptor.id}/scene.json?v=${this.descriptor.revision}`;
    this.writeScene();
  }
}
