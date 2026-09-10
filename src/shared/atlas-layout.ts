import potpack from 'potpack';
import {
  atlasBounds,
  type AtlasItem,
  type AtlasLayout,
  type AtlasWorkspace,
  type TextureAtlas,
} from './atlas';

/** Prepare a page without touching the workspace; UI drafts and MCP commits use this plan. */
export function autoLayoutAtlas(
  workspace: AtlasWorkspace,
  visible: ReadonlySet<string>,
  options: AtlasLayout,
  newGuid: string,
): TextureAtlas | null {
  const current = options.atlasGuid
    ? workspace.atlases.find((a) => a.guid === options.atlasGuid)
    : undefined;
  if (options.atlasGuid && !current) throw new Error('Texture atlas not found.');
  if (!current && workspace.atlases.length >= 16)
    throw new Error('At most 16 texture atlases are supported.');
  const available = new Map(workspace.unassigned.map((i) => [i.guid, i]));
  const ids = Array.isArray(options.addImages)
    ? options.addImages
    : workspace.unassigned
        .filter((i) => options.addImages === 'unassigned' || visible.has(i.guid))
        .map((i) => i.guid);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate model image.');
  const additions = ids.map((id) => {
    const image = available.get(id);
    if (!image) throw new Error('Only unassigned model images can be added.');
    return { ...image, x: 0, y: 0, scaleX: 1, scaleY: 1, angle: 0 };
  });
  const width = options.width ?? current?.width ?? 1024,
    height = options.height ?? current?.height ?? 1024;
  const items = layoutAtlasItems(
    [...(current?.items || []), ...additions],
    width,
    height,
    options.padding,
  );
  return items
    ? {
        guid: current?.guid || newGuid,
        name: options.name ?? current?.name ?? `Texture ${workspace.atlases.length + 1}`,
        width,
        height,
        items,
      }
    : null;
}

/** Fit image rectangles inside the chosen page, preserving aspect ratios and angles. */
export function layoutAtlasItems(
  items: AtlasItem[],
  width: number,
  height: number,
  padding: number,
): AtlasItem[] | null {
  if (!items.length) return [];
  let scale = 1;
  for (let attempt = 0; attempt < 32; attempt++) {
    const boxes = items.map((original) => {
      const item = {
        ...original,
        scaleX: original.scaleX * scale,
        scaleY: original.scaleY * scale,
      };
      const bounds = atlasBounds(item);
      return {
        item,
        bounds,
        w: (Math.ceil(bounds.width) + padding * 2) / width,
        h: (Math.ceil(bounds.height) + padding * 2) / height,
        x: 0,
        y: 0,
      };
    });
    if (
      boxes.some((b) => b.item.scaleX < 0.01 || b.item.scaleY < 0.01 || !Number.isFinite(b.w + b.h))
    )
      return null;
    const result = potpack(boxes);
    if (result.w <= 1 && result.h <= 1) {
      const placements = new Map(
        boxes.map((b) => [
          b.item.guid,
          {
            ...b.item,
            x: b.x * width + padding + b.item.x - b.bounds.x,
            y: b.y * height + padding + b.item.y - b.bounds.y,
          },
        ]),
      );
      return items.map((i) => placements.get(i.guid)!);
    }
    scale *= Math.min(1 / result.w, 1 / result.h) * 0.98;
  }
  return null;
}
