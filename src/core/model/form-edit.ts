import type {
  CopiedForm,
  FormClipboard,
  FormEdit,
  FormKind,
  PasteOptions,
  PasteTarget,
} from '../../shared/form-edit';
import { defaultPasteSettings } from '../../shared/form-edit';
import type {
  SourceDeformer,
  SourceForm,
  SourceMesh,
  SourceNode,
  SourceScene,
} from '../../shared/scene';
import type { ModelObject, PointSelection } from '../../shared/types';
import {
  interpolateForm,
  ModelEvaluator,
  type Point,
  type Transform,
  type EvaluatedMesh,
  type EvaluatedDeformer,
} from './evaluate';
import { boundsOf, inversePoint, keyformAt } from './selection';
import { bezierControls } from './bezier';
import { expandedWarpPositions } from './warp-expansion';

export const formNodes = (scene: SourceScene) => [
  ...scene.parts,
  ...scene.deformers,
  ...scene.meshes,
];
export const formKind = (node: SourceNode): FormKind =>
  node.kind === 'mesh' && (node as SourceMesh).path ? 'artpath' : (node.kind as FormKind);
const identity: Transform = (x, y) => [x, y];
export function formDepth(node: SourceNode, nodes: Map<string, SourceNode>): number {
  return node.deformerGuid && nodes.has(node.deformerGuid)
    ? 1 + formDepth(nodes.get(node.deformerGuid)!, nodes)
    : 0;
}
export function descendant(
  node: SourceNode,
  guid: string,
  nodes: Map<string, SourceNode>,
): boolean {
  return (
    node.guid === guid ||
    !!(
      node.deformerGuid &&
      nodes.has(node.deformerGuid) &&
      descendant(nodes.get(node.deformerGuid)!, guid, nodes)
    )
  );
}
function currentForm(node: SourceNode, values: Record<string, number>) {
  const form = keyformAt(node, values);
  if (!form?.guid)
    throw new Error(`${node.id}: Align the parameters with an existing keyform before editing.`);
  return form;
}
function evaluate(scene: SourceScene, values: Record<string, number>) {
  const evaluator = new ModelEvaluator(scene);
  const meshes = evaluator.evaluate(values);
  return {
    evaluator,
    nodes: new Map<string, EvaluatedMesh | EvaluatedDeformer>([
      ...meshes.map((m) => [m.source.guid, m] as const),
      ...evaluator.evaluatedDeformers.map((d) => [d.source.guid, d] as const),
    ]),
  };
}
function mapGeometry(form: SourceForm, transform: Transform) {
  const old = form.positions;
  const next = old.flatMap((_, i) => (i % 2 ? [] : transform(old[i], old[i + 1])));
  // Spline handles are vectors, so transform their endpoints relative to each anchor.
  form.pathPoints?.forEach((p, i) => {
    for (const key of ['start', 'end'] as const) {
      const point = transform(old[i * 2] + p[key][0], old[i * 2 + 1] + p[key][1]);
      p[key] = [point[0] - next[i * 2], point[1] - next[i * 2 + 1]];
    }
  });
  form.positions = next;
  if (form.rotation)
    [form.rotation.x, form.rotation.y] = transform(form.rotation.x, form.rotation.y);
}
function parentScale(
  node: SourceNode,
  nodes: Map<string, SourceNode>,
  values: Record<string, number>,
): number {
  const parent = nodes.get(node.deformerGuid!);
  return parent
    ? parentScale(parent, nodes, values) *
        (parent.kind === 'rotation' ? interpolateForm(parent, values).rotation!.scale : 1)
    : 1;
}
function parentAngle(
  node: SourceNode,
  origin: Point,
  transform: Transform,
  nodes: Map<string, SourceNode>,
) {
  if (!nodes.has(node.deformerGuid!)) return 0;
  const step = nodes.get(node.deformerGuid!)!.kind === 'rotation' ? -10 : -0.1;
  const a = transform(...origin),
    b = transform(origin[0], origin[1] + step);
  return (Math.atan2(-(b[0] - a[0]) / step, (b[1] - a[1]) / step) * 180) / Math.PI;
}
export function canvasForm(
  scene: SourceScene,
  node: SourceNode,
  values: Record<string, number>,
  calculated?: Map<string, EvaluatedMesh | EvaluatedDeformer>,
): SourceForm {
  const form = interpolateForm(node, values);
  const evaluated = (calculated || evaluate(scene, values).nodes).get(node.guid);
  mapGeometry(form, evaluated?.toCanvas || identity);
  if (form.rotation && evaluated && 'transform' in evaluated) {
    const a = evaluated.transform(0, 0),
      b = evaluated.transform(1, 0);
    const sign = form.rotation.reflectX ? -1 : 1;
    form.rotation.angle = (Math.atan2((b[1] - a[1]) * sign, (b[0] - a[0]) * sign) * 180) / Math.PI;
    form.rotation.scale = Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return form;
}
export function copyForms(
  scene: SourceScene,
  objects: ModelObject[],
  guids: string[],
  values: Record<string, number>,
  points: PointSelection,
): CopiedForm[] {
  const nodes = new Map(formNodes(scene).map((n) => [n.guid, n]));
  const metadata = new Map(objects.map((o) => [o.guid, o]));
  const calculated = evaluate(scene, values).nodes;
  const partial = Object.values(points).some((weights) =>
    Object.values(weights).some((weight) => weight > 0),
  );
  return [...new Set(guids)].map((guid) => {
    const node = nodes.get(guid);
    if (!node || node.guid === scene.rootPartGuid)
      throw new Error('Select objects with editable forms.');
    const form = canvasForm(scene, node, values, calculated);
    return {
      guid,
      id: node.id,
      name: metadata.get(guid)?.name || node.id,
      kind: formKind(node),
      form,
      weights: Array.from(
        { length: node.kind === 'rotation' ? 1 : form.positions.length / 2 },
        (_, i) => (partial ? points[guid]?.[i] || 0 : 1),
      ),
      ...(node.kind === 'warp'
        ? { columns: (node as SourceDeformer).columns, rows: (node as SourceDeformer).rows }
        : {}),
    };
  });
}
/** Prefer GUID, then unique ID/name. One copied form can be applied to multiple compatible objects. */
export function suggestedPasteTargets(
  clipboard: FormClipboard,
  scene: SourceScene,
  objects: ModelObject[],
  guids: string[],
): PasteTarget[] {
  const nodes = new Map(formNodes(scene).map((n) => [n.guid, n]));
  return guids.flatMap((guid) => {
    const node = nodes.get(guid);
    if (!node) return [];
    const compatible = clipboard.items.filter((item) => item.kind === formKind(node));
    const unique = (match: (item: CopiedForm) => boolean) => {
      const items = compatible.filter(match);
      return items.length === 1 ? items[0] : undefined;
    };
    const source =
      unique((item) => item.guid === guid) ||
      unique((item) => item.id === node.id) ||
      unique((item) => item.name === objects.find((o) => o.guid === guid)?.name) ||
      (clipboard.items.length === 1 ? compatible[0] : undefined);
    return source ? [{ sourceGuid: source.guid, targetGuid: guid }] : [];
  });
}

function paste(
  scene: SourceScene,
  edit: Extract<FormEdit, { action: 'paste' }>,
  values: Record<string, number>,
  clipboard: FormClipboard,
) {
  if (edit.clipboardSerial !== clipboard.serial)
    throw new Error('The copied forms changed. Open Paste Form again.');
  if (edit.weight === 0) return;
  const nodes = new Map(formNodes(scene).map((n) => [n.guid, n]));
  if (new Set(edit.targets.map((t) => t.targetGuid)).size !== edit.targets.length)
    throw new Error('Each paste target must be assigned once.');
  const pairs = edit.targets
    .map((pair) => {
      const source = clipboard.items.find((c) => c.guid === pair.sourceGuid),
        target = nodes.get(pair.targetGuid);
      if (!source || !target || source.kind !== formKind(target))
        throw new Error('Paste requires objects of the same type.');
      return {
        source,
        target,
        form: currentForm(target, values),
        options: (edit.settings || defaultPasteSettings())[source.kind],
      };
    })
    .sort((a, b) => formDepth(a.target, nodes) - formDepth(b.target, nodes));
  for (const { source, target, form, options } of pairs) {
    const next = structuredClone(source.form),
      props = new Set(options.properties);
    if (
      form.pathPoints &&
      next.pathPoints &&
      next.pathPoints.length !== form.pathPoints.length &&
      options.properties.some((p) => p.startsWith('path'))
    )
      throw new Error(`${target.id}: ArtPath control-point counts differ.`);
    if (props.has('vertices')) {
      if (
        next.positions.length !== form.positions.length ||
        (target.kind === 'warp' &&
          (source.columns !== (target as SourceDeformer).columns ||
            source.rows !== (target as SourceDeformer).rows))
      )
        throw new Error(
          `${target.id}: Vertex counts or warp divisions differ. Disable Vertices Info in Paste Form Special to paste appearance only.`,
        );
      const center =
        options.center === 'canvas'
          ? scene.canvas[options.mirror === 'horizontal' ? 'width' : 'height'] / 2
          : options.center;
      if (options.mirror !== 'none')
        mapGeometry(next, (x, y) =>
          options.mirror === 'horizontal' ? [2 * center - x, y] : [x, 2 * center - y],
        );
      // Re-evaluate after each parent paste so children stay at their copied canvas positions.
      const parent = evaluate(scene, values).nodes.get(target.guid)?.toCanvas || identity;
      const old = [...next.positions];
      next.positions = old.flatMap((_, i) =>
        i % 2
          ? []
          : inversePoint(parent, [old[i], old[i + 1]], [form.positions[i], form.positions[i + 1]]),
      );
      next.pathPoints?.forEach((point, i) => {
        for (const key of ['start', 'end'] as const) {
          const p = inversePoint(
            parent,
            [old[i * 2] + point[key][0], old[i * 2 + 1] + point[key][1]],
            [
              next.positions[i * 2] + form.pathPoints![i][key][0],
              next.positions[i * 2 + 1] + form.pathPoints![i][key][1],
            ],
          );
          point[key] = [p[0] - next.positions[i * 2], p[1] - next.positions[i * 2 + 1]];
        }
      });
      if (next.rotation && form.rotation)
        [next.rotation.x, next.rotation.y] = inversePoint(
          parent,
          [next.rotation.x, next.rotation.y],
          [form.rotation.x, form.rotation.y],
        );
    }
    const mix = (a: number, b: number, weight = edit.weight) => a + (b - a) * weight;
    if (props.has('vertices'))
      form.positions = form.positions.map((v, i) =>
        mix(v, next.positions[i], edit.weight * source.weights[Math.floor(i / 2)]),
      );
    for (const key of ['opacity', 'drawOrder'] as const)
      if (props.has(key)) form[key] = mix(form[key], next[key]);
    for (const key of ['multiply', 'screen'] as const)
      if (props.has(key))
        form[key] = form[key].map((v, i) => mix(v, next[key][i])) as typeof form.multiply;
    if (next.rotation && form.rotation) {
      const parent = evaluate(scene, values).nodes.get(target.guid)?.toCanvas || identity;
      if (props.has('vertices')) {
        const w = edit.weight * source.weights[0];
        form.rotation.x = mix(form.rotation.x, next.rotation.x, w);
        form.rotation.y = mix(form.rotation.y, next.rotation.y, w);
      }
      if (props.has('angle')) {
        const angle =
          (options.reverseAngle ? -1 : 1) * next.rotation.angle -
          (target as SourceDeformer).baseAngle -
          parentAngle(target, [form.rotation.x, form.rotation.y], parent, nodes);
        form.rotation.angle = mix(form.rotation.angle, angle);
      }
      if (props.has('scale'))
        form.rotation.scale = mix(
          form.rotation.scale,
          next.rotation.scale / parentScale(target, nodes, values),
        );
    }
    if (form.pathPoints && next.pathPoints)
      form.pathPoints.forEach((p, i) => {
        const n = next.pathPoints![i],
          weight = edit.weight * source.weights[i];
        if (props.has('vertices'))
          for (const key of ['start', 'end'] as const)
            p[key] = p[key].map((v, j) => mix(v, n[key][j], weight)) as Point;
        if (props.has('pathWidth')) p.width = mix(p.width, n.width, weight);
        if (props.has('pathOpacity')) p.opacity = mix(p.opacity, n.opacity, weight);
        if (props.has('pathColor'))
          p.color = p.color.map((v, j) => mix(v, n.color[j], weight)) as typeof p.color;
        if (props.has('pathCorner') && weight >= 0.5) p.corner = n.corner;
      });
  }
}

/** A pure scene draft shared by the dialog preview and native commit. */
export function editFormScene(
  base: SourceScene,
  edit: FormEdit,
  values: Record<string, number>,
  clipboard: FormClipboard = { serial: 0, items: [] },
): SourceScene {
  const scene = structuredClone(base),
    all = formNodes(scene),
    nodes = new Map(all.map((n) => [n.guid, n]));
  if (edit.action === 'paste') {
    paste(scene, edit, values, clipboard);
    return scene;
  }
  if (
    edit.action === 'deleteOriginals' ||
    edit.action === 'updateOriginal' ||
    edit.action === 'revert'
  )
    throw new Error('This operation requires native original-shape data.');
  const selected = [...new Set(edit.guids)].map((id) => {
    const node = nodes.get(id);
    if (!node || node.kind === 'part') throw new Error('Select meshes or deformers.');
    return node;
  });
  if (edit.action === 'scale') {
    if (edit.factor === 1) return scene;
    for (const node of selected)
      for (const form of edit.currentOnly ? [currentForm(node, values)] : node.forms) {
        if (form.rotation) {
          form.rotation.scale *= edit.factor;
          continue;
        }
        const b = boundsOf(form.positions),
          center: Point =
            node.kind === 'warp' ? [0.5, 0.5] : [b.x + b.width / 2, b.y + b.height / 2];
        mapGeometry(form, (x, y) => [
          center[0] + (x - center[0]) * edit.factor,
          center[1] + (y - center[1]) * edit.factor,
        ]);
      }
  } else if (edit.action === 'flip') {
    if (!edit.horizontal && !edit.vertical) throw new Error('Choose a flip direction.');
    const roots = selected.filter(
      (n) => !selected.some((p) => p !== n && descendant(n, p.guid, nodes)),
    );
    const affected = all.filter((n) => roots.some((p) => descendant(n, p.guid, nodes)));
    const angle = (a: number, horizontal: boolean) =>
      horizontal ? -a : a > 0 ? 180 - a : -180 - a;
    for (const horizontal of [true, false])
      if (horizontal ? edit.horizontal : edit.vertical) {
        for (const root of roots) {
          const parent = nodes.get(root.deformerGuid!),
            center: Point =
              parent?.kind === 'rotation'
                ? [0, 0]
                : parent?.kind === 'warp'
                  ? [0.5, 0.5]
                  : [scene.canvas.width / 2, scene.canvas.height / 2];
          if (root.kind === 'rotation')
            (root as SourceDeformer).baseAngle = angle(
              (root as SourceDeformer).baseAngle,
              horizontal,
            );
          for (const form of root.forms) {
            if (!form.rotation || edit.flipRotationPosition)
              mapGeometry(form, (x, y) =>
                horizontal ? [center[0] * 2 - x, y] : [x, center[1] * 2 - y],
              );
            if (form.rotation) form.rotation.angle = angle(form.rotation.angle, horizontal);
          }
          for (const child of affected.filter(
            (n) => n !== root && descendant(n, root.guid, nodes),
          )) {
            if (child.kind === 'rotation') (child as SourceDeformer).baseAngle *= -1;
            for (const form of child.forms) {
              if (nodes.get(child.deformerGuid!)?.kind === 'rotation')
                mapGeometry(form, (x, y) => [-x, y]);
              if (form.rotation) form.rotation.angle *= -1;
            }
          }
        }
      }
    for (const node of affected) {
      if (node.kind === 'mesh' && !edit.keepCulling) (node as SourceMesh).culling = false;
      const axes = node.bindings
        .map((b, i) => (edit.parameterIds.includes(b.parameterId) ? i : -1))
        .filter((i) => i >= 0);
      if (axes.length) {
        const forms = structuredClone(node.forms);
        for (const form of node.forms) {
          const keys = form.keys.map((key, i) =>
            axes.includes(i) ? node.bindings[i].keys.length - 1 - key : key,
          );
          const source = forms.find((f) => f.keys.every((v, i) => v === keys[i]))!;
          Object.assign(form, source, { guid: form.guid, keys: form.keys });
        }
      }
    }
  } else if (edit.action === 'reshapeWarp') {
    if (edit.editLevel === 1) throw new Error('Bezier reshaping requires Edit Level 2 or 3.');
    for (const node of selected) {
      if (node.kind !== 'warp') throw new Error('Select warp deformers.');
      const warp = node as SourceDeformer,
        form = currentForm(node, values),
        info = warp.bezier?.find((b) => b.level === (edit.editLevel || 2));
      if (!info) throw new Error(`${node.id}: No Bezier handles at this edit level.`);
      const evaluated = evaluate(scene, values).nodes.get(node.guid)!;
      const controls = bezierControls(
        evaluated.positions,
        warp.columns,
        warp.rows,
        info.columns,
        info.rows,
      );
      const bernstein = (t: number) => [
        (1 - t) ** 3,
        3 * t * (1 - t) ** 2,
        3 * t * t * (1 - t),
        t ** 3,
      ];
      form.positions = form.positions.flatMap((_, i) => {
        if (i % 2) return [];
        const u = (((i / 2) % (warp.columns + 1)) / warp.columns) * info.columns,
          v = (Math.floor(i / 2 / (warp.columns + 1)) / warp.rows) * info.rows;
        const c = Math.min(info.columns - 1, Math.floor(u)),
          r = Math.min(info.rows - 1, Math.floor(v)),
          bx = bernstein(u - c),
          by = bernstein(v - r);
        const point: Point = [0, 0];
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < 4; x++) {
            const p = controls.points[(r * 3 + y) * controls.width + c * 3 + x];
            point[0] += p[0] * bx[x] * by[y];
            point[1] += p[1] * bx[x] * by[y];
          }
        return inversePoint(evaluated.toCanvas, point, [form.positions[i], form.positions[i + 1]]);
      });
    }
  } else if (edit.action === 'expandWarp') {
    for (const node of selected.sort((a, b) => formDepth(b, nodes) - formDepth(a, nodes))) {
      if (node.kind !== 'warp') throw new Error('Select warp deformers.');
      const warp = node as SourceDeformer,
        children = all.filter((n) => n.deformerGuid === node.guid);
      const points = children.flatMap((n) =>
        n.forms.flatMap((f) => (f.rotation ? [f.rotation.x, f.rotation.y] : f.positions)),
      );
      if (!points.length) continue;
      const bounds = boundsOf(points),
        c = warp.columns,
        r = warp.rows;
      const left = Math.max(0, -Math.floor(bounds.x * c + 1e-6)),
        top = Math.max(0, -Math.floor(bounds.y * r + 1e-6));
      const right = Math.max(0, Math.ceil((bounds.x + bounds.width - 1) * c - 1e-6)),
        bottom = Math.max(0, Math.ceil((bounds.y + bounds.height - 1) * r - 1e-6));
      const nc = c + left + right,
        nr = r + top + bottom;
      if (nc === c && nr === r) continue;
      if (nc > 32 || nr > 32)
        throw new Error(
          `${node.id}: Expansion would exceed 32 warp divisions. Move distant children closer first.`,
        );
      for (const form of node.forms) {
        form.positions = expandedWarpPositions(form.positions, c, r, left, right, top, bottom);
      }
      warp.columns = nc;
      warp.rows = nr;
      for (const child of children)
        for (const form of child.forms)
          mapGeometry(form, (x, y) => [(x * c + left) / nc, (y * r + top) / nr]);
    }
  }
  for (const node of all)
    for (const form of node.forms) {
      const numbers = [
        ...form.positions,
        ...(form.rotation
          ? [form.rotation.x, form.rotation.y, form.rotation.scale, form.rotation.angle]
          : []),
      ];
      if (numbers.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e9))
        throw new Error(
          `${node.id}: The resulting form is outside the supported coordinate range.`,
        );
    }
  return scene;
}
