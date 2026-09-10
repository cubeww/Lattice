import type { Element } from '@xmldom/xmldom';
import type { Cmo3Document } from './document';
import type { Cmo3Xml } from './xml';
import { XmlEdit } from './edit';
import {
  physicsSettingsSchema,
  type PhysicsSettings,
  type PhysicsType,
} from '../../shared/physics';

const nativeTypes: Record<PhysicsType, string> = {
  X: 'SRC_TO_X',
  Y: 'SRC_TO_Y',
  Angle: 'SRC_TO_G_ANGLE',
};
export function readPhysics(
  g: Cmo3Xml,
  parameters: { guid: string; id: string }[],
): PhysicsSettings {
  const set = g.field(g.source, 'physicsSettingsSourceSet');
  const byGuid = new Map(parameters.map((p) => [p.guid, p.id]));
  const vec = (n: Element | null) => ({ x: g.number(n, 'x'), y: g.number(n, 'y') });
  const type = (n: Element): PhysicsType => {
    const value = g.field(n, 'type')?.getAttribute('v');
    const key = (Object.keys(nativeTypes) as PhysicsType[]).find((t) => nativeTypes[t] === value);
    if (!key) throw new Error(`Unsupported physics source type: ${value}`);
    return key;
  };
  const target = (n: Element, key: string) => {
    const guid = g.guid(g.field(n, key));
    return byGuid.get(guid || '') || `missing:${guid}`;
  };
  const range = (n: Element, name: string) => ({
    min: g.number(n, `normalized${name}ValueMin`, -10),
    max: g.number(n, `normalized${name}ValueMax`, 10),
    default: g.number(n, `normalized${name}DefaultValue`),
  });
  return {
    fps: g.number(set, 'settingFPS', 60),
    groups: g.list(set, '_sourceCubismPhysics').map((n) => ({
      guid: g.guid(g.field(n, 'guid'))!,
      id: g.field(n, 'id')?.getAttribute('idstr') || '',
      name: g.text(n, 'name'),
      inputs: g.list(n, 'inputs').map((p) => ({
        guid: g.guid(g.field(p, 'guid'))!,
        parameterId: target(p, 'source'),
        type: type(p),
        weight: g.number(p, 'weight', 100),
        reflect: g.text(p, 'isReverse') === 'true',
      })),
      outputs: g.list(n, 'outputs').map((p) => ({
        guid: g.guid(g.field(p, 'guid'))!,
        parameterId: target(p, 'destination'),
        type: type(p),
        weight: g.number(p, 'weight', 100),
        reflect: g.text(p, 'isReverse') === 'true',
        vertexIndex: g.number(p, 'vertexIndex', 1),
        scale:
          type(p) === 'Angle'
            ? g.number(p, 'angleScale', 1)
            : g.number(g.field(p, 'translationScale'), type(p).toLowerCase(), 1),
      })),
      particles: g.list(n, 'vertices').map((p) => ({
        guid: g.guid(g.field(p, 'guid'))!,
        position: vec(g.field(p, 'position')),
        radius: g.number(p, 'radius'),
        mobility: g.number(p, 'mobility', 1),
        delay: g.number(p, 'delay', 1),
        acceleration: g.number(p, 'acceleration', 1),
      })),
      normalization: { position: range(n, 'Position'), angle: range(n, 'Angle') },
    })),
  };
}

export function physicsIssues(
  settings: PhysicsSettings,
  parameters: { id: string; bindings?: Record<string, number[]> }[],
) {
  const issues: { severity: 'error' | 'warning'; code: string; message: string; guid?: string }[] =
    [];
  const parsed = physicsSettingsSchema.safeParse(settings);
  if (!parsed.success)
    issues.push({ severity: 'error', code: 'INVALID_PHYSICS', message: parsed.error.message });
  const byId = new Map(parameters.map((p) => [p.id, p]));
  for (const group of settings.groups) {
    for (const entry of [...group.inputs, ...group.outputs])
      if (!byId.has(entry.parameterId))
        issues.push({
          severity: 'error',
          code: 'PHYSICS_PARAMETER_MISSING',
          guid: group.guid,
          message: `${group.name}: Parameter ${entry.parameterId} does not exist.`,
        });
    for (const type of ['X', 'Y', 'Angle'])
      if (group.inputs.filter((i) => i.type === type).reduce((s, i) => s + i.weight, 0) > 100.001)
        issues.push({
          severity: 'warning',
          code: 'PHYSICS_INPUT_WEIGHT',
          guid: group.guid,
          message: `${group.name}: ${type} input weights exceed 100%.`,
        });
    for (const output of group.outputs) {
      const p = byId.get(output.parameterId);
      if (
        p?.bindings &&
        !Object.keys(p.bindings).length &&
        !settings.groups.some((g) => g.inputs.some((i) => i.parameterId === p.id))
      )
        issues.push({
          severity: 'warning',
          code: 'PHYSICS_OUTPUT_UNBOUND',
          guid: group.guid,
          message: `${group.name}: ${p.id} has no keyforms; this output cannot deform the model.`,
        });
    }
  }
  return issues;
}

/** Replace the physics field as a single native field edit; scene and textures stay cached. */
export function writePhysics(document: Cmo3Document, value: PhysicsSettings) {
  const settings = physicsSettingsSchema.parse(value);
  const errors = physicsIssues(settings, document.model.parameters).filter(
    (i) => i.severity === 'error',
  );
  if (errors.length) throw new Error(errors.map((i) => i.message).join('\n'));
  const g = document.graph,
    e = new XmlEdit(g);
  const byId = new Map(document.model.parameters.map((p) => [p.id, p.guid]));
  const vector = (name: string, x: number, y: number) =>
    e.node('GVector2', name, {}, [e.scalar('f', 'x', x), e.scalar('f', 'y', y)]);
  const groups = settings.groups.map((group) =>
    e.node('CPhysicsSettingsSource', undefined, {}, [
      e.guid('CPhysicsSettingsGuid', 'guid', group.guid),
      e.node('CPhysicsSettingId', 'id', { idstr: group.id }),
      e.scalar('s', 'name', group.name),
      e.list(
        'carray_list',
        'inputs',
        group.inputs.map((p) =>
          e.node('CPhysicsInput', undefined, {}, [
            e.guid('CPhysicsDataGuid', 'guid', p.guid),
            e.guid('CParameterGuid', 'source', byId.get(p.parameterId)!),
            e.scalar('f', 'angleScale', 0),
            vector('translationScale', 0, 0),
            e.scalar('f', 'weight', p.weight),
            e.node('CPhysicsSourceType', 'type', { v: nativeTypes[p.type] }),
            e.scalar('b', 'isReverse', p.reflect),
          ]),
        ),
      ),
      e.list(
        'carray_list',
        'outputs',
        group.outputs.map((p) =>
          e.node('CPhysicsOutput', undefined, {}, [
            e.guid('CPhysicsDataGuid', 'guid', p.guid),
            e.guid('CParameterGuid', 'destination', byId.get(p.parameterId)!),
            e.scalar('i', 'vertexIndex', p.vertexIndex),
            e.scalar('f', 'angleScale', p.type === 'Angle' ? p.scale : 0),
            vector('translationScale', p.type === 'X' ? p.scale : 0, p.type === 'Y' ? p.scale : 0),
            e.scalar('f', 'weight', p.weight),
            e.node('CPhysicsSourceType', 'type', { v: nativeTypes[p.type] }),
            e.scalar('b', 'isReverse', p.reflect),
          ]),
        ),
      ),
      e.list(
        'carray_list',
        'vertices',
        group.particles.map((p) =>
          e.node('CPhysicsVertex', undefined, {}, [
            e.guid('CPhysicsDataGuid', 'guid', p.guid),
            vector('position', p.position.x, p.position.y),
            ...(['radius', 'mobility', 'delay', 'acceleration'] as const).map((key) =>
              e.scalar('f', key, p[key]),
            ),
          ]),
        ),
      ),
      ...(['position', 'angle'] as const).flatMap((key) => {
        const prefix = key === 'position' ? 'Position' : 'Angle',
          range = group.normalization[key];
        return [
          e.scalar('f', `normalized${prefix}ValueMin`, range.min),
          e.scalar('f', `normalized${prefix}ValueMax`, range.max),
          e.scalar('f', `normalized${prefix}DefaultValue`, range.default),
        ];
      }),
    ]),
  );
  const previous = g.guid(
    g.field(g.field(g.source, 'physicsSettingsSourceSet'), 'selectedCubismPhysics'),
  );
  const selected = settings.groups.find((group) => group.guid === previous) || settings.groups[0];
  e.imports([
    ...[
      'CPhysicsSettingsSourceSet',
      'CPhysicsSettingsSource',
      'CPhysicsInput',
      'CPhysicsOutput',
      'CPhysicsVertex',
    ].map((n) => `com.live2d.cubism.doc.gameData.physics.${n}`),
    'com.live2d.cubism.doc.gameData.physics.CPhysicsController$CPhysicsSourceType',
    'com.live2d.type.CPhysicsSettingsGuid',
    'com.live2d.type.CPhysicsDataGuid',
    'com.live2d.type.CParameterGuid',
    'com.live2d.cubism.doc.model.id.CPhysicsSettingId',
    'com.live2d.graphics3d.type.GVector2',
  ]);
  e.field(
    g.source,
    'physicsSettingsSourceSet',
    e.node('CPhysicsSettingsSourceSet', undefined, {}, [
      e.list('carray_list', '_sourceCubismPhysics', groups),
      selected
        ? e.guid('CPhysicsSettingsGuid', 'selectedCubismPhysics', selected.guid)
        : e.node('null', 'selectedCubismPhysics'),
      e.scalar('i', 'settingFPS', settings.fps),
    ]),
  );
}
