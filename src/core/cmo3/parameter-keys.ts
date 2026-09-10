import type { Element } from '@xmldom/xmldom';
import type { ParameterKeyEdit } from '../../shared/parameters';
import type { SourceNode } from '../../shared/scene';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { children } from './xml';
import { readSourceScene } from './scene';
import { bindingWeights, interpolateForm } from '../model/evaluate';
import { locked } from '../model/selection';
import { bindControllers } from './controller';

function sampleForm(
  e: XmlEdit,
  source: Element,
  node: SourceNode,
  values: Record<string, number>,
  forms: Map<string, Element>,
) {
  const result = interpolateForm(node, values);
  const weights = node.bindings.map(
    (b) => new Map(bindingWeights(b, values[b.parameterId] ?? b.keys[0])),
  );
  const contributions = node.forms
    .map((f) => ({
      form: forms.get(f.guid)!,
      weight: f.keys.reduce((w, k, i) => w * (weights[i].get(k) || 0), 1),
    }))
    .filter((f) => f.weight > 0);
  if (!contributions.length || contributions.some((c) => !c.form))
    throw new Error('Keyform grid is incomplete.');
  const basis = contributions.reduce((a, b) => (a.weight >= b.weight ? a : b)).form;
  const copy = e.copyOwned(basis),
    guid = e.guid('CFormGuid', 'guid');
  e.field(copy, 'guid', guid);
  const write = (name: string, value: number) => {
    if (e.g.field(copy, name) || copy.hasAttribute(name)) e.value(copy, name, Math.fround(value));
  };
  write('opacity', result.opacity);
  write('intensity', result.opacity);
  write('drawOrder', result.drawOrder);
  for (const name of ['multiplyColor', 'screenColor'] as const)
    if (e.g.field(copy, name)) {
      const color = result[name === 'multiplyColor' ? 'multiply' : 'screen'];
      e.field(
        copy,
        name,
        e.node('CFloatColor', name, {
          red: color[0],
          green: color[1],
          blue: color[2],
          alpha: color[3],
        }),
      );
    }
  if (source.tagName === 'CArtPathSource') {
    const points = e.g.list(copy, 'positions');
    points.forEach((p, i) => {
      const originals = contributions.map((c) => ({
        point: e.g.list(c.form, 'positions')[i],
        weight: c.weight,
      }));
      for (const name of ['width', 'opacity', 'colorRed', 'colorGreen', 'colorBlue', 'colorAlpha'])
        e.value(
          p,
          name,
          Math.fround(originals.reduce((n, c) => n + e.g.number(c.point, name) * c.weight, 0)),
        );
      for (const name of ['point', 'startVelocity', 'endVelocity']) {
        const vector = e.g.field(e.g.field(p, 'curvePointPosition'), name)!;
        for (const axis of ['x', 'y'])
          e.value(
            vector,
            axis,
            Math.fround(
              originals.reduce(
                (n, c) =>
                  n +
                  e.g.number(e.g.field(e.g.field(c.point, 'curvePointPosition'), name), axis) *
                    c.weight,
                0,
              ),
            ),
          );
      }
    });
  } else if (e.g.field(copy, 'positions'))
    e.field(copy, 'positions', e.array('float-array', 'positions', result.positions));
  if (result.rotation) {
    for (const [field, value] of Object.entries({
      originX: result.rotation.x,
      originY: result.rotation.y,
      angle: result.rotation.angle,
      scale: result.rotation.scale,
    }))
      write(field, value);
    e.value(copy, 'isReflectX', result.rotation.reflectX);
    e.value(copy, 'isReflectY', result.rotation.reflectY);
  }
  return { form: copy, guid };
}

/** Rebuild affected axes as a Cartesian grid, sampling newly inserted keyforms. */
export function editParameterKeys(
  document: Cmo3Document,
  guids: string[],
  edits: ParameterKeyEdit[],
  values: Record<string, number>,
) {
  const e = new XmlEdit(document.graph),
    g = e.g;
  const scene = readSourceScene(document).scene;
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  const changes = new Map<string, ParameterKeyEdit['keys']>();
  for (const edit of edits) {
    const parameter = document.model.parameters.find((p) => p.guid === edit.parameterGuid);
    if (!parameter || parameter.type !== 'NORMAL') throw new Error('Select a normal parameter.');
    if (changes.has(parameter.id)) throw new Error('Parameter edit is duplicated.');
    const keys = edit.keys
      .map((k) => ({ ...k, value: Math.fround(k.value) }))
      .sort((a, b) => a.value - b.value);
    if (
      keys.some(
        (k, i) =>
          k.value < parameter.min ||
          k.value > parameter.max ||
          (i > 0 && k.value - keys[i - 1].value < 0.0001),
      )
    )
      throw new Error('Keys must be distinct and inside the parameter range.');
    const existing = guids.flatMap((id) => parameter.bindings[id] || []);
    if (
      keys.some(
        (k) => k.previous !== undefined && !existing.some((v) => Math.abs(v - k.previous!) < 1e-5),
      )
    )
      throw new Error('The original key changed. Refresh the key editor.');
    changes.set(parameter.id, keys);
  }
  const changedMeshes: string[] = [];
  for (const guid of new Set(guids)) {
    const node = [...scene.parts, ...scene.deformers, ...scene.meshes, ...(scene.glues || [])].find(
      (n) => n.guid === guid,
    );
    if (!node || locked(objects, guid)) throw new Error('Select unlocked objects for key editing.');
    const source = e.source(guid),
      oldGrid = g.field(source, 'keyformGridSource')!;
    if (g.list(g.field(source, 'keyformMorphTargetSet'), '_morphTargets').length)
      throw new Error('Blend shape key editing is not supported yet.');
    const oldBindings = g.list(oldGrid, 'keyformBindings');
    const axes = node.bindings.map((b, i) => ({
      id: b.parameterId,
      keys: changes.get(b.parameterId) || b.keys.map((value) => ({ value, previous: value })),
      original: oldBindings[i],
    }));
    for (const [id, keys] of changes)
      if (!axes.some((a) => a.id === id) && keys.length)
        axes.push({ id, keys, original: undefined! });
    if (
      ![...changes].some(
        ([id, keys]) => node.bindings.some((b) => b.parameterId === id) || keys.length,
      )
    )
      continue;
    for (const axis of axes) {
      if (
        axis.original &&
        !['LINEAR', 'CONSTRAINED_LINEAR'].includes(
          g.field(axis.original, 'extendedInterpolationType')?.getAttribute('v') || 'LINEAR',
        )
      )
        throw new Error('Extended interpolation key editing is not supported yet.');
    }
    const remaining = axes.filter((a) => a.keys.length);
    const count = remaining.reduce((n, a) => n * a.keys.length, 1);
    if (count > 4096) throw new Error('This edit would exceed 4096 keyforms per object.');
    const oldForms = g.list(source, 'keyforms'),
      forms = new Map(oldForms.map((f) => [g.guid(g.field(f, 'guid'))!, f]));
    if (!node.forms.length || node.forms.some((f) => !forms.has(f.guid)))
      throw new Error('Object has no editable keyforms.');
    const grid = e.identified(e.node('KeyformGridSource', 'keyformGridSource'));
    const bindings = remaining.map((axis) => {
      const parameter = document.model.parameters.find((p) => p.id === axis.id)!;
      const binding = axis.original
        ? e.copyOwned(axis.original)
        : e.node('KeyformBindingSource', undefined, {}, [
            e.node('InterpolationType', 'interpolationType', { v: 'LINEAR' }),
            e.node('ExtendedInterpolationType', 'extendedInterpolationType', { v: 'LINEAR' }),
            e.scalar('i', 'insertPointCount', 1),
            e.scalar('f', 'extendedInterpolationScale', 1),
            e.scalar('s', 'description', parameter.id),
          ]);
      e.identified(binding);
      e.field(binding, '_gridSource', e.ref(grid, '_gridSource'));
      e.field(binding, 'parameterGuid', e.guid('CParameterGuid', 'parameterGuid', parameter.guid));
      e.field(
        binding,
        'keys',
        e.list(
          'array_list',
          'keys',
          axis.keys.map((k) => e.node('f', undefined, {}, String(k.value))),
        ),
      );
      return binding;
    });
    const entries: Element[] = [],
      newForms: Element[] = [],
      used = new Set<string>();
    for (let cell = 0; cell < count; cell++) {
      let index = cell;
      const indices = remaining.map((axis) => {
        const i = index % axis.keys.length;
        index = Math.floor(index / axis.keys.length);
        return i;
      });
      const sampled = { ...values };
      remaining.forEach((axis, i) => {
        const key = axis.keys[indices[i]];
        sampled[axis.id] = key.previous ?? key.value;
      });
      const exact = node.forms.find(
        (f) =>
          !used.has(f.guid) &&
          node.bindings.every(
            (b, i) => Math.abs(b.keys[f.keys[i]] - sampled[b.parameterId]) < 1e-6,
          ),
      );
      let formGuid: Element;
      if (exact) {
        used.add(exact.guid);
        formGuid = g.field(forms.get(exact.guid)!, 'guid')!;
      } else {
        const sample = sampleForm(e, source, node, sampled, forms);
        newForms.push(sample.form);
        formGuid = sample.guid;
      }
      entries.push(
        e.node('KeyformOnGrid', undefined, {}, [
          e.node('KeyformGridAccessKey', 'accessKey', {}, [
            e.list(
              'array_list',
              '_keyOnParameterList',
              indices.map((keyIndex, i) =>
                e.node('KeyOnParameter', undefined, {}, [
                  e.ref(bindings[i], 'binding'),
                  e.scalar('i', 'keyIndex', keyIndex),
                ]),
              ),
            ),
          ]),
          e.ref(formGuid, 'keyformGuid'),
        ]),
      );
    }
    grid.appendChild(e.list('array_list', 'keyformsOnGrid', entries));
    grid.appendChild(e.list('array_list', 'keyformBindings', bindings));
    e.field(source, 'keyformGridSource', grid);
    // Preserve native forms which extensions can still reference; the grid decides which are active.
    e.field(source, 'keyforms', e.list('carray_list', 'keyforms', [...oldForms, ...newForms]));
    if (scene.meshes.find((m) => m.guid === guid)?.controllers?.length) changedMeshes.push(guid);
  }
  // A freshly imported PSD has no bindings to register these native XML types.
  e.imports([
    'com.live2d.cubism.doc.model.interpolator.KeyformGridSource',
    'com.live2d.cubism.doc.model.interpolator.KeyformBindingSource',
    'com.live2d.cubism.doc.model.interpolator.KeyformOnGrid',
    'com.live2d.cubism.doc.model.interpolator.KeyformGridAccessKey',
    'com.live2d.cubism.doc.model.interpolator.KeyOnParameter',
    'com.live2d.cubism.doc.model.interpolator.InterpolationType',
    'com.live2d.cubism.doc.model.interpolator.extendedInterpolation.ExtendedInterpolationType',
  ]);
  document.graph.normalize();
  document.refreshModel();
  for (const guid of changedMeshes) {
    bindControllers(document, guid);
  }
  document.graph.normalize();
  return document.xml();
}
