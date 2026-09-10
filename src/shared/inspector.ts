import type { ObjectKind } from './types';

export interface ObjectProperties {
  name?: string;
  id?: string;
  parentGuid?: string | null;
  deformerGuid?: string | null;
  drawOrder?: number;
  opacity?: number;
  multiply?: string;
  screen?: string;
  clips?: string[];
  inverted?: boolean;
  blend?: 'normal' | 'add' | 'multiply';
  culling?: boolean;
  userData?: string;
  drawOrderGroup?: boolean;
  guideImage?: boolean;
  angle?: number;
  scale?: number;
  baseAngle?: number;
  columns?: number;
  rows?: number;
  bezierColumns?: number;
  bezierRows?: number;
  intensity?: number;
}

export interface InspectedObject {
  guid: string;
  kind: ObjectKind;
  values: ObjectProperties;
  locked: boolean;
  keyformGuid: string | null;
  vertexCount: number;
  keyformCount: number;
}

export const keyformProperties = new Set<keyof ObjectProperties>([
  'drawOrder',
  'opacity',
  'multiply',
  'screen',
  'angle',
  'scale',
  'intensity',
]);
