import type { PhysicsGroup, PhysicsParticle, PhysicsInput } from './physics';

export const physicsPresets = {
  hairShort: [[3, 0.95, 0.9, 1.5]],
  hairLong: [[15, 0.95, 0.8, 1.5]],
  hairTwo: [
    [10, 0.9, 0.8, 1.5],
    [8, 0.8, 0.8, 1.5],
  ],
  hairThree: [
    [10, 0.85, 0.9, 1],
    [10, 0.9, 0.9, 1],
    [8, 0.9, 0.9, 0.8],
  ],
  clothesLight: [[10, 0.9, 0.6, 1.5]],
  clothesHeavy: [[10, 0.95, 0.8, 1.5]],
  bustSmall: [[3, 0.8, 0.9, 1.5]],
  bustLarge: [[5, 0.9, 0.8, 1.5]],
  chainTen: Array.from({ length: 10 }, () => [10, 0.85, 0.85, 1.2]),
  chainTwenty: Array.from({ length: 20 }, (_, i) => [10, i < 10 ? 0.85 : 0.95, 0.85, 1.2]),
} satisfies Record<string, number[][]>;
export type PhysicsPreset = keyof typeof physicsPresets;

export function presetParticles(
  preset: PhysicsPreset | 'none',
  uuid = () => crypto.randomUUID(),
): PhysicsParticle[] {
  let y = 0;
  return [
    { guid: uuid(), position: { x: 0, y: 0 }, radius: 0, mobility: 1, delay: 1, acceleration: 1 },
    ...(preset === 'none' ? [] : physicsPresets[preset]).map(
      ([radius, mobility, delay, acceleration]) => ({
        guid: uuid(),
        position: { x: 0, y: (y += radius) },
        radius,
        mobility,
        delay,
        acceleration,
      }),
    ),
  ];
}
export function presetInputs(
  preset: 'head' | 'body' | 'none',
  parameterIds: string[],
  uuid = () => crypto.randomUUID(),
): PhysicsInput[] {
  const ids: [string, 'X' | 'Angle', number][] =
    preset === 'head'
      ? [
          ['ParamAngleX', 'X', 60],
          ['ParamAngleZ', 'Angle', 60],
          ['ParamBodyAngleX', 'X', 40],
          ['ParamBodyAngleZ', 'Angle', 40],
        ]
      : preset === 'body'
        ? [
            ['ParamBodyAngleX', 'X', 100],
            ['ParamBodyAngleZ', 'Angle', 100],
          ]
        : [];
  return ids
    .filter(([id]) => parameterIds.includes(id))
    .map(([parameterId, type, weight]) => ({
      guid: uuid(),
      parameterId,
      type,
      weight,
      reflect: false,
    }));
}
export function newPhysicsGroup(
  name: string,
  parameterIds: string[],
  groups: PhysicsGroup[],
  input: 'head' | 'body' | 'none' = 'head',
  model: PhysicsPreset | 'none' = 'hairShort',
  uuid = () => crypto.randomUUID(),
): PhysicsGroup {
  let n = 1;
  while (groups.some((g) => g.id === `PhysicsSetting${n}`)) n++;
  return {
    guid: uuid(),
    id: `PhysicsSetting${n}`,
    name,
    inputs: presetInputs(input, parameterIds, uuid),
    outputs: [],
    particles: presetParticles(model, uuid),
    normalization: {
      position: { min: -10, default: 0, max: 10 },
      angle: { min: -10, default: 0, max: 10 },
    },
  };
}
