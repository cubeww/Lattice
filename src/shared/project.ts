export type ProjectResourceKind =
  | 'document'
  | 'sourceRoot'
  | 'modelRoot'
  | 'sourceImage'
  | 'sourceGroup'
  | 'sourceLayer'
  | 'modelGroup'
  | 'modelImage'
  | 'imageInput';

export interface ProjectResource {
  key: string;
  kind: ProjectResourceKind;
  name: string;
  parent: string | null;
  children: string[];
  guid?: string;
  memo?: string;
  layerId?: string;
  replaced?: boolean;
  importedAt?: number;
  modifiedAt?: number;
  width?: number;
  height?: number;
  image?: { url: string; width: number; height: number };
  meshGuids: string[];
  modelImageKeys: string[];
  atlasGuids: string[];
  sourceKey?: string;
  current?: boolean;
  editable: ('name' | 'memo' | 'layerId' | 'replaced')[];
}

export interface ProjectResources {
  resources: ProjectResource[];
  textureMode: 'modelImage' | 'atlas';
  sourceCount: number;
  modelImageCount: number;
  atlasCount: number;
}

export interface ProjectResourceProperties {
  name?: string;
  memo?: string;
  layerId?: string;
  replaced?: boolean;
}

export function relatedProjectImages(project: ProjectResources, keys: string[]) {
  return [
    ...new Set(
      project.resources.filter((r) => keys.includes(r.key)).flatMap((r) => r.modelImageKeys),
    ),
  ];
}

export function relatedProjectMeshes(project: ProjectResources, keys: string[]) {
  return [
    ...new Set(project.resources.filter((r) => keys.includes(r.key)).flatMap((r) => r.meshGuids)),
  ];
}
