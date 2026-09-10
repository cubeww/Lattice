import type {
  Color,
  KeyBinding,
  SourceDeformer,
  SourceForm,
  SourceMesh,
  SourceNode,
  SourcePart,
  SourceScene,
} from '../../shared/scene';
import { strokeMesh } from './curves';

export interface EvaluatedMesh {
  source: SourceMesh;
  positions: Float32Array;
  opacity: number;
  drawOrder: number;
  multiply: Color;
  screen: Color;
  visible: boolean;
  toCanvas: Transform;
  controlPositions?: Float32Array;
  ungluedPositions?: Float32Array;
  vertexColors?: Float32Array;
}
export type Point = [number, number];
export type Transform = (x: number, y: number) => Point;
interface DeformerState {
  transform: Transform;
  scale: number;
  opacity: number;
  multiply: Color;
  screen: Color;
  visible: boolean;
}
export interface EvaluatedDeformer {
  source: SourceDeformer;
  positions: Float32Array;
  toCanvas: Transform;
  transform: Transform;
  visible: boolean;
}
interface DrawGroup {
  part: SourcePart;
  children: (SourceMesh | DrawGroup)[];
}
const discreteOrder = (value: number) => Math.trunc(value + 0.001 * Math.sign(value));
const identity: Transform = (x, y) => [x, y];
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function bindingWeights(binding: KeyBinding, value: number): [number, number][] {
  const keys = binding.keys;
  if (keys.length === 1 || value <= keys[0]) return [[0, 1]];
  if (value >= keys[keys.length - 1]) return [[keys.length - 1, 1]];
  const hi = keys.findIndex((key) => key >= value),
    lo = hi - 1;
  const t = (value - keys[lo]) / (keys[hi] - keys[lo]);
  if (binding.interpolation === 'nearest') return [[t < 0.5 ? lo : hi, 1]];
  return [
    [lo, 1 - t],
    [hi, t],
  ];
}

export function interpolateForm(node: SourceNode, values: Record<string, number>): SourceForm {
  const weights = node.bindings.map(
    (b) => new Map(bindingWeights(b, values[b.parameterId] ?? b.keys[0])),
  );
  const result: SourceForm = {
    guid: '',
    keys: [],
    positions: Array(node.forms[0].positions.length).fill(0),
    opacity: 0,
    drawOrder: 0,
    multiply: [0, 0, 0, 0],
    screen: [0, 0, 0, 0],
    rotation:
      node.kind === 'rotation'
        ? { x: 0, y: 0, angle: 0, scale: 0, reflectX: false, reflectY: false }
        : null,
    ...(node.forms[0].pathPoints
      ? {
          pathPoints: node.forms[0].pathPoints.map(() => ({
            width: 0,
            opacity: 0,
            color: [0, 0, 0, 0] as Color,
            corner: false,
            start: [0, 0] as Point,
            end: [0, 0] as Point,
          })),
        }
      : {}),
  };
  for (const form of node.forms) {
    let weight = 1;
    for (let i = 0; i < weights.length; i++) weight *= weights[i].get(form.keys[i]) || 0;
    if (!weight) continue;
    for (let i = 0; i < form.positions.length; i++)
      result.positions[i] += form.positions[i] * weight;
    result.opacity += form.opacity * weight;
    result.drawOrder += form.drawOrder * weight;
    for (let i = 0; i < 4; i++) {
      result.multiply[i] += form.multiply[i] * weight;
      result.screen[i] += form.screen[i] * weight;
    }
    if (result.rotation && form.rotation) {
      for (const key of ['x', 'y', 'angle', 'scale'] as const)
        result.rotation[key] += form.rotation[key] * weight;
      result.rotation.reflectX ||= form.rotation.reflectX;
      result.rotation.reflectY ||= form.rotation.reflectY;
    }
    if (result.pathPoints && form.pathPoints)
      form.pathPoints.forEach((point, index) => {
        const target = result.pathPoints![index];
        target.width += point.width * weight;
        target.opacity += point.opacity * weight;
        target.corner ||= point.corner;
        for (let i = 0; i < 4; i++) target.color[i] += point.color[i] * weight;
        for (let i = 0; i < 2; i++) {
          target.start[i] += point.start[i] * weight;
          target.end[i] += point.end[i] * weight;
        }
      });
  }
  return result;
}

/** Unit-square warp: bilinear cells or the editor's upper-right/lower-left
 * diagonal. The outer ring blends into an affine field at [-2,3]. */
export function warpPoint(
  points: ArrayLike<number>,
  columns: number,
  rows: number,
  quad: boolean,
  x: number,
  y: number,
): Point {
  const at = (col: number, row: number): Point => {
    const i = 2 * (row * (columns + 1) + col);
    return [points[i], points[i + 1]];
  };
  const outside = x < 0 || x > 1 || y < 0 || y > 1;
  let affine: Transform = identity;
  if (outside) {
    const a = at(0, 0),
      b = at(columns, 0),
      c = at(0, rows),
      d = at(columns, rows);
    const ux = (d[0] - a[0] + b[0] - c[0]) / 2,
      uy = (d[1] - a[1] + b[1] - c[1]) / 2;
    const vx = (d[0] - a[0] - b[0] + c[0]) / 2,
      vy = (d[1] - a[1] - b[1] + c[1]) / 2;
    const ox = (a[0] + b[0] + c[0] + d[0]) / 4 - (ux + vx) / 2,
      oy = (a[1] + b[1] + c[1] + d[1]) / 4 - (uy + vy) / 2;
    affine = (u, v) => [ox + ux * u + vx * v, oy + uy * u + vy * v];
    if (x <= -2 || x >= 3 || y <= -2 || y >= 3) return affine(x, y);
  }
  const interval = (value: number, count: number): [number, number, number] => {
    if (value < 0) return [-2, 0, (value + 2) / 2];
    if (value > 1) return [1, 3, (value - 1) / 2];
    const low = Math.min(count - 1, Math.floor(value * count));
    return [low / count, (low + 1) / count, value * count - low];
  };
  const [x0, x1, u] = interval(x, columns),
    [y0, y1, v] = interval(y, rows);
  const point = (u: number, v: number): Point =>
    u < 0 || u > 1 || v < 0 || v > 1
      ? affine(u, v)
      : at(Math.round(u * columns), Math.round(v * rows));
  const a = point(x0, y0),
    b = point(x1, y0),
    c = point(x0, y1),
    d = point(x1, y1);
  if (quad && !outside)
    return [
      a[0] * (1 - u) * (1 - v) + b[0] * u * (1 - v) + c[0] * (1 - u) * v + d[0] * u * v,
      a[1] * (1 - u) * (1 - v) + b[1] * u * (1 - v) + c[1] * (1 - u) * v + d[1] * u * v,
    ];
  if (u + v <= 1)
    return [a[0] * (1 - u - v) + b[0] * u + c[0] * v, a[1] * (1 - u - v) + b[1] * u + c[1] * v];
  return [
    d[0] * (u + v - 1) + c[0] * (1 - u) + b[0] * (1 - v),
    d[1] * (u + v - 1) + c[1] * (1 - u) + b[1] * (1 - v),
  ];
}

export class ModelEvaluator {
  evaluatedDeformers: EvaluatedDeformer[] = [];
  private readonly deformers: Map<string, SourceDeformer>;
  private readonly parts: Map<string, SourcePart>;
  private readonly defaults: Record<string, number>;
  private readonly drawGroup: DrawGroup;
  constructor(readonly scene: SourceScene) {
    this.deformers = new Map(scene.deformers.map((n) => [n.guid, n]));
    this.parts = new Map(scene.parts.map((n) => [n.guid, n]));
    this.defaults = Object.fromEntries(scene.parameters.map((p) => [p.id, p.default]));
    for (const [nodes, key] of [
      [this.deformers, 'deformerGuid'],
      [this.parts, 'parentGuid'],
    ] as const) {
      for (const node of nodes.values()) {
        const visited = new Set<string>();
        let current: SourceNode | undefined = node;
        while (current) {
          if (visited.has(current.guid)) throw new Error(`Cyclic source hierarchy: ${node.id}`);
          visited.add(current.guid);
          current = nodes.get(current[key]!);
        }
      }
    }
    const meshes = new Map(scene.meshes.map((mesh) => [mesh.guid, mesh]));
    const visited = new Set<string>();
    const collect = (guid: string): (SourceMesh | DrawGroup)[] => {
      if (visited.has(guid)) throw new Error('Duplicate or cyclic part children.');
      visited.add(guid);
      const part = this.parts.get(guid);
      if (!part) {
        const mesh = meshes.get(guid);
        return mesh ? [mesh] : [];
      }
      const children = part.children.flatMap(collect);
      // The part tree is front-to-back. Stable sorting preserves its reverse
      // order for tied draw orders, within each enabled draw-order group.
      return part.drawOrderGroup || guid === scene.rootPartGuid
        ? [{ part, children: children.reverse() }]
        : children;
    };
    if (!this.parts.has(scene.rootPartGuid)) throw new Error('The root part is unavailable.');
    this.drawGroup = collect(scene.rootPartGuid)[0] as DrawGroup;
    if (scene.meshes.some((mesh) => !visited.has(mesh.guid)))
      throw new Error('A mesh is absent from the part tree.');
  }
  evaluate(input: Record<string, number>): EvaluatedMesh[] {
    this.evaluatedDeformers = [];
    const values = { ...this.defaults, ...input };
    for (const parameter of this.scene.parameters)
      values[parameter.id] = clamp(values[parameter.id], parameter.min, parameter.max);
    const parts = new Map<string, { opacity: number; visible: boolean; drawOrder: number }>();
    const part = (
      guid: string | null,
    ): { opacity: number; visible: boolean; drawOrder: number } => {
      if (!guid || !this.parts.has(guid)) return { opacity: 1, visible: true, drawOrder: 0 };
      const cached = parts.get(guid);
      if (cached) return cached;
      const node = this.parts.get(guid)!,
        parent = part(node.parentGuid),
        form = interpolateForm(node, values);
      const result = {
        opacity: form.opacity * parent.opacity,
        visible: node.visible && parent.visible,
        drawOrder: discreteOrder(form.drawOrder),
      };
      parts.set(guid, result);
      return result;
    };
    const cache = new Map<string, DeformerState>();
    const root: DeformerState = {
      transform: identity,
      scale: 1,
      opacity: 1,
      multiply: [1, 1, 1, 1],
      screen: [0, 0, 0, 0],
      visible: true,
    };
    const deform = (guid: string | null): DeformerState => {
      if (!guid || !this.deformers.has(guid)) return root;
      const cached = cache.get(guid);
      if (cached) return cached;
      const node = this.deformers.get(guid)!,
        parent = deform(node.deformerGuid),
        form = interpolateForm(node, values);
      // Attachment is defined by targetDeformerGuid. Serialized keyforms can
      // still say Canvas after reparenting (mark's right arm is an example).
      const transformParent = parent.transform;
      const owner = part(node.parentGuid);
      let transform: Transform,
        scale = parent.scale;
      if (node.kind === 'warp') {
        const points = new Float32Array(form.positions.length);
        for (let i = 0; i < points.length; i += 2)
          points.set(transformParent(form.positions[i], form.positions[i + 1]), i);
        transform = (x, y) => warpPoint(points, node.columns, node.rows, node.quad, x, y);
      } else {
        const rotation = form.rotation!;
        const [ox, oy] = transformParent(rotation.x, rotation.y);
        let angle = ((rotation.angle + node.baseAngle) * Math.PI) / 180;
        if (node.deformerGuid) {
          // Follow the parent's transformed vertical direction. Rotation
          // children inherit rotation scales, not warp-grid dimensions.
          const epsilon = this.deformers.get(node.deformerGuid!)?.kind === 'rotation' ? -10 : -0.1;
          const p = transformParent(rotation.x, rotation.y + epsilon);
          if (Math.hypot(p[0] - ox, p[1] - oy) > 1e-10)
            angle += Math.atan2(-(p[0] - ox) / epsilon, (p[1] - oy) / epsilon);
        }
        scale *= rotation.scale;
        const a = Math.cos(angle) * scale * (rotation.reflectX ? -1 : 1),
          b = -Math.sin(angle) * scale * (rotation.reflectY ? -1 : 1);
        const c = Math.sin(angle) * scale * (rotation.reflectX ? -1 : 1),
          d = Math.cos(angle) * scale * (rotation.reflectY ? -1 : 1);
        transform = (x, y) => [a * x + b * y + ox, c * x + d * y + oy];
      }
      const result: DeformerState = {
        transform,
        scale,
        opacity: form.opacity * parent.opacity,
        multiply: form.multiply.map((v, i) => v * parent.multiply[i]) as Color,
        screen: form.screen.map((v, i) => v + parent.screen[i] * (1 - v)) as Color,
        // Deformer visibility controls its editing guides, not its child artwork.
        visible: parent.visible && owner.visible,
      };
      cache.set(guid, result);
      const positions =
        node.kind === 'warp'
          ? Float32Array.from(form.positions)
          : Float32Array.from([form.rotation!.x, form.rotation!.y]);
      for (let i = 0; i < positions.length; i += 2)
        positions.set(transformParent(positions[i], positions[i + 1]), i);
      this.evaluatedDeformers.push({
        source: node,
        positions,
        toCanvas: transformParent,
        transform,
        visible: node.visible && owner.visible,
      });
      return result;
    };
    const evaluated = this.scene.meshes.map((source) => {
      const form = interpolateForm(source, values),
        parent = deform(source.deformerGuid),
        owner = part(source.parentGuid);
      const transform = parent.transform,
        positions = new Float32Array(form.positions.length);
      for (let i = 0; i < positions.length; i += 2)
        positions.set(transform(form.positions[i], form.positions[i + 1]), i);
      const path = source.path,
        geometry = path
          ? strokeMesh(
              Array.from({ length: positions.length / 2 }, (_, i) => [
                positions[i * 2],
                positions[i * 2 + 1],
              ]),
              form.pathPoints?.map((p) => p.width) || path.widths,
              path.divisions,
              path.closed,
              form.pathPoints?.map((p) => p.corner) || path.corners,
            )
          : null;
      const vertexColors =
        path && form.pathPoints ? new Float32Array(geometry!.positions.length * 2) : undefined;
      if (vertexColors && path && form.pathPoints) {
        const points = form.pathPoints;
        for (let i = 0; i < vertexColors.length / 8; i++) {
          const index = Math.min(points.length - 1, Math.floor(i / path.divisions)),
            next = path.closed
              ? (index + 1) % points.length
              : Math.min(points.length - 1, index + 1),
            t = (i % path.divisions) / path.divisions;
          const a = points[index],
            b = points[next];
          for (let channel = 0; channel < 4; channel++) {
            const value =
              channel === 3
                ? a.opacity * a.color[3] * (1 - t) + b.opacity * b.color[3] * t
                : a.color[channel] * (1 - t) + b.color[channel] * t;
            vertexColors[i * 8 + channel] = value;
            vertexColors[i * 8 + 4 + channel] = value;
          }
        }
      }
      return {
        source,
        toCanvas: transform,
        ungluedPositions: new Float32Array(positions),
        positions: geometry ? Float32Array.from(geometry.positions) : positions,
        ...(geometry ? { controlPositions: positions } : {}),
        ...(vertexColors ? { vertexColors } : {}),
        opacity: clamp(form.opacity * parent.opacity * owner.opacity),
        drawOrder: discreteOrder(form.drawOrder),
        multiply: form.multiply.map(
          (v, i) => v * parent.multiply[i] * (path && !vertexColors ? path.color[i] : 1),
        ) as Color,
        screen: form.screen.map((v, i) => v + parent.screen[i] * (1 - v)) as Color,
        visible: source.visible && parent.visible && owner.visible,
      };
    });
    const byGuid = new Map(evaluated.map((mesh) => [mesh.source.guid, mesh]));
    const unglued = new Map(evaluated.map((m) => [m.source.guid, new Float32Array(m.positions)]));
    for (const glue of this.scene.glues || []) {
      if (!glue.visible) continue;
      const a = byGuid.get(glue.meshA),
        b = byGuid.get(glue.meshB);
      if (!a || !b) continue;
      const pa = unglued.get(glue.meshA)!,
        pb = unglued.get(glue.meshB)!,
        intensity = interpolateForm(glue, values).opacity;
      for (const p of glue.pairs)
        for (let axis = 0; axis < 2; axis++) {
          const i = p.indexA * 2 + axis,
            j = p.indexB * 2 + axis,
            delta = pb[j] - pa[i];
          a.positions[i] = pa[i] + delta * p.weightA * intensity;
          b.positions[j] = pb[j] - delta * p.weightB * intensity;
        }
    }
    const sortGroup = (group: DrawGroup): EvaluatedMesh[] =>
      group.children
        .map((child) =>
          'part' in child
            ? { order: part(child.part.guid).drawOrder, meshes: sortGroup(child) }
            : { order: byGuid.get(child.guid)!.drawOrder, meshes: [byGuid.get(child.guid)!] },
        )
        .sort((a, b) => a.order - b.order)
        .flatMap((item) => item.meshes);
    for (const node of this.scene.deformers) deform(node.guid);
    return sortGroup(this.drawGroup);
  }
}
