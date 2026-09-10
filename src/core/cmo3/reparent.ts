import type { ObjectProperties } from '../../shared/inspector';
import type { SourceScene } from '../../shared/scene';
import { ModelEvaluator, interpolateForm, type Transform } from '../model/evaluate';
import { inversePoint, locked } from '../model/selection';
import type { Cmo3Document } from './document';
import { XmlEdit, ROOT_DEFORMER } from './edit';
import { children } from './xml';

const identity: Transform = (x, y) => [x, y];

export function reparentObjects(
  document: Cmo3Document,
  scene: SourceScene,
  guids: string[],
  values: ObjectProperties,
  parameters: Record<string, number>,
) {
  const e = new XmlEdit(document.graph),
    g = e.g,
    objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  // Validate the resulting hierarchy, including all objects in a batch.
  for (const [key, kinds, root] of [
    ['parentGuid', ['part'], document.model.rootPartGuid!],
    ['deformerGuid', ['warp', 'rotation'], ROOT_DEFORMER],
  ] as const) {
    if (values[key] === undefined) continue;
    const target = values[key] || root;
    if (
      target !== root &&
      (!objects.has(target) ||
        !(kinds as readonly string[]).includes(objects.get(target)!.kind) ||
        locked(objects, target))
    )
      throw new Error('Select an unlocked parent of the correct type.');
    const parents = new Map(
      [...objects.values()].map((o) => [o.guid, guids.includes(o.guid) ? target : o[key]]),
    );
    for (const guid of guids) {
      const seen = new Set<string>();
      let current: string | null | undefined = guid;
      while (current && current !== root) {
        if (seen.has(current))
          throw new Error('An object cannot be its own parent or belong to its descendant.');
        seen.add(current);
        current = parents.get(current);
      }
    }
  }
  const target = values.deformerGuid || ROOT_DEFORMER;
  const nodes = new Map([...scene.meshes, ...scene.deformers].map((n) => [n.guid, n]));
  // Capture conversions before modifying any parent. Each form is evaluated at its own keys.
  const conversions = guids.flatMap((guid) => {
    const object = objects.get(guid)!;
    if (values.deformerGuid === undefined || (object.deformerGuid || ROOT_DEFORMER) === target)
      return [];
    const node = nodes.get(guid),
      source = e.source(guid);
    if (!node) throw new Error('This object cannot be converted to another deformer.');
    if (g.list(g.field(source, 'keyformMorphTargetSet'), '_morphTargets').length)
      throw new Error('Reparenting objects with blend shapes is not supported.');
    const nativeForms = g.list(source, 'keyforms');
    if (nativeForms.length !== node.forms.length)
      throw new Error('Reparenting requires a complete keyform grid.');
    return node.forms
      .map((form) => {
        const pose = { ...parameters };
        node.bindings.forEach((b, i) => {
          pose[b.parameterId] = b.keys[form.keys[i]];
        });
        const evaluator = new ModelEvaluator(scene);
        evaluator.evaluate(pose);
        const oldParent =
          evaluator.evaluatedDeformers.find((d) => d.source.guid === node.deformerGuid)
            ?.transform || identity;
        const newParent =
          evaluator.evaluatedDeformers.find((d) => d.source.guid === target)?.transform || identity;
        const convert = (x: number, y: number) => inversePoint(newParent, oldParent(x, y), [x, y]);
        const native = nativeForms.find((f) => g.guid(g.field(f, 'guid')) === form.guid)!;
        const points: number[] = [];
        for (let i = 0; i < form.positions.length; i += 2)
          points.push(...convert(form.positions[i], form.positions[i + 1]));
        let rotation: { x: number; y: number; angle: number; scale: number } | undefined;
        if (form.rotation) {
          const r = form.rotation,
            p = convert(r.x, r.y);
          const direction = (transform: Transform, x: number, y: number) => {
            const a = transform(x, y),
              b = transform(x, y - 0.1);
            return Math.atan2(b[0] - a[0], a[1] - b[1]);
          };
          const scale = (id: string | null): number => {
            const parent = scene.deformers.find((d) => d.guid === id);
            return parent
              ? (interpolateForm(parent, pose).rotation?.scale ?? 1) * scale(parent.deformerGuid)
              : 1;
          };
          rotation = {
            x: p[0],
            y: p[1],
            angle:
              r.angle +
              ((direction(oldParent, r.x, r.y) - direction(newParent, ...p)) * 180) / Math.PI,
            scale: (r.scale * scale(node.deformerGuid)) / scale(target),
          };
          if (!Number.isFinite(rotation.scale) || rotation.scale <= 0)
            throw new Error('The target deformer is singular.');
        }
        return [{ native, points, rotation, kind: object.kind }];
      })
      .flat();
  });
  for (const { native, points, rotation, kind } of conversions) {
    if (kind === 'artpath') {
      e.field(native, 'positions', e.copyOwned(g.field(native, 'positions')!));
      g.list(native, 'positions').forEach((p, i) => {
        const point = g.field(g.field(p, 'curvePointPosition'), 'point')!;
        e.value(point, 'x', Math.fround(points[i * 2]));
        e.value(point, 'y', Math.fround(points[i * 2 + 1]));
      });
    } else if (points.length)
      e.field(native, 'positions', e.array('float-array', 'positions', points));
    if (rotation)
      for (const [key, value] of Object.entries(rotation))
        e.value(
          native,
          key === 'x' ? 'originX' : key === 'y' ? 'originY' : key,
          Math.fround(value),
        );
    e.field(native, 'coordType', e.coord());
  }
  for (const guid of guids) {
    const object = objects.get(guid)!,
      source = e.source(guid);
    if (values.deformerGuid !== undefined && (object.deformerGuid || ROOT_DEFORMER) !== target)
      e.field(source, 'targetDeformerGuid', e.guid('CDeformerGuid', 'targetDeformerGuid', target));
    const part = values.parentGuid || document.model.rootPartGuid!;
    if (values.parentGuid !== undefined && object.parentGuid !== part) {
      const previous = g.field(e.source(object.parentGuid!), '_childGuids')!;
      const entry = children(previous).find((n) => g.guid(n) === guid);
      if (!entry) throw new Error('The previous part is missing this object.');
      previous.removeChild(entry);
      previous.setAttribute('count', String(children(previous).length));
      e.append(
        g.field(e.source(part), '_childGuids')!,
        e.guid(g.field(source, 'guid')!.tagName, '', guid),
      );
      e.field(source, 'parentGuid', e.guid('CPartGuid', 'parentGuid', part));
    }
  }
}
