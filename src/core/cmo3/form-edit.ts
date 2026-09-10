import type { FormClipboard, FormEdit } from '../../shared/form-edit';
import type { SourceForm, SourceScene, SourceMesh } from '../../shared/scene';
import type { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { editFormScene, formNodes } from '../model/form-edit';
import { locked } from '../model/selection';
import { editOriginalForms } from './original-forms';

/** Write changed native fields only; keyform GUIDs, bindings and topology stay intact. */
export function writeFormScene(
  document: Cmo3Document,
  before: SourceScene,
  after: SourceScene,
): string[] {
  const e = new XmlEdit(document.graph),
    g = e.g;
  const oldNodes = new Map(formNodes(before).map((n) => [n.guid, n]));
  const changed: string[] = [];
  const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  for (const node of formNodes(after)) {
    const old = oldNodes.get(node.guid)!;
    if (!different(old, node)) continue;
    changed.push(node.guid);
    const source = e.source(node.guid);
    if (node.kind === 'warp' || node.kind === 'rotation') {
      for (const [key, field] of [
        ['columns', 'col'],
        ['rows', 'row'],
        ['baseAngle', 'baseAngle'],
      ] as const)
        if (node[key] !== (old as typeof node)[key]) e.value(source, field, node[key]);
    }
    if (node.kind === 'mesh' && node.culling !== (old as SourceMesh).culling)
      e.field(source, 'culling', e.scalar('b', 'culling', node.culling));
    const nativeForms = new Map(
      g.list(source, 'keyforms').map((f) => [g.guid(g.field(f, 'guid')), f]),
    );
    for (const form of node.forms) {
      const previous = old.forms.find((f) => f.guid === form.guid)!,
        native = nativeForms.get(form.guid);
      if (!different(previous, form)) continue;
      if (!native) throw new Error(`${node.id}: Native keyform is missing.`);
      let appearance = native;
      if (node.kind !== 'part') {
        const tag = node.kind === 'mesh' ? 'ACDrawableForm' : 'ACDeformerForm';
        while (appearance.tagName !== tag) {
          const parent = g.field(appearance, 'super');
          if (!parent) throw new Error(`Missing native form base: ${tag}`);
          appearance = parent;
        }
      }
      const path = form.pathPoints;
      if (path) {
        if (different(previous.positions, form.positions) || different(previous.pathPoints, path)) {
          const points = g.list(native, 'positions');
          if (points.length !== path.length) throw new Error('ArtPath point counts must match.');
          points.forEach((p, i) => {
            const curve = g.field(p, 'curvePointPosition')!,
              point = g.field(curve, 'point')!;
            e.value(point, 'x', Math.fround(form.positions[i * 2]));
            e.value(point, 'y', Math.fround(form.positions[i * 2 + 1]));
            for (const [key, field] of [
              ['start', 'startVelocity'],
              ['end', 'endVelocity'],
            ] as const) {
              const vector = g.field(curve, field)!;
              e.value(vector, 'x', Math.fround(path[i][key][0]));
              e.value(vector, 'y', Math.fround(path[i][key][1]));
            }
            e.value(p, 'width', Math.fround(path[i].width));
            e.value(p, 'opacity', Math.fround(path[i].opacity));
            e.value(p, 'isCorner', path[i].corner);
            ['colorRed', 'colorGreen', 'colorBlue', 'colorAlpha'].forEach((key, j) =>
              e.value(p, key, Math.fround(path[i].color[j])),
            );
          });
        }
      } else if (different(previous.positions, form.positions))
        e.field(native, 'positions', e.array('float-array', 'positions', form.positions));
      if (form.rotation && previous.rotation)
        for (const [key, value] of Object.entries(form.rotation)) {
          if (value === previous.rotation[key as keyof NonNullable<SourceForm['rotation']>])
            continue;
          const field =
            { x: 'originX', y: 'originY', reflectX: 'isReflectX', reflectY: 'isReflectY' }[key] ||
            key;
          e.value(native, field, typeof value === 'number' ? Math.fround(value) : value);
        }
      for (const key of ['opacity', 'drawOrder'] as const)
        if (form[key] !== previous[key]) {
          const value =
            key === 'drawOrder'
              ? Math.trunc(form[key] + 0.001 * Math.sign(form[key]))
              : Math.fround(form[key]);
          if (appearance.hasAttribute(key)) e.value(appearance, key, value);
          else e.field(appearance, key, e.scalar(key === 'drawOrder' ? 'i' : 'f', key, value));
        }
      for (const [key, field] of [
        ['multiply', 'multiplyColor'],
        ['screen', 'screenColor'],
      ] as const)
        if (different(previous[key], form[key])) {
          const [red, green, blue, alpha] = form[key].map(Math.fround);
          e.field(appearance, field, e.node('CFloatColor', field, { red, green, blue, alpha }));
          e.imports(['com.live2d.type.CFloatColor']);
          if (g.number(g.source, 'targetVersionNo') < 4020000)
            e.value(g.source, 'targetVersionNo', 4020000);
        }
    }
  }
  return changed;
}

export function editNativeForms(
  document: Cmo3Document,
  scene: SourceScene,
  edit: FormEdit,
  values: Record<string, number>,
  clipboard: FormClipboard,
) {
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  const guids =
    edit.action === 'paste'
      ? edit.targets.map((t) => t.targetGuid)
      : edit.action === 'deleteOriginals'
        ? scene.deformers.map((d) => d.guid)
        : edit.guids;
  for (const id of guids)
    if (!objects.has(id) || (edit.action !== 'deleteOriginals' && locked(objects, id)))
      throw new Error('Select unlocked objects.');
  if (['revert', 'updateOriginal', 'deleteOriginals'].includes(edit.action))
    return editOriginalForms(document, scene, edit, values);
  const after = editFormScene(scene, edit, values, clipboard);
  const previous = new Map(formNodes(scene).map((node) => [node.guid, node]));
  // Reflection and expansion also touch descendants. Validate the complete draft before writing.
  const changed = formNodes(after).filter(
    (node) => JSON.stringify(node) !== JSON.stringify(previous.get(node.guid)),
  );
  for (const node of changed) {
    if (locked(objects, node.guid))
      throw new Error(`${node.id}: A child affected by this operation is locked.`);
    if (
      (edit.action === 'expandWarp' ||
        edit.action === 'flip' ||
        (edit.action === 'scale' && !edit.currentOnly)) &&
      document.graph.list(
        document.graph.field(
          new XmlEdit(document.graph).source(node.guid),
          'keyformMorphTargetSet',
        ),
        '_morphTargets',
      ).length
    )
      throw new Error(
        `${node.id}: Editing all forms of objects with blend-shape targets is not supported yet.`,
      );
  }
  return writeFormScene(document, scene, after);
}
