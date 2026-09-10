import type { SourceDeformer, SourceForm, SourceScene } from '../../shared/scene';
import { ModelEvaluator, type Point, type Transform } from './evaluate';
import { keyformAt } from './selection';

interface Pose {
  values: Record<string, number>;
  before: Transform;
}

/** Reposition a rotation origin while keeping child keyforms in canvas space.
 * Cache the original parent fields for the lifetime of a viewport drag. */
export class RotationOriginEdit {
  private readonly node: SourceDeformer;
  private readonly form: SourceForm;
  private readonly parentScene: SourceScene;
  private readonly poses = new Map<string, Pose>();
  private readonly formPoses = new Map<SourceForm, Pose>();

  constructor(
    private readonly scene: SourceScene,
    guid: string,
    values: Record<string, number>,
  ) {
    const node = scene.deformers.find((d) => d.guid === guid);
    if (node?.kind !== 'rotation') throw new Error('Select a rotation deformer.');
    const parameters = {
      ...Object.fromEntries(scene.parameters.map((p) => [p.id, p.default])),
      ...values,
    };
    const form = keyformAt(node, parameters);
    if (!form?.rotation)
      throw new Error('Align parameters with existing key values before editing.');
    this.node = node;
    this.form = form;

    // Child positions are unnecessary for evaluating a rotation's affine field.
    // Only its ancestor chain is needed, even on a model with many keyed meshes.
    const nodes = new Map(scene.deformers.map((d) => [d.guid, d])),
      chain: SourceDeformer[] = [],
      seen = new Set<string>();
    let current: SourceDeformer | undefined = node;
    while (current) {
      if (seen.has(current.guid)) throw new Error('Cyclic deformer hierarchy.');
      seen.add(current.guid);
      chain.push(current);
      current = nodes.get(current.deformerGuid!);
    }
    const root = scene.parts.find((p) => p.guid === scene.rootPartGuid)!;
    this.parentScene = {
      ...scene,
      parts: [{ ...root, children: [] }],
      deformers: chain,
      meshes: [],
      glues: [],
    };
    const parameterIds = [...new Set(chain.flatMap((d) => d.bindings.map((b) => b.parameterId)))];
    const evaluator = new ModelEvaluator(this.parentScene);
    for (const child of [...scene.deformers, ...scene.meshes]) {
      if (child.deformerGuid !== guid) continue;
      for (const childForm of child.forms) {
        const poseValues = { ...parameters };
        child.bindings.forEach((binding, i) => {
          poseValues[binding.parameterId] = binding.keys[childForm.keys[i]];
        });
        const key = JSON.stringify(parameterIds.map((id) => poseValues[id]));
        let pose = this.poses.get(key);
        if (!pose) {
          evaluator.evaluate(poseValues);
          pose = {
            values: poseValues,
            before: evaluator.evaluatedDeformers.find((d) => d.source.guid === guid)!.transform,
          };
          this.poses.set(key, pose);
        }
        this.formPoses.set(childForm, pose);
      }
    }
  }

  apply(value: { x?: number; y?: number }): SourceScene {
    const rotation = this.form.rotation!,
      x =
        value.x === undefined || Math.fround(value.x) === Math.fround(rotation.x)
          ? rotation.x
          : Math.fround(value.x),
      y =
        value.y === undefined || Math.fround(value.y) === Math.fround(rotation.y)
          ? rotation.y
          : Math.fround(value.y);
    if (x === rotation.x && y === rotation.y) return this.scene;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid rotation origin.');
    const node = {
      ...this.node,
      forms: this.node.forms.map((form) =>
        form === this.form ? { ...form, rotation: { ...rotation, x, y } } : form,
      ),
    };
    const evaluator = new ModelEvaluator({
      ...this.parentScene,
      deformers: this.parentScene.deformers.map((d) => (d === this.node ? node : d)),
    });
    const conversions = new Map<Pose, { transform: Transform; angle: number } | null>();
    for (const pose of this.poses.values()) {
      evaluator.evaluate(pose.values);
      const after = evaluator.evaluatedDeformers.find(
        (d) => d.source.guid === node.guid,
      )!.transform;
      const oldOrigin = pose.before(0, 0),
        oldX = pose.before(1, 0),
        oldY = pose.before(0, 1),
        origin = after(0, 0),
        axisX = after(1, 0),
        axisY = after(0, 1);
      const newBasis = [...origin, ...axisX, ...axisY];
      if ([...oldOrigin, ...oldX, ...oldY].every((v, i) => v === newBasis[i])) {
        conversions.set(pose, null);
        continue;
      }
      const a = axisX[0] - origin[0],
        b = axisY[0] - origin[0],
        c = axisX[1] - origin[1],
        d = axisY[1] - origin[1],
        det = a * d - b * c;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
        throw new Error('The rotation deformer cannot preserve its children at this pose.');
      // Rotation fields remain affine inside a warped parent. Invert once per
      // keyed parent pose instead of iterating an inverse for every vertex.
      const angle = Math.atan2(oldOrigin[0] - oldY[0], oldY[1] - oldOrigin[1]) - Math.atan2(-b, d);
      conversions.set(pose, {
        transform: (px, py) => {
          const point = pose.before(px, py),
            dx = point[0] - origin[0],
            dy = point[1] - origin[1];
          return [(d * dx - b * dy) / det, (a * dy - c * dx) / det];
        },
        angle: (Math.atan2(Math.sin(angle), Math.cos(angle)) * 180) / Math.PI,
      });
    }
    const convertForm = (form: SourceForm): SourceForm => {
      const conversion = conversions.get(this.formPoses.get(form)!);
      if (!conversion) return form;
      const { transform } = conversion;
      const point = (px: number, py: number): Point => {
        const p = transform(px, py);
        if (!p.every(Number.isFinite)) throw new Error('Invalid child coordinates.');
        return [Math.fround(p[0]), Math.fround(p[1])];
      };
      const positions = form.positions.flatMap((v, i, old) => (i % 2 ? [] : point(v, old[i + 1])));
      const next: SourceForm = { ...form, positions };
      if (form.rotation) {
        const r = form.rotation,
          p = point(r.x, r.y);
        next.rotation = {
          ...r,
          x: p[0],
          y: p[1],
          angle: Math.fround(r.angle + conversion.angle),
        };
      }
      if (form.pathPoints)
        next.pathPoints = form.pathPoints.map((p, i) => {
          const anchor = transform(form.positions[i * 2], form.positions[i * 2 + 1]);
          const vector = ([vx, vy]: Point): Point => {
            const end = transform(form.positions[i * 2] + vx, form.positions[i * 2 + 1] + vy);
            return [Math.fround(end[0] - anchor[0]), Math.fround(end[1] - anchor[1])];
          };
          return { ...p, start: vector(p.start), end: vector(p.end) };
        });
      return next;
    };
    const convert = <T extends SourceDeformer | SourceScene['meshes'][number]>(child: T): T =>
      child.deformerGuid === node.guid ? { ...child, forms: child.forms.map(convertForm) } : child;
    return {
      ...this.scene,
      deformers: this.scene.deformers.map((d) => (d === this.node ? node : convert(d))),
      meshes: this.scene.meshes.map(convert),
    };
  }
}
