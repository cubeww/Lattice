import type { Affine } from './scene';
import type { TopologyVertex } from './types';

export const automaticMeshFields = {
  outsideInterval: { min: 10, max: 200 },
  insideInterval: { min: 10, max: 200 },
  outsideMargin: { min: 0, max: 50 },
  insideMargin: { min: 0, max: 50 },
  minimumMargin: { min: 1, max: 10 },
  minimumBoundaryPoints: { min: 3, max: 20 },
  alphaThreshold: { min: 0, max: 254 },
} as const;
export type AutomaticMeshSettings = Record<keyof typeof automaticMeshFields, number>;
export const automaticMeshPresets = {
  standard: {
    outsideInterval: 50,
    insideInterval: 50,
    outsideMargin: 14,
    insideMargin: 14,
    minimumMargin: 5,
    minimumBoundaryPoints: 10,
    alphaThreshold: 0,
  },
  little: {
    outsideInterval: 80,
    insideInterval: 80,
    outsideMargin: 14,
    insideMargin: 14,
    minimumMargin: 5,
    minimumBoundaryPoints: 15,
    alphaThreshold: 0,
  },
  heavy: {
    outsideInterval: 25,
    insideInterval: 25,
    outsideMargin: 3,
    insideMargin: 2,
    minimumMargin: 2,
    minimumBoundaryPoints: 5,
    alphaThreshold: 0,
  },
} satisfies Record<string, AutomaticMeshSettings>;

/** Source-image pixels → normalized UVs in the mesh's active texture. */
export interface AutomaticMeshInput {
  guid: string;
  name: string;
  image: { url: string; width: number; height: number };
  toTexture: Affine;
  anchors: { x: number; y: number; sourceIndex: number }[];
}
export interface GeneratedMesh {
  guid: string;
  vertices: TopologyVertex[];
  indices: number[];
  boundaryLoops: number[][];
}
export interface MeshGenerationWorkspace {
  revision: number;
  inputs: AutomaticMeshInput[];
  errors: Record<string, string>;
}
