import type { Element } from '@xmldom/xmldom';
import type { InspectedObject, ObjectProperties } from '../../shared/inspector';
import { keyformProperties } from '../../shared/inspector';
import { objectPropertiesSchema } from '../../shared/commands';
import type { Color, SourceScene } from '../../shared/scene';
import { interpolateForm, warpPoint } from '../model/evaluate';
import { keyformAt, locked } from '../model/selection';
import type { Cmo3Document } from './document';
import { XmlEdit, ROOT_DEFORMER } from './edit';
import { readSourceScene } from './scene';
import { reparentObjects } from './reparent';

const hex = (color: Color) =>
  '#' +
  color
    .slice(0, 3)
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase();

export function inspectObjects(
  document: Cmo3Document,
  scene: SourceScene,
  guids: string[],
  parameters: Record<string, number>,
): InspectedObject[] {
  if (!guids.length) return [];
  const g = document.graph;
  const sources = new Map(
    ['partSourceSet', 'drawableSourceSet', 'deformerSourceSet', 'affecterSourceSet']
      .flatMap((set) => g.sources(set))
      .map((source) => [g.guid(g.field(source, 'guid')), source]),
  );
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  const nodes = new Map(
    [...scene.parts, ...scene.meshes, ...scene.deformers, ...(scene.glues || [])].map((n) => [
      n.guid,
      n,
    ]),
  );
  return [...new Set(guids)].map((guid) => {
    const object = objects.get(guid);
    if (!object) throw new Error('Object not found.');
    const source = sources.get(guid)!,
      node = nodes.get(guid),
      kind = object.kind;
    const form = node && interpolateForm(node, parameters),
      keyform = node && keyformAt(node, parameters);
    const values: ObjectProperties = {
      name: object.name,
      id: object.id,
      parentGuid: object.parentGuid,
    };
    if (['mesh', 'artpath', 'rotation', 'warp'].includes(kind)) {
      values.deformerGuid = object.deformerGuid === ROOT_DEFORMER ? null : object.deformerGuid;
      if (form)
        Object.assign(values, {
          opacity: form.opacity,
          multiply: hex(form.multiply),
          screen: hex(form.screen),
        });
    }
    if (kind === 'mesh' || kind === 'artpath') {
      if (form) values.drawOrder = Math.trunc(form.drawOrder + 0.001 * Math.sign(form.drawOrder));
      values.clips = g.list(source, 'clipGuidList').map((n) => g.guid(n)!);
      values.inverted = g.text(source, 'invertClippingMask') === 'true';
    }
    if (kind === 'mesh') {
      const blend = g.field(source, 'colorComposition')?.getAttribute('v') || 'NORMAL';
      if (['NORMAL', 'ADD', 'MULTIPLY'].includes(blend))
        values.blend = blend.toLowerCase() as ObjectProperties['blend'];
      values.culling = g.text(source, 'culling') === 'true';
      if (g.field(source, 'userData')) values.userData = g.text(source, 'userData');
    }
    if (kind === 'part') {
      values.drawOrder = node?.forms[0]?.guid
        ? form!.drawOrder
        : g.number(source, 'defaultOrder_forEditor');
      if (g.text(source, 'useOffscreen') !== 'true')
        values.drawOrderGroup = g.text(source, 'enableDrawOrderGroup') === 'true';
      values.guideImage = g.text(source, 'isSketch') === 'true';
    }
    if (kind === 'rotation' && form?.rotation) {
      values.angle = form.rotation.angle;
      values.scale = form.rotation.scale;
      values.baseAngle = g.number(source, 'baseAngle');
    }
    if (kind === 'warp' && node) {
      values.columns = g.number(source, 'col');
      values.rows = g.number(source, 'row');
      const bezier = g
        .list(source, '_extensions')
        .find(
          (n) => n.tagName === 'CWarpDeformerBezierExtension' && g.number(n, 'editLevel') === 2,
        );
      if (bezier) {
        values.bezierColumns = g.number(bezier, 'bezierCol');
        values.bezierRows = g.number(bezier, 'bezierRow');
      }
    }
    if (kind === 'glue' && form) values.intensity = form.opacity;
    return {
      guid,
      kind,
      values,
      locked: guid === document.model.rootPartGuid || locked(objects, guid),
      keyformGuid: keyform?.guid || null,
      vertexCount: kind === 'warp' && form ? form.positions.length / 2 : object.vertexCount,
      keyformCount: object.keyformCount,
    };
  });
}

function base(e: XmlEdit, node: Element, tag: string): Element {
  let current: Element | null = node;
  while (current) {
    if (current.tagName === tag) return current;
    current = e.g.field(current, 'super');
  }
  throw new Error(`Missing native ${tag}.`);
}

/** Validation uses the current evaluated scene; native writes become one undo step. */
export function editObjectProperties(
  document: Cmo3Document,
  guids: string[],
  input: ObjectProperties,
  parameters: Record<string, number>,
  scene = readSourceScene(document).scene,
) {
  const values = objectPropertiesSchema.parse(input);
  const inspected = inspectObjects(document, scene, guids, parameters);
  if (!inspected.length) throw new Error('Select an object.');
  if (values.id !== undefined && inspected.length !== 1)
    throw new Error('Edit one object ID at a time.');
  if (
    values.id !== undefined &&
    document.model.objects.some((o) => o.guid !== inspected[0].guid && o.id === values.id)
  )
    throw new Error('This object ID is already in use.');
  const changes = inspected.map((item) => {
    if (item.locked) throw new Error('This object or its parent is locked.');
    const changed = Object.entries(values).filter(([key, value]) => {
      if (!(key in item.values)) throw new Error(`This object does not support ${key}.`);
      return JSON.stringify(value) !== JSON.stringify(item.values[key as keyof ObjectProperties]);
    }) as [keyof ObjectProperties, NonNullable<ObjectProperties[keyof ObjectProperties]> | null][];
    if (
      !item.keyformGuid &&
      changed.some(
        ([key]) =>
          keyformProperties.has(key) &&
          !(key === 'drawOrder' && item.kind === 'part' && item.keyformCount === 0),
      )
    )
      throw new Error(
        'Align the object’s parameters with existing key values before editing its appearance.',
      );
    return { item, changed };
  });
  if (values.clips) {
    const links = new Map(scene.meshes.map((m) => [m.guid, m.clips]));
    for (const { item } of changes) links.set(item.guid, [...new Set(values.clips)]);
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (guid: string) => {
      if (!links.has(guid))
        throw new Error('Select an available mesh or ArtPath as the clipping mask.');
      if (visiting.has(guid))
        throw new Error('Clipping masks cannot reference themselves or form a cycle.');
      if (visited.has(guid)) return;
      visiting.add(guid);
      for (const target of links.get(guid)!) visit(target);
      visiting.delete(guid);
      visited.add(guid);
    };
    for (const { item } of changes) visit(item.guid);
  }
  const e = new XmlEdit(document.graph),
    g = e.g;
  // Native target versions gate these properties even when the XML contains them.
  const requiredVersion = Math.max(
    values.inverted ? 400000 : 0,
    values.multiply && values.multiply.toUpperCase() !== '#FFFFFF' ? 4020000 : 0,
    values.screen && values.screen.toUpperCase() !== '#000000' ? 4020000 : 0,
  );
  if (g.number(g.source, 'targetVersionNo') < requiredVersion)
    e.value(g.source, 'targetVersionNo', requiredVersion);
  // Convert against the original graph before any other property changes.
  reparentObjects(
    document,
    scene,
    inspected.map((o) => o.guid),
    values,
    parameters,
  );
  for (const { item, changed } of changes) {
    const source = e.source(item.guid),
      forms = g.list(source, 'keyforms');
    const form = forms.find((f) => g.guid(g.field(f, 'guid')) === item.keyformGuid);
    for (const [key, value] of changed) {
      if (key === 'parentGuid' || key === 'deformerGuid') continue;
      if (key === 'name') e.field(source, 'localName', e.scalar('s', 'localName', value as string));
      else if (key === 'id')
        e.field(
          source,
          'id',
          e.node(g.field(source, 'id')!.tagName, 'id', { idstr: value as string }),
        );
      else if (key === 'columns' || key === 'rows') continue;
      else if (key === 'baseAngle') {
        const delta = (value as number) - item.values.baseAngle!;
        for (const f of forms) e.value(f, 'angle', Math.fround(g.number(f, 'angle') - delta));
        e.field(source, 'baseAngle', e.scalar('f', 'baseAngle', Math.fround(value as number)));
      } else if (key === 'bezierColumns' || key === 'bezierRows') {
        const extension = g
          .list(source, '_extensions')
          .find(
            (n) => n.tagName === 'CWarpDeformerBezierExtension' && g.number(n, 'editLevel') === 2,
          )!;
        e.value(extension, key === 'bezierColumns' ? 'bezierCol' : 'bezierRow', value as number);
      } else if (key === 'drawOrderGroup' || key === 'guideImage') {
        const field = key === 'drawOrderGroup' ? 'enableDrawOrderGroup' : 'isSketch';
        e.field(source, field, e.scalar('b', field, value as boolean));
      } else if (key === 'userData') e.field(source, key, e.scalar('s', key, value as string));
      else if (key === 'blend') {
        e.field(
          source,
          'colorComposition',
          e.node('ColorComposition', 'colorComposition', { v: (value as string).toUpperCase() }),
        );
      } else if (key === 'culling') e.field(source, key, e.scalar('b', key, value as boolean));
      else if (key === 'inverted' || key === 'clips') {
        const drawable = base(e, source, 'ACDrawableSource');
        if (key === 'inverted')
          e.field(
            drawable,
            'invertClippingMask',
            e.scalar('b', 'invertClippingMask', value as boolean),
          );
        else
          e.field(
            drawable,
            'clipGuidList',
            e.list(
              'carray_list',
              'clipGuidList',
              [...new Set(value as string[])].map((id) => e.guid('CDrawableGuid', '', id)),
            ),
          );
      } else if (key === 'drawOrder' && !form) {
        e.field(
          source,
          'defaultOrder_forEditor',
          e.scalar('i', 'defaultOrder_forEditor', value as number),
        );
      } else if (key === 'angle' || key === 'scale')
        e.value(form!, key, Math.fround(value as number));
      else if (key === 'intensity')
        e.field(form!, key, e.scalar('f', key, Math.fround(value as number)));
      else {
        const owner =
          item.kind === 'part'
            ? form!
            : base(
                e,
                form!,
                ['mesh', 'artpath'].includes(item.kind) ? 'ACDrawableForm' : 'ACDeformerForm',
              );
        if (key === 'multiply' || key === 'screen') {
          const field = key + 'Color',
            channels = [1, 3, 5].map((i) => parseInt((value as string).slice(i, i + 2), 16) / 255);
          e.field(
            owner,
            field,
            e.node('CFloatColor', field, {
              red: Math.fround(channels[0]),
              green: Math.fround(channels[1]),
              blue: Math.fround(channels[2]),
              alpha: 1,
            }),
          );
          e.imports(['com.live2d.type.CFloatColor']);
        } else
          e.field(
            owner,
            key,
            e.scalar(key === 'drawOrder' ? 'i' : 'f', key, Math.fround(value as number)),
          );
      }
    }
    if (changed.some(([key]) => key === 'columns' || key === 'rows')) {
      const warp = scene.deformers.find((d) => d.guid === item.guid)!;
      const morphs = g.list(g.field(source, 'keyformMorphTargetSet'), '_morphTargets');
      if (morphs.length)
        throw new Error('Warp divisions cannot be changed while blend shapes are attached.');
      const columns = values.columns ?? warp.columns,
        rows = values.rows ?? warp.rows;
      for (const f of forms) {
        const previous = g.numbers(f, 'positions'),
          next: number[] = [];
        for (let r = 0; r <= rows; r++)
          for (let c = 0; c <= columns; c++)
            next.push(
              ...warpPoint(previous, warp.columns, warp.rows, warp.quad, c / columns, r / rows),
            );
        e.field(f, 'positions', e.array('float-array', 'positions', next));
      }
      e.value(source, 'col', columns);
      e.value(source, 'row', rows);
    }
  }
}
