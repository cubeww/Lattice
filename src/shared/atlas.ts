import type { ModelObject } from './types';

export interface AtlasLayout {
  atlasGuid?: string;
  name?: string;
  width?: number;
  height?: number;
  addImages: 'unassigned' | 'visible' | string[];
  padding: number;
}

export interface AtlasPlacement {
  guid: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  angle: number;
}
export interface AtlasImage {
  name: string;
  guid: string;
  width: number;
  height: number;
  url: string;
  meshGuids: string[];
}
export interface AtlasItem extends AtlasPlacement, AtlasImage {}
export interface TextureAtlas {
  guid: string;
  name: string;
  width: number;
  height: number;
  items: AtlasItem[];
}
export interface AtlasEdit {
  guid: string;
  name: string;
  width: number;
  height: number;
  items: AtlasPlacement[];
}
export interface AtlasWorkspace {
  atlases: TextureAtlas[];
  unassigned: AtlasImage[];
}
/** Resolve current Part/mesh visibility without rebuilding cached image assets. */
export function visibleAtlasImages(images: AtlasImage[], objects: ModelObject[]): Set<string> {
  const byGuid = new Map(objects.map((o) => [o.guid, o]));
  const visible = (guid: string) => {
    let object = byGuid.get(guid);
    if (!object) return false;
    const visited = new Set<string>();
    while (object) {
      if (!object.visible || visited.has(object.guid)) return false;
      visited.add(object.guid);
      object = object.parentGuid ? byGuid.get(object.parentGuid) : undefined;
    }
    return true;
  };
  return new Set(images.filter((i) => i.meshGuids.some(visible)).map((i) => i.guid));
}
export function atlasMatrix(p: AtlasPlacement) {
  const angle = (p.angle * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return [c * p.scaleX, s * p.scaleX, -s * p.scaleY, c * p.scaleY, p.x, p.y] as const;
}
export function atlasBounds(p: AtlasPlacement & Pick<AtlasImage, 'width' | 'height'>) {
  const [a, b, c, d, x, y] = atlasMatrix(p),
    corners = [
      [0, 0],
      [p.width, 0],
      [0, p.height],
      [p.width, p.height],
    ].map(([u, v]) => [a * u + c * v + x, b * u + d * v + y]);
  const left = Math.min(...corners.map((p) => p[0])),
    top = Math.min(...corners.map((p) => p[1]));
  return {
    x: left,
    y: top,
    width: Math.max(...corners.map((p) => p[0])) - left,
    height: Math.max(...corners.map((p) => p[1])) - top,
  };
}
