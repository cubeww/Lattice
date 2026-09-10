import { MotionMirroringError, type MotionMirroring } from '../../shared/motion-mirroring';
import type { ModelDocument } from '../../shared/types';
import type { SourceNode, SourceScene } from '../../shared/scene';
import { ModelEvaluator, type Point, type Transform } from './evaluate';
import { formDepth } from './form-edit';
import { inversePoint, keyformAt, locked } from './selection';
import { sampleSurface, surfacePoint } from './topology';

const identity: Transform = (x, y) => [x, y];
const equal = (a: number, b: number) => Math.abs(a - b) < 1e-6;
// A one-key binding evaluates everywhere, but mirroring must not overwrite its
// only form when the destination key has not been created yet.
export const motionKeyform = (node: SourceNode, values: Record<string, number>) =>
  node.bindings.every((b) => b.keys.some((k) => equal(k, values[b.parameterId])))
    ? keyformAt(node, values)
    : null;

export function motionMirroringPlan(
  document: ModelDocument,
  scene: SourceScene,
  guids: string[],
  parameterId: string,
  values: Record<string, number>,
) {
  const parameter = document.parameters.find((p) => p.id === parameterId);
  if (!parameter || parameter.type !== 'NORMAL' || !guids.length)
    throw new MotionMirroringError('motionSelectParameter');
  const group = document.parameterGroups.find((g) => g.guid === parameter.groupGuid);
  const previous = group?.children[(group.children.indexOf(parameter.guid) || 0) - 1];
  if (parameter.combined || document.parameters.find((p) => p.guid === previous)?.combined)
    throw new MotionMirroringError('motionLinkedParameter');
  if (parameter.repeat) throw new MotionMirroringError('motionRepeatParameter');
  const defaults = Object.fromEntries(scene.parameters.map((p) => [p.id, p.default]));
  const sourceValues = { ...defaults, ...values };
  const sourceValue = sourceValues[parameter.id];
  if (!Number.isFinite(sourceValue) || equal(sourceValue, parameter.default))
    throw new MotionMirroringError('motionAtDefault');
  const targetValue = Math.fround(2 * parameter.default - sourceValue);
  if (targetValue < parameter.min || targetValue > parameter.max)
    throw new MotionMirroringError('motionOutsideRange');
  const defaultValues = { ...sourceValues, [parameter.id]: parameter.default };
  const targetValues = { ...sourceValues, [parameter.id]: targetValue };
  const all = new Map([...scene.meshes, ...scene.deformers].map((n) => [n.guid, n]));
  const objects = new Map(document.objects.map((o) => [o.guid, o]));
  const nodes = [...new Set(guids)]
    .map((guid) => {
      const node = all.get(guid);
      if (!node || (node.kind === 'mesh' && node.path))
        throw new MotionMirroringError('motionUnsupportedObject', objects.get(guid)?.id);
      if (locked(objects, guid)) throw new MotionMirroringError('motionLockedObject', node.id);
      if (!node.bindings.some((b) => b.parameterId === parameterId))
        throw new MotionMirroringError('motionMissingBinding', node.id);
      if (!motionKeyform(node, sourceValues))
        throw new MotionMirroringError('motionMissingSource', node.id);
      if (!motionKeyform(node, defaultValues))
        throw new MotionMirroringError('motionMissingDefault', node.id);
      if (node.kind === 'mesh' && node.indices.length < 3)
        throw new MotionMirroringError('motionMissingMesh', node.id);
      return node;
    })
    .sort((a, b) => formDepth(a, all) - formDepth(b, all));
  const unselectedParents = new Set<string>();
  for (const node of nodes) {
    let parent = all.get(node.deformerGuid!);
    while (parent) {
      if (
        !guids.includes(parent.guid) &&
        parent.bindings.some((b) => b.parameterId === parameterId)
      )
        unselectedParents.add(parent.guid);
      parent = all.get(parent.deformerGuid!);
    }
  }
  return {
    parameter,
    sourceValue,
    targetValue,
    sourceValues,
    defaultValues,
    targetValues,
    nodes,
    unselectedParents: [...unselectedParents],
    existingTargets: nodes.filter((n) => motionKeyform(n, targetValues)).length,
  };
}

export function motionMirrorCenter(
  document: ModelDocument,
  scene: SourceScene,
  value: MotionMirroring,
  values: Record<string, number>,
) {
  const horizontal = value.direction === 'horizontal';
  const axis = value.axis;
  if (axis.type === 'canvas') return scene.canvas[horizontal ? 'width' : 'height'] / 2;
  if (axis.type === 'guide') {
    const guide = document.guides.find((g) => g.guid === axis.guid);
    if (!guide || guide.direction === value.direction)
      throw new MotionMirroringError('motionMissingGuide');
    return guide.position;
  }
  const node = scene.deformers.find((d) => d.guid === axis.guid && d.kind === 'rotation');
  if (!node) throw new MotionMirroringError('motionMissingRotation');
  const evaluator = new ModelEvaluator({ ...scene, meshes: [], glues: [] });
  evaluator.evaluate(values);
  return evaluator.evaluatedDeformers.find((d) => d.source === node)!.positions[horizontal ? 0 : 1];
}

/** Mirror the movement field into existing destination forms. Native key-grid
 * insertion is separate; geometry never changes vertex order, UVs or triangles. */
export function mirrorMotionScene(
  scene: SourceScene,
  value: MotionMirroring,
  values: Record<string, number>,
  center: number,
): SourceScene {
  const after = structuredClone(scene);
  const parameter = scene.parameters.find((p) => p.id === value.parameterId)!;
  const defaults = Object.fromEntries(scene.parameters.map((p) => [p.id, p.default]));
  const sourceValues = { ...defaults, ...values };
  const defaultValues = { ...sourceValues, [parameter.id]: parameter.default };
  const targetValues = {
    ...sourceValues,
    [parameter.id]: Math.fround(2 * parameter.default - sourceValues[parameter.id]),
  };
  const all = new Map([...after.deformers, ...after.meshes].map((n) => [n.guid, n]));
  const before = new Map([...scene.deformers, ...scene.meshes].map((n) => [n.guid, n]));
  const selected = [...new Set(value.guids)]
    .map((guid) => all.get(guid)!)
    .sort((a, b) => formDepth(a, all) - formDepth(b, all));
  const evaluate = (pose: Record<string, number>, meshes: boolean) => {
    const evaluator = new ModelEvaluator({
      ...scene,
      meshes: meshes ? scene.meshes : [],
      glues: [],
    });
    const evaluated = evaluator.evaluate(pose);
    return new Map([
      ...evaluated.map(
        (m) => [m.source.guid, { positions: m.positions, toCanvas: m.toCanvas }] as const,
      ),
      ...evaluator.evaluatedDeformers.map(
        (d) => [d.source.guid, { positions: d.positions, toCanvas: d.toCanvas }] as const,
      ),
    ]);
  };
  const hasMeshes = selected.some((n) => n.kind === 'mesh');
  const sourcePose = evaluate(sourceValues, hasMeshes);
  const defaultPose = evaluate(defaultValues, false);
  const neutralPose = hasMeshes ? evaluate(defaults, true) : null;
  const horizontal = value.direction === 'horizontal';
  const mirror = (x: number, y: number): Point =>
    horizontal ? [2 * center - x, y] : [x, 2 * center - y];
  const direction = (node: SourceNode, parent: Transform, p: Point) => {
    if (!node.deformerGuid) return 0;
    const step = all.get(node.deformerGuid)?.kind === 'rotation' ? -10 : -0.1;
    const a = parent(...p),
      b = parent(p[0], p[1] + step);
    return (Math.atan2(-(b[0] - a[0]) / step, (b[1] - a[1]) / step) * 180) / Math.PI;
  };
  // Reuse an evaluator without meshes for target parent fields. Re-evaluate
  // only when a selected deformer changes, not for every mesh vertex/object.
  const targetEvaluator = new ModelEvaluator({ ...after, meshes: [], glues: [] });
  let parents: Map<string, Transform> | null = null;
  for (const node of selected) {
    const old = before.get(node.guid)!;
    const source = motionKeyform(old, sourceValues)!;
    const neutral = motionKeyform(old, defaultValues)!;
    const target = motionKeyform(node, targetValues);
    if (!source || !neutral || !target) throw new Error(`${node.id}: Missing motion keyform.`);
    if (!parents) {
      targetEvaluator.evaluate(targetValues);
      parents = new Map(
        targetEvaluator.evaluatedDeformers.map((d) => [d.source.guid, d.transform]),
      );
    }
    const parent = parents.get(node.deformerGuid!) || identity;
    const src = sourcePose.get(node.guid)!;
    const def = defaultPose.get(node.guid);
    target.opacity = source.opacity;
    if (node.kind === 'mesh') {
      const neutralPositions = neutralPose!.get(node.guid)!.positions;
      target.positions = Array.from({ length: neutralPositions.length / 2 }, (_, i) => {
        const reflected = mirror(neutralPositions[i * 2], neutralPositions[i * 2 + 1]);
        const point = surfacePoint(neutralPositions, node.indices, ...reflected);
        const moved = sampleSurface(src.positions, point);
        return inversePoint(parent, mirror(...moved), [
          target.positions[i * 2],
          target.positions[i * 2 + 1],
        ]);
      }).flat();
      target.drawOrder = source.drawOrder;
    } else if (node.kind === 'warp') {
      target.positions = Array.from({ length: def!.positions.length / 2 }, (_, i) => {
        const col = i % (node.columns + 1),
          row = Math.floor(i / (node.columns + 1));
        const reflected =
          (horizontal ? row : node.rows - row) * (node.columns + 1) +
          (horizontal ? node.columns - col : col);
        const dx = src.positions[reflected * 2] - def!.positions[reflected * 2];
        const dy = src.positions[reflected * 2 + 1] - def!.positions[reflected * 2 + 1];
        return inversePoint(
          parent,
          [
            def!.positions[i * 2] + (horizontal ? -dx : dx),
            def!.positions[i * 2 + 1] + (horizontal ? dy : -dy),
          ],
          [target.positions[i * 2], target.positions[i * 2 + 1]],
        );
      }).flat();
    } else {
      const s = source.rotation!,
        d = neutral.rotation!,
        r = target.rotation!;
      const x = def!.positions[0] + (horizontal ? -1 : 1) * (src.positions[0] - def!.positions[0]);
      const y = def!.positions[1] + (horizontal ? 1 : -1) * (src.positions[1] - def!.positions[1]);
      const p = inversePoint(parent, [x, y], [r.x, r.y]);
      r.angle =
        2 * (d.angle + direction(old, def!.toCanvas, [d.x, d.y])) -
        (s.angle + direction(old, src.toCanvas, [s.x, s.y])) -
        direction(node, parent, p);
      [r.x, r.y] = p;
    }
    if (node.kind !== 'mesh') parents = null;
  }
  return after;
}
