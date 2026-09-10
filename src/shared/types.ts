import type { AtlasEdit, AtlasLayout } from './atlas';
import type { AutomaticMeshSettings } from './automatic-mesh';
import type { InspectedObject, ObjectProperties } from './inspector';
import type { SourcePreview, Affine, MeshEdge } from './scene';
import type { CreatePart } from './parts';
import type { ProjectResources, ProjectResourceProperties } from './project';
import type { PsdImportOptions } from './psd';
import type { FormClipboard, FormEdit } from './form-edit';
import type { ModelGuide, MotionMirroring } from './motion-mirroring';
import type {
  ParameterDefinition,
  ParameterGroup,
  ParameterKeyEdit,
  ParameterPanelState,
} from './parameters';

export type Locale = 'en' | 'zh-CN' | 'ja';
export type ObjectKind = 'part' | 'mesh' | 'rotation' | 'warp' | 'artpath' | 'glue';
export type CanvasTool =
  | 'select'
  | 'pan'
  | 'lasso'
  | 'brushSelect'
  | 'deformBrush'
  | 'rotationDraw'
  | 'deformPath'
  | 'artPath'
  | 'glue';
export interface TopologyVertex {
  u: number;
  v: number;
  sourceIndex?: number;
}
export interface CreateDeformer {
  kind: 'warp' | 'rotation';
  guids: string[];
  name: string;
  placement: 'parent' | 'child';
  columns: number;
  rows: number;
  bezierColumns: number;
  bezierRows: number;
  origin?: [number, number];
  handleLength?: number;
  angle?: number;
}
export type PointSelection = Record<string, Record<string, number>>;
export interface VertexEdit {
  guid: string;
  points: { index: number; x: number; y: number }[];
}
export interface BrushSettings {
  size: number;
  hardness: number;
  strength: number;
  shape: 'circle' | 'square';
  angle: number;
  brushMode: 'move' | 'inflate' | 'smooth';
}
export interface ToolSettings extends BrushSettings {
  pathWidth: number;
  pathColor: string;
}
export type SelectionRegion =
  | { type: 'rectangle'; points: [[number, number], [number, number]] }
  | { type: 'lasso' | 'brush'; points: [number, number][] };
export type SelectionMode = 'replace' | 'add' | 'subtract';

export interface ModelObject {
  guid: string;
  id: string;
  name: string;
  kind: ObjectKind;
  parentGuid: string | null;
  deformerGuid: string | null;
  visible: boolean;
  locked: boolean;
  drawOrder: number;
  vertexCount: number;
  keyformCount: number;
}
export interface Parameter {
  guid: string;
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  keys: number[];
  bindings: Record<string, number[]>;
  groupGuid: string;
  combined: boolean;
  repeat: boolean;
  description: string;
  decimalPlaces: number;
  type: string;
}
export interface ModelDocument {
  physics: import('./physics').PhysicsSettings;
  path: string | null;
  name: string;
  formatVersion: string;
  canvas: { width: number; height: number };
  guides: ModelGuide[];
  objects: ModelObject[];
  parameters: Parameter[];
  parameterGroups: ParameterGroup[];
  rootParameterGroupGuid: string;
  rootPartGuid: string | null;
  archiveEntries: number;
}
export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
  grid: boolean;
  mesh: boolean;
  background: 'checker' | 'white' | 'dark';
  tool: CanvasTool;
  editLevel: 1 | 2 | 3;
}
export interface EditorState {
  revision: number;
  documentRevision: number;
  document: ModelDocument | null;
  preview: SourcePreview | null;
  previewReady: boolean;
  previewError: string | null;
  selectedGuid: string | null;
  selectedGuids: string[];
  pointSelection: PointSelection;
  formClipboard: {
    serial: number;
    items: {
      guid: string;
      id: string;
      name: string;
      kind: import('./form-edit').FormKind;
      pointCount: number;
    }[];
  };
  toolSettings: ToolSettings;
  parameterValues: Record<string, number>;
  parameterPanel: ParameterPanelState;
  inspector: InspectedObject[];
  project: ProjectResources | null;
  projectSelection: string[];
  inspectorTarget: 'objects' | 'project';
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  view: ViewState;
  locale: Locale;
  recentFiles: string[];
  sampleAvailable: boolean;
  log: { time: string; message: string }[];
  bridge: { connected: boolean; port: number | null };
}
export type EditorCommand =
  | { type: 'editPhysics'; edits: import('./physics').PhysicsEdit[]; expectedRevision: number }
  | { type: 'importPhysics'; path: string; mode: 'replace' | 'append'; expectedRevision: number }
  | { type: 'exportPhysics'; path: string; expectedRevision: number }
  | {
      type: 'editKeyformBatch';
      frames: import('./workflow').KeyformBatch;
      expectedRevision: number;
    }
  | { type: 'mirrorMotion'; value: MotionMirroring; expectedRevision: number }
  | { type: 'copyForms'; guids: string[]; expectedRevision: number }
  | { type: 'editForms'; value: FormEdit; expectedRevision: number }
  | { type: 'selectProject'; keys: string[] }
  | {
      type: 'editProjectResource';
      key: string;
      values: ProjectResourceProperties;
      expectedRevision: number;
    }
  | { type: 'createMeshesFromImages'; keys: string[]; expectedRevision: number }
  | { type: 'assignModelImage'; key: string; guids: string[]; expectedRevision: number }
  | { type: 'setTextureMode'; mode: 'modelImage' | 'atlas'; expectedRevision: number }
  | { type: 'deleteProjectImages'; keys: string[]; expectedRevision: number }
  | { type: 'exportProjectImage'; key: string; path: string; expectedRevision: number }
  | { type: 'createPart'; value: CreatePart; expectedRevision: number }
  | {
      type: 'movePartObjects';
      guids: string[];
      parentGuid: string | null;
      beforeGuid?: string;
      expectedRevision: number;
    }
  | {
      type: 'deletePartObjects';
      guids: string[];
      mode: 'subtree' | 'partsOnly';
      expectedRevision: number;
    }
  | { type: 'pruneEmptyParts'; parentGuid: string | null; expectedRevision: number }
  | {
      type: 'setObjectFlags';
      guids: string[];
      values: { visible?: boolean; locked?: boolean };
      expectedRevision: number;
    }
  | {
      type: 'moveDeformerObjects';
      guids: string[];
      deformerGuid: string | null;
      expectedRevision: number;
    }
  | { type: 'pruneEmptyDeformers'; parentGuid: string | null; expectedRevision: number }
  | {
      type: 'editObjectProperties';
      guids: string[];
      values: ObjectProperties;
      expectedRevision: number;
    }
  | { type: 'new' }
  | { type: 'open'; path: string; psd?: PsdImportOptions; expectedRevision?: number }
  | { type: 'close' }
  | { type: 'select'; guid: string | null }
  | { type: 'selectMany'; guids: string[]; points?: PointSelection }
  | {
      type: 'selectRegion';
      guids?: string[];
      region: SelectionRegion;
      mode: SelectionMode;
      settings?: Partial<BrushSettings>;
      expectedRevision: number;
    }
  | {
      type: 'deformBrush';
      guids?: string[];
      points: [number, number][];
      settings?: Partial<BrushSettings>;
      selection?: PointSelection;
      expectedRevision: number;
    }
  | { type: 'autoLayoutAtlas'; value: AtlasLayout; expectedRevision: number }
  | { type: 'editVertices'; edits: VertexEdit[]; expectedRevision: number }
  | { type: 'toolSettings'; value: Partial<ToolSettings> }
  | { type: 'createDeformer'; value: CreateDeformer; expectedRevision: number }
  | {
      type: 'editRotation';
      guid: string;
      value: { x?: number; y?: number; angle?: number; scale?: number };
      preserveChildren?: boolean;
      expectedRevision: number;
    }
  | {
      type: 'editTopology';
      guid: string;
      textureMode?: 'modelImage' | 'atlas';
      vertices: TopologyVertex[];
      indices?: number[];
      edges?: MeshEdge[];
      expectedRevision: number;
    }
  | {
      type: 'automaticMesh';
      guids: string[];
      settings: AutomaticMeshSettings;
      expectedRevision: number;
    }
  | {
      type: 'createArtPath';
      points: [number, number][];
      name: string;
      width: number;
      color: string;
      parentGuid: string | null;
      deformerGuid: string | null;
      expectedRevision: number;
    }
  | {
      type: 'createController';
      guid: string;
      points: [number, number][];
      width: number;
      hardness: number;
      expectedRevision: number;
    }
  | { type: 'editAtlases'; atlases: AtlasEdit[]; expectedRevision: number }
  | {
      type: 'setGlue';
      guid?: string;
      value: {
        name: string;
        meshA: string;
        meshB: string;
        pairs: { indexA: number; indexB: number; weightA: number; weightB: number }[];
      };
      expectedRevision: number;
    }
  | { type: 'removeGlue'; guid: string; expectedRevision: number }
  | {
      type: 'editGlueWeights';
      changes: { guid: string; weights: { index: number; weightA: number; weightB: number }[] }[];
      expectedRevision: number;
    }
  | { type: 'rename'; guid: string; name: string }
  | { type: 'transformMesh'; guid: string; matrix: Affine; expectedRevision: number }
  | { type: 'setParameter'; id: string; value: number }
  | { type: 'setParameters'; values: Record<string, number>; editId?: string }
  | { type: 'beginParameterEdit'; editId: string; ids: string[] }
  | { type: 'endParameterEdit'; editId: string; cancel?: boolean }
  | { type: 'resetParameters'; ids?: string[] }
  | { type: 'parameterPanel'; value: Partial<ParameterPanelState> }
  | {
      type: 'createParameter';
      value: ParameterDefinition;
      groupGuid: string;
      expectedRevision: number;
    }
  | { type: 'editParameter'; guid: string; value: ParameterDefinition; expectedRevision: number }
  | { type: 'createParameterGroup'; name: string; parentGuid: string; expectedRevision: number }
  | { type: 'renameParameterGroup'; guid: string; name: string; expectedRevision: number }
  | {
      type: 'moveParameterEntries';
      guids: string[];
      groupGuid: string;
      beforeGuid?: string;
      expectedRevision: number;
    }
  | { type: 'deleteParameterEntries'; guids: string[]; expectedRevision: number }
  | { type: 'linkParameter'; guid: string; combined: boolean; expectedRevision: number }
  | {
      type: 'editParameterKeys';
      guids: string[];
      edits: ParameterKeyEdit[];
      expectedRevision: number;
    }
  | { type: 'setParameterDefaults'; ids?: string[]; expectedRevision: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save'; path?: string }
  | {
      type: 'view';
      value: Partial<ViewState>;
      expectedCamera?: Pick<ViewState, 'zoom' | 'panX' | 'panY' | 'tool'> & {
        previewId: string | null;
      };
    }
  | { type: 'locale'; value: Locale };

export interface LatticeApi {
  physicsFileDialog(action: 'import' | 'export', mode?: 'replace' | 'append'): Promise<void>;
  state(): Promise<EditorState>;
  command(command: EditorCommand): Promise<EditorState>;
  formClipboard(): Promise<FormClipboard>;
  newDocument(): Promise<void>;
  saveDocument(): Promise<void>;
  chooseFile(): Promise<string | null>;
  openDocument(path: string, psd?: PsdImportOptions, expectedRevision?: number): Promise<void>;
  saveDialog(): Promise<void>;
  exportImageDialog(key: string): Promise<void>;
  closeDocument(): Promise<void>;
  openSample(): Promise<void>;
  previewReady(id: string, error: string | null): Promise<void>;
  onPreviewRequest(
    listener: (
      request: import('./workflow').PreviewRequest,
    ) => Promise<import('./workflow').PreviewReply>,
  ): () => void;
  onState(listener: (state: EditorState) => void): () => void;
}
