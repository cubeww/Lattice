import { z } from 'zod';
import { physicsEditSchema } from './physics';
import { formEditSchema } from './form-edit';
import { motionMirroringSchema } from './motion-mirroring';
import { psdImportOptionsSchema } from './psd';
import { keyformBatchSchema } from './workflow';

const path = z.string().min(1).max(32768);
const points = z
  .array(z.tuple([z.number().finite().min(-1e7).max(1e7), z.number().finite().min(-1e7).max(1e7)]))
  .min(2)
  .max(1000);
const guid = z.string().min(1).max(512);
const canvasPoint = z.tuple([
  z.number().finite().min(-1e7).max(1e7),
  z.number().finite().min(-1e7).max(1e7),
]);
const brushSettingsSchema = z.object({
  size: z.number().min(0.1).max(10000),
  hardness: z.number().min(0).max(1),
  strength: z.number().min(0.01).max(1),
  shape: z.enum(['circle', 'square']),
  angle: z.number().min(-180).max(180),
  brushMode: z.enum(['move', 'inflate', 'smooth']),
});
const pointSelectionSchema = z.record(
  z.string(),
  z.record(z.string().regex(/^\d+$/), z.number().min(0).max(1)),
);
const atlasSize = z
  .number()
  .int()
  .min(64)
  .max(8192)
  .refine((v) => (v & (v - 1)) === 0, 'Use a power-of-two atlas size.');
const parameterNumber = z.number().finite().min(-1e7).max(1e7);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const cameraSchema = z.object({
  zoom: z.number().min(0.05).max(8),
  panX: z.number().finite().min(-100000).max(100000),
  panY: z.number().finite().min(-100000).max(100000),
  tool: z.enum([
    'select',
    'pan',
    'lasso',
    'brushSelect',
    'deformBrush',
    'rotationDraw',
    'deformPath',
    'artPath',
    'glue',
  ]),
});
export const projectResourcePropertiesSchema = z
  .object({
    name: z.string().max(256).optional(),
    memo: z.string().max(16384).optional(),
    layerId: z.string().max(256).optional(),
    replaced: z.boolean().optional(),
  })
  .strict();
export const objectPropertiesSchema = z
  .object({
    name: z
      .string()
      .max(256)
      .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))
      .optional(),
    id: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(256)
      .optional(),
    parentGuid: guid.nullable().optional(),
    deformerGuid: guid.nullable().optional(),
    drawOrder: z.number().int().min(0).max(1000).optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    multiply: color.optional(),
    screen: color.optional(),
    clips: z.array(guid).max(256).optional(),
    inverted: z.boolean().optional(),
    blend: z.enum(['normal', 'add', 'multiply']).optional(),
    culling: z.boolean().optional(),
    userData: z
      .string()
      .max(16384)
      .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))
      .optional(),
    drawOrderGroup: z.boolean().optional(),
    guideImage: z.boolean().optional(),
    angle: z.number().finite().min(-3600).max(3600).optional(),
    scale: z.number().finite().min(0.001).max(100).optional(),
    baseAngle: z.number().finite().min(-3600).max(3600).optional(),
    columns: z.number().int().min(1).max(32).optional(),
    rows: z.number().int().min(1).max(32).optional(),
    bezierColumns: z.number().int().min(1).max(8).optional(),
    bezierRows: z.number().int().min(1).max(8).optional(),
    intensity: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
export const parameterDefinitionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .max(256),
    name: z.string().trim().min(1).max(256),
    min: parameterNumber,
    max: parameterNumber,
    default: parameterNumber,
    description: z.string().max(4096),
  })
  .refine(
    (p) => p.min < p.max && p.default >= p.min && p.default <= p.max,
    'Default must lie within the parameter range.',
  );
export const parameterKeyEditSchema = z.object({
  parameterGuid: guid,
  keys: z
    .array(z.object({ value: parameterNumber, previous: parameterNumber.optional() }))
    .max(101),
});
export const createDeformerSchema = z.object({
  kind: z.enum(['warp', 'rotation']),
  guids: z.array(guid).max(1000),
  name: z.string().min(1).max(256),
  placement: z.enum(['parent', 'child']),
  columns: z.number().int().min(1).max(32),
  rows: z.number().int().min(1).max(32),
  bezierColumns: z.number().int().min(1).max(8),
  bezierRows: z.number().int().min(1).max(8),
  origin: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  handleLength: z.number().min(1).max(10000).optional(),
  angle: z.number().finite().optional(),
});
export const affineSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
  .refine(
    (m) =>
      m.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e7) &&
      Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-8,
  );
export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('editPhysics'),
    edits: z.array(physicsEditSchema).min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('importPhysics'),
    path,
    mode: z.enum(['replace', 'append']),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('exportPhysics'),
    path,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editKeyformBatch'),
    frames: keyformBatchSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('mirrorMotion'),
    value: motionMirroringSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('copyForms'),
    guids: z.array(guid).min(1).max(1000),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editForms'),
    value: formEditSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('selectProject'), keys: z.array(guid).max(1000) }),
  z.object({
    type: z.literal('editProjectResource'),
    key: guid,
    values: projectResourcePropertiesSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('createMeshesFromImages'),
    keys: z.array(guid).min(1).max(100),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('assignModelImage'),
    key: guid,
    guids: z.array(guid).min(1).max(1000),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('setTextureMode'),
    mode: z.enum(['modelImage', 'atlas']),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('deleteProjectImages'),
    keys: z.array(guid).min(1).max(1000),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('exportProjectImage'),
    key: guid,
    path,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('createPart'),
    value: z
      .object({
        name: objectPropertiesSchema.shape.name.unwrap().min(1),
        id: objectPropertiesSchema.shape.id.unwrap(),
        drawOrder: objectPropertiesSchema.shape.drawOrder.unwrap(),
        guids: z.array(guid).max(1000),
        groupSelected: z.boolean(),
      })
      .strict(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('movePartObjects'),
    guids: z.array(guid).min(1).max(1000),
    parentGuid: guid.nullable(),
    beforeGuid: guid.optional(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('deletePartObjects'),
    guids: z.array(guid).min(1).max(1000),
    mode: z.enum(['subtree', 'partsOnly']),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('pruneEmptyParts'),
    parentGuid: guid.nullable(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('setObjectFlags'),
    guids: z.array(guid).min(1).max(1000),
    values: z
      .object({ visible: z.boolean().optional(), locked: z.boolean().optional() })
      .strict()
      .refine((v) => v.visible !== undefined || v.locked !== undefined),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('moveDeformerObjects'),
    guids: z.array(guid).min(1).max(1000),
    deformerGuid: guid.nullable(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('pruneEmptyDeformers'),
    parentGuid: guid.nullable(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editObjectProperties'),
    guids: z.array(guid).min(1).max(1000),
    values: objectPropertiesSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('createParameter'),
    value: parameterDefinitionSchema,
    groupGuid: guid,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editParameter'),
    guid,
    value: parameterDefinitionSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('createParameterGroup'),
    name: z.string().trim().min(1).max(256),
    parentGuid: guid,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('renameParameterGroup'),
    guid,
    name: z.string().trim().min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('moveParameterEntries'),
    guids: z.array(guid).min(1).max(1000),
    groupGuid: guid,
    beforeGuid: guid.optional(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('deleteParameterEntries'),
    guids: z.array(guid).min(1).max(1000),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('linkParameter'),
    guid,
    combined: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editParameterKeys'),
    guids: z.array(guid).min(1).max(1000),
    edits: z.array(parameterKeyEditSchema).min(1).max(32),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('setParameterDefaults'),
    ids: z.array(guid).optional(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('setParameters'),
    values: z.record(z.string(), parameterNumber),
    editId: guid.optional(),
  }),
  z.object({ type: z.literal('beginParameterEdit'), editId: guid, ids: z.array(guid).min(1) }),
  z.object({ type: z.literal('endParameterEdit'), editId: guid, cancel: z.boolean().optional() }),
  z.object({
    type: z.literal('parameterPanel'),
    value: z.object({
      selection: z.array(guid).max(1000).optional(),
      collapsed: z.array(guid).max(1000).optional(),
      onlyActive: z.boolean().optional(),
      dragLocked: z.boolean().optional(),
      snap: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('createArtPath'),
    points,
    name: z.string().min(1).max(256),
    width: z.number().min(0.1).max(1000),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    parentGuid: guid.nullable(),
    deformerGuid: guid.nullable(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('createController'),
    guid,
    points,
    width: z.number().min(1).max(10000),
    hardness: z.number().min(0).max(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('setGlue'),
    guid: guid.optional(),
    value: z.object({
      name: z.string().min(1).max(256),
      meshA: guid,
      meshB: guid,
      pairs: z
        .array(
          z.object({
            indexA: z.number().int().nonnegative(),
            indexB: z.number().int().nonnegative(),
            weightA: z.number().min(0).max(1),
            weightB: z.number().min(0).max(1),
          }),
        )
        .min(1)
        .max(10000),
    }),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('removeGlue'),
    guid,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editGlueWeights'),
    changes: z
      .array(
        z.object({
          guid,
          weights: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                weightA: z.number().min(0).max(1),
                weightB: z.number().min(0).max(1),
              }),
            )
            .min(1)
            .max(10000),
        }),
      )
      .min(1)
      .max(1000),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editAtlases'),
    expectedRevision: z.number().int().nonnegative(),
    atlases: z
      .array(
        z.object({
          guid: z.string().uuid(),
          name: z.string().min(1).max(256),
          width: z
            .number()
            .int()
            .min(64)
            .max(8192)
            .refine((v) => (v & (v - 1)) === 0, 'Use a power-of-two atlas size.'),
          height: z
            .number()
            .int()
            .min(64)
            .max(8192)
            .refine((v) => (v & (v - 1)) === 0, 'Use a power-of-two atlas size.'),
          items: z
            .array(
              z.object({
                guid,
                x: z.number().finite(),
                y: z.number().finite(),
                scaleX: z.number().min(0.01).max(10),
                scaleY: z.number().min(0.01).max(10),
                angle: z.number().min(-360).max(360),
              }),
            )
            .max(1000),
        }),
      )
      .max(16),
  }),
  z.object({ type: z.literal('new') }),
  z.object({
    type: z.literal('open'),
    path,
    psd: psdImportOptionsSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('close') }),
  z.object({
    type: z.literal('editTopology'),
    guid,
    textureMode: z.enum(['modelImage', 'atlas']).optional(),
    vertices: z
      .array(
        z.object({
          u: z.number().finite().min(-10).max(10),
          v: z.number().finite().min(-10).max(10),
          sourceIndex: z.number().int().nonnegative().optional(),
        }),
      )
      .min(3)
      .max(10000),
    indices: z.array(z.number().int().nonnegative()).max(60000).optional(),
    edges: z
      .array(
        z.object({
          a: z.number().int().nonnegative(),
          b: z.number().int().nonnegative(),
          priority: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(40)]),
        }),
      )
      .max(60000)
      .optional(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('automaticMesh'),
    guids: z.array(guid).min(1).max(1000),
    settings: z.object({
      outsideInterval: z.number().int().min(10).max(200),
      insideInterval: z.number().int().min(10).max(200),
      outsideMargin: z.number().int().min(0).max(50),
      insideMargin: z.number().int().min(0).max(50),
      minimumMargin: z.number().int().min(1).max(10),
      minimumBoundaryPoints: z.number().int().min(3).max(20),
      alphaThreshold: z.number().int().min(0).max(254),
    }),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('createDeformer'),
    value: createDeformerSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editRotation'),
    guid,
    preserveChildren: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative(),
    value: z.object({
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      angle: z.number().finite().min(-36000).max(36000).optional(),
      scale: z.number().min(0.001).max(1000).optional(),
    }),
  }),
  z.object({ type: z.literal('select'), guid: guid.nullable() }),
  z.object({
    type: z.literal('selectRegion'),
    guids: z.array(guid).max(1000).optional(),
    region: z.discriminatedUnion('type', [
      z.object({ type: z.literal('rectangle'), points: z.tuple([canvasPoint, canvasPoint]) }),
      z.object({ type: z.literal('lasso'), points: z.array(canvasPoint).min(1).max(10000) }),
      z.object({ type: z.literal('brush'), points: z.array(canvasPoint).min(1).max(10000) }),
    ]),
    mode: z.enum(['replace', 'add', 'subtract']),
    settings: brushSettingsSchema.partial().optional(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('deformBrush'),
    guids: z.array(guid).max(1000).optional(),
    points: z.array(canvasPoint).min(2).max(10000),
    settings: brushSettingsSchema.partial().optional(),
    selection: pointSelectionSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('autoLayoutAtlas'),
    value: z.object({
      atlasGuid: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(256).optional(),
      width: atlasSize.optional(),
      height: atlasSize.optional(),
      addImages: z.union([z.enum(['unassigned', 'visible']), z.array(guid).max(1000)]),
      padding: z.number().int().min(0).max(128),
    }),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('selectMany'),
    guids: z.array(guid).max(1000),
    points: pointSelectionSchema.optional(),
  }),
  z.object({
    type: z.literal('editVertices'),
    expectedRevision: z.number().int().nonnegative(),
    edits: z
      .array(
        z.object({
          guid,
          points: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                x: z.number().finite().min(-1e9).max(1e9),
                y: z.number().finite().min(-1e9).max(1e9),
              }),
            )
            .min(1)
            .max(100000),
        }),
      )
      .min(1)
      .max(1000),
  }),
  z.object({
    type: z.literal('toolSettings'),
    value: brushSettingsSchema.partial().extend({
      pathWidth: z.number().min(0.1).max(1000).optional(),
      pathColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('rename'),
    guid,
    name: z
      .string()
      .max(256)
      .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)),
  }),
  z.object({ type: z.literal('setParameter'), id: guid, value: z.number().finite() }),
  z.object({ type: z.literal('resetParameters'), ids: z.array(guid).optional() }),
  z.object({
    type: z.literal('transformMesh'),
    guid,
    expectedRevision: z.number().int().nonnegative(),
    matrix: affineSchema,
  }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('redo') }),
  z.object({ type: z.literal('save'), path: path.optional() }),
  z.object({
    type: z.literal('view'),
    expectedCamera: cameraSchema.extend({ previewId: z.string().nullable() }).optional(),
    value: cameraSchema.partial().extend({
      grid: z.boolean().optional(),
      mesh: z.boolean().optional(),
      background: z.enum(['checker', 'white', 'dark']).optional(),
      editLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    }),
  }),
  z.object({ type: z.literal('locale'), value: z.enum(['en', 'zh-CN', 'ja']) }),
]);
