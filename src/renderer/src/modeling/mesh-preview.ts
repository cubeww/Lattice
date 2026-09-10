import type { TopologyPreview } from '../../../core/model/topology-preview';
import type { MeshEdge, SourceScene } from '../../../shared/scene';
import type { TopologyVertex } from '../../../shared/types';
import type { Point } from '../../../core/model/evaluate';

export interface ManualMeshOverlay {
  guid: string;
  vertices: TopologyVertex[];
  indices: number[];
  edges: MeshEdge[];
  selected: number[];
  hover: number | null;
  guide: Point[];
  pen: { to: Point; from: number[] } | null;
  eraser: { center: Point; size: number; edgesOnly: boolean } | null;
  showOthers: boolean;
}
export interface MeshPreview {
  documentId: string;
  documentRevision: number;
  enabled: boolean;
  scene: SourceScene | null;
  geometry: TopologyPreview | null;
  manual?: ManualMeshOverlay;
}
let preview: MeshPreview | null = null;
const listeners = new Set<() => void>();
export const getMeshPreview = () => preview;
export function setMeshPreview(value: MeshPreview | null) {
  preview = value;
  for (const listener of listeners) listener();
}
export function subscribeMeshPreview(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
