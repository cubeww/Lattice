export type Color = [number, number, number, number];
export type Affine = [number, number, number, number, number, number];
export interface KeyBinding {
  parameterId: string;
  keys: number[];
  interpolation: 'linear' | 'nearest';
}
export interface SourceForm {
  guid: string;
  keys: number[];
  positions: number[];
  opacity: number;
  drawOrder: number;
  multiply: Color;
  screen: Color;
  rotation: {
    x: number;
    y: number;
    angle: number;
    scale: number;
    reflectX: boolean;
    reflectY: boolean;
  } | null;
  pathPoints?: {
    width: number;
    opacity: number;
    color: Color;
    corner: boolean;
    start: [number, number];
    end: [number, number];
  }[];
}
export interface SourceNode {
  guid: string;
  id: string;
  kind: 'part' | 'mesh' | 'warp' | 'rotation' | 'glue';
  parentGuid: string | null;
  deformerGuid: string | null;
  visible: boolean;
  bindings: KeyBinding[];
  forms: SourceForm[];
}
export interface SourceMesh extends SourceNode {
  kind: 'mesh';
  uvs: number[];
  indices: number[];
  editableEdges?: MeshEdge[];
  texture: number;
  clips: string[];
  inverted: boolean;
  blend: 'normal' | 'add' | 'multiply';
  culling: boolean;
  path?: { closed: boolean; divisions: number; widths: number[]; color: Color; corners: boolean[] };
  controllers?: SourceController[];
}
/** Native editable-mesh priorities: automatic, user triangulation, normal, locked. */
export interface MeshEdge {
  a: number;
  b: number;
  priority: 10 | 20 | 30 | 40;
}
export interface SourceController {
  guid: string;
  width: number;
  hardness: number;
  points: { indices: [number, number, number]; weights: [number, number, number] }[];
}
export interface SourcePart extends SourceNode {
  kind: 'part';
  children: string[];
  drawOrderGroup: boolean;
}
export interface SourceDeformer extends SourceNode {
  kind: 'warp' | 'rotation';
  columns: number;
  rows: number;
  quad: boolean;
  baseAngle: number;
  handleLength?: number;
  bezier?: { level: number; columns: number; rows: number }[];
}
export interface SourceGlue extends SourceNode {
  kind: 'glue';
  meshA: string;
  meshB: string;
  pairs: { indexA: number; indexB: number; weightA: number; weightB: number }[];
}
export interface SourceTexture {
  url: string;
  width: number;
  height: number;
}
export interface SourceScene {
  canvas: { width: number; height: number };
  parameters: { id: string; min: number; max: number; default: number }[];
  rootPartGuid: string;
  parts: SourcePart[];
  deformers: SourceDeformer[];
  meshes: SourceMesh[];
  textures: SourceTexture[];
  warnings: string[];
  glues?: SourceGlue[];
}
export interface SourcePreview {
  id: string;
  revision: number;
  sceneUrl: string;
  atlasUrl?: string;
  meshGenerationUrl?: string;
  meshCount: number;
  textureCount: number;
  warnings: string[];
}
