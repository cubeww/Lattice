import type { Element } from '@xmldom/xmldom';
import type {
  Color,
  KeyBinding,
  MeshEdge,
  SourceDeformer,
  SourceForm,
  SourceMesh,
  SourceNode,
  SourceScene,
} from '../../shared/scene';
import type { Cmo3Document } from './document';
import { children } from './xml';
import { PNG } from 'pngjs';
import { strokeMesh } from '../model/curves';
import { meshConnections } from '../model/topology';

export interface SceneImage {
  path: string;
  bytes: Buffer;
  width: number;
  height: number;
}

/** Decode editor source data. No MOC, runtime metadata or vendor code is used. */
export function readSourceScene(
  document: Cmo3Document,
  previous?: {
    scene: SourceScene;
    images: SceneImage[];
    changed: ReadonlySet<string>;
  },
): {
  scene: SourceScene;
  images: SceneImage[];
} {
  const g = document.graph;
  const images: SceneImage[] = previous ? [...previous.images] : [];
  const reused = new Map(
    previous
      ? [
          ...previous.scene.parts,
          ...previous.scene.deformers,
          ...previous.scene.meshes,
          ...(previous.scene.glues || []),
        ].map((node) => [node.guid, node])
      : [],
  );
  const textures = new Map<Element, { index: number; inverse: number[] }>();
  const byGuid = new Map(document.model.objects.map((o) => [o.guid, o]));
  const parameters = new Map(document.model.parameters.map((p) => [p.guid, p.id]));
  const scene: SourceScene = {
    canvas: document.model.canvas,
    parameters: document.model.parameters.map(({ id, min, max, default: value }) => ({
      id,
      min,
      max,
      default: value,
    })),
    rootPartGuid: document.model.rootPartGuid!,
    parts: [],
    deformers: [],
    meshes: [],
    textures: [],
    warnings: [],
  };
  if (scene.canvas.width <= 0 || scene.canvas.height <= 0)
    throw new Error('Invalid source canvas dimensions.');
  const warning = (message: string) => {
    if (!scene.warnings.includes(message)) scene.warnings.push(message);
  };
  const color = (form: Element, key: string, initial: Color): Color => {
    const node = g.field(form, key);
    if (!node) return [...initial];
    return [
      g.number(node, 'red', initial[0]),
      g.number(node, 'green', initial[1]),
      g.number(node, 'blue', initial[2]),
      g.number(node, 'alpha', initial[3]),
    ];
  };
  const base = (node: Element): SourceNode => {
    const guid = g.guid(g.field(node, 'guid'))!;
    const metadata = byGuid.get(guid);
    if (!metadata) throw new Error('Unsupported source node.');
    const grid = g.field(node, 'keyformGridSource');
    const bindingNodes = g.list(grid, 'keyformBindings');
    const bindings: KeyBinding[] = bindingNodes.map((binding) => {
      const id = parameters.get(g.guid(g.field(binding, 'parameterGuid'))!);
      if (!id) throw new Error('Unknown parameter binding.');
      const keys = g.list(binding, 'keys').map((n) => Number(n.textContent));
      if (!keys.length || keys.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= keys[i - 1])))
        throw new Error('Parameter keys must be strictly increasing.');
      const type = g.field(binding, 'interpolationType')?.getAttribute('v') || 'LINEAR';
      if (!['LINEAR', 'AUTO', 'NEAREST_NEIGHBOR'].includes(type))
        throw new Error(`Unsupported interpolation: ${type}`);
      const extended = g.field(binding, 'extendedInterpolationType')?.getAttribute('v');
      if (extended && extended !== 'LINEAR')
        warning(`${metadata.id}: extended interpolation ${extended} is not evaluated.`);
      return {
        parameterId: id,
        keys,
        interpolation: type === 'NEAREST_NEIGHBOR' ? 'nearest' : 'linear',
      };
    });
    const keysByForm = new Map<string, number[]>();
    for (const item of g.list(grid, 'keyformsOnGrid')) {
      const access = g.field(item, 'accessKey');
      const keys = Array(bindings.length).fill(-1) as number[];
      for (const k of g.list(access, '_keyOnParameterList')) {
        const index = bindingNodes.indexOf(g.field(k, 'binding')!);
        if (index < 0) throw new Error('Invalid keyform binding reference.');
        keys[index] = g.number(k, 'keyIndex', -1);
      }
      if (
        keys.some((key, i) => !Number.isInteger(key) || key < 0 || key >= bindings[i].keys.length)
      )
        throw new Error('Invalid keyform grid coordinates.');
      keysByForm.set(g.guid(g.field(item, 'keyformGuid'))!, keys);
    }
    // A source can retain unbound forms (e.g. editing history). The grid is
    // authoritative for which forms participate in parameter evaluation.
    const formNodes = g
      .list(node, 'keyforms')
      .filter((form) => keysByForm.has(g.guid(g.field(form, 'guid'))!));
    const forms: SourceForm[] = formNodes.map((form) => {
      const keys = keysByForm.get(g.guid(g.field(form, 'guid'))!);
      if (!keys) throw new Error('A keyform is absent from its parameter grid.');
      const coord = g.text(g.field(form, 'coordType'), 'coordName');
      if (
        metadata.kind !== 'part' &&
        metadata.kind !== 'glue' &&
        coord !== 'Canvas' &&
        coord !== 'DeformerLocal'
      )
        throw new Error(`Unsupported keyform coordinates: ${coord}`);
      return {
        guid: g.guid(g.field(form, 'guid'))!,
        keys,
        positions:
          metadata.kind === 'artpath'
            ? g.list(form, 'positions').flatMap((p) => {
                const point = g.field(g.field(p, 'curvePointPosition'), 'point');
                return [g.number(point, 'x'), g.number(point, 'y')];
              })
            : g.numbers(form, 'positions'),
        opacity: g.number(form, metadata.kind === 'glue' ? 'intensity' : 'opacity', 1),
        drawOrder: g.number(form, 'drawOrder', metadata.drawOrder),
        multiply: color(form, 'multiplyColor', [1, 1, 1, 1]),
        screen: color(form, 'screenColor', [0, 0, 0, 0]),
        rotation:
          metadata.kind === 'rotation'
            ? {
                x: g.number(form, 'originX'),
                y: g.number(form, 'originY'),
                angle: g.number(form, 'angle'),
                scale: g.number(form, 'scale', 1),
                reflectX: g.text(form, 'isReflectX') === 'true',
                reflectY: g.text(form, 'isReflectY') === 'true',
              }
            : null,
        ...(metadata.kind === 'artpath'
          ? {
              pathPoints: g.list(form, 'positions').map((p) => {
                const curve = g.field(p, 'curvePointPosition');
                const vector = (key: string): [number, number] => [
                  g.number(g.field(curve, key), 'x'),
                  g.number(g.field(curve, key), 'y'),
                ];
                return {
                  width: g.number(p, 'width', 10),
                  opacity: g.number(p, 'opacity', 1),
                  color: [
                    g.number(p, 'colorRed'),
                    g.number(p, 'colorGreen'),
                    g.number(p, 'colorBlue'),
                    g.number(p, 'colorAlpha', 1),
                  ] as Color,
                  corner: g.text(p, 'isCorner') === 'true',
                  start: vector('startVelocity'),
                  end: vector('endVelocity'),
                };
              }),
            }
          : {}),
      };
    });
    if (!forms.length && metadata.kind === 'part' && !bindings.length)
      forms.push({
        guid: '',
        keys: [],
        positions: [],
        opacity: 1,
        drawOrder: metadata.drawOrder,
        multiply: [1, 1, 1, 1],
        screen: [0, 0, 0, 0],
        rotation: null,
      });
    if (
      !forms.length ||
      forms.length !== bindings.reduce((size, binding) => size * binding.keys.length, 1)
    )
      throw new Error('An incomplete or blend-shape keyform grid is not supported.');
    if (new Set(forms.map((f) => f.keys.join(','))).size !== forms.length)
      throw new Error('Duplicate keyform grid coordinates.');
    if (forms.some((form) => form.positions.length !== forms[0].positions.length))
      throw new Error('Keyform vertex counts do not match.');
    // CDeformerGuid.ROOT is a format-defined identity transform, not a source.
    const deformerGuid =
      metadata.deformerGuid === '71fae776-e218-4aee-873e-78e8ac0cb48a'
        ? null
        : metadata.deformerGuid;
    return {
      guid,
      id: metadata.id,
      kind: metadata.kind === 'artpath' ? 'mesh' : metadata.kind,
      parentGuid: metadata.parentGuid,
      deformerGuid,
      visible: metadata.visible,
      bindings,
      forms,
    };
  };
  const texture = (node: Element) => {
    const tex = g.field(node, 'texture');
    if (!tex) throw new Error('Mesh has no source texture.');
    const existing = textures.get(tex);
    if (existing) return existing;
    const resource = g.field(tex, 'srcImageResource');
    const path = g.field(resource, 'imageFileBuf')?.getAttribute('path');
    if (!resource || !path) throw new Error('Mesh source image is absent.');
    const width = g.number(resource, 'width'),
      height = g.number(resource, 'height');
    const bytes = document.archive.read(path);
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error('Source image must be PNG.');
    if (
      width < 1 ||
      height < 1 ||
      width * height > 67108864 ||
      bytes.readUInt32BE(16) !== width ||
      bytes.readUInt32BE(20) !== height
    )
      throw new Error('Invalid source image dimensions.');
    const tr = g.field(tex, 'transformImageResource01toLogical01');
    const a = g.number(tr, 'm00', 1),
      b = g.number(tr, 'm01'),
      c = g.number(tr, 'm02');
    const d = g.number(tr, 'm10'),
      e = g.number(tr, 'm11', 1),
      f = g.number(tr, 'm12');
    const det = a * e - b * d;
    if (Math.abs(det) < 1e-12) throw new Error('Source image transform is singular.');
    let index = images.findIndex((image) => image.path === path);
    if (index < 0) {
      index = images.length;
      images.push({ path, bytes, width, height });
    }
    const result = {
      index,
      inverse: [e / det, -b / det, (b * f - e * c) / det, -d / det, a / det, (d * c - a * f) / det],
    };
    textures.set(tex, result);
    return result;
  };
  for (const node of [
    ...g.sources('partSourceSet'),
    ...g.sources('deformerSourceSet'),
    ...g.sources('drawableSourceSet'),
  ]) {
    const metadata = byGuid.get(g.guid(g.field(node, 'guid'))!);
    if (!metadata) {
      warning(`Unsupported source type: ${node.tagName}`);
      continue;
    }
    const old = reused.get(metadata.guid);
    if (old && !previous!.changed.has(metadata.guid)) {
      if (old.kind === 'part') scene.parts.push(old);
      else if (old.kind === 'mesh') scene.meshes.push(old);
      else if (old.kind === 'warp' || old.kind === 'rotation') scene.deformers.push(old);
      continue;
    }
    try {
      const common = base(node);
      if (metadata.kind === 'artpath') {
        const pointNodes = g.list(g.list(node, 'keyforms')[0], 'positions'),
          widths = pointNodes.map((p) => g.number(p, 'width', 10)),
          corners = pointNodes.map((p) => g.text(p, 'isCorner') === 'true');
        const path = {
          closed: g.text(node, 'isClosed') === 'true',
          divisions: Math.max(4, Math.min(100, g.number(node, 'divNum', 20))),
          widths,
          corners,
          color: [
            g.number(pointNodes[0], 'colorRed'),
            g.number(pointNodes[0], 'colorGreen'),
            g.number(pointNodes[0], 'colorBlue'),
            1,
          ] as Color,
        };
        const geometry = strokeMesh(
          Array.from({ length: common.forms[0].positions.length / 2 }, (_, i) => [
            common.forms[0].positions[i * 2],
            common.forms[0].positions[i * 2 + 1],
          ]),
          widths,
          path.divisions,
          path.closed,
          corners,
        );
        let texture = images.findIndex((i) => i.path === '__lattice_white.png');
        if (texture < 0) {
          texture = images.length;
          const png = new PNG({ width: 1, height: 1 });
          png.data.fill(255);
          images.push({
            path: '__lattice_white.png',
            bytes: PNG.sync.write(png),
            width: 1,
            height: 1,
          });
        }
        scene.meshes.push({
          ...common,
          kind: 'mesh',
          path,
          uvs: geometry.uvs,
          indices: geometry.indices,
          texture,
          clips: g.list(node, 'clipGuidList').map((n) => g.guid(n)!),
          inverted: g.text(node, 'invertClippingMask') === 'true',
          blend: 'normal',
          culling: false,
        });
      } else if (common.kind === 'part')
        scene.parts.push({
          ...common,
          kind: 'part',
          children: g.list(node, '_childGuids').map((n) => g.guid(n)!),
          drawOrderGroup: g.text(node, 'enableDrawOrderGroup') === 'true',
        });
      else if (common.kind === 'mesh') {
        const image = texture(node),
          uv = g.numbers(node, 'uvs'),
          indices = g.numbers(node, 'indices');
        if (
          uv.length !== common.forms[0].positions.length ||
          uv.length % 2 ||
          indices.length % 3 ||
          indices.some((i) => !Number.isInteger(i) || i < 0 || i >= uv.length / 2)
        )
          throw new Error('Invalid mesh topology or UV coordinates.');
        const [a, b, c, d, e, f] = image.inverse;
        const uvs = uv.map((v, i) =>
          i % 2 ? d * uv[i - 1] + e * v + f : a * v + b * uv[i + 1] + c,
        );
        const blend = g.field(node, 'colorComposition')?.getAttribute('v') || 'NORMAL';
        const modes: Record<string, SourceMesh['blend']> = {
          NORMAL: 'normal',
          ADD: 'add',
          MULTIPLY: 'multiply',
        };
        if (!modes[blend]) throw new Error(`Unsupported blend mode: ${blend}`);
        const extension = g
            .list(node, '_extensions')
            .find((n) => n.tagName === 'CEditableMeshExtension'),
          editable = g.field(extension || null, 'editableMesh');
        let editableEdges = meshConnections(indices);
        if (editable) {
          const pairs = g.numbers(editable, 'edge'),
            priorities = g.numbers(editable, 'edgePriority');
          if (
            pairs.length !== priorities.length * 2 ||
            pairs.some((i) => !Number.isInteger(i) || i < 0 || i >= uv.length / 2) ||
            priorities.some((p) => ![10, 20, 30, 40].includes(p))
          )
            throw new Error('Invalid editable mesh edges.');
          editableEdges = priorities.map((priority, i) => ({
            a: pairs[i * 2],
            b: pairs[i * 2 + 1],
            priority: priority as MeshEdge['priority'],
          }));
        }
        scene.meshes.push({
          ...common,
          kind: 'mesh',
          uvs,
          indices,
          editableEdges,
          texture: image.index,
          clips: g.list(node, 'clipGuidList').map((n) => g.guid(n)!),
          inverted: g.text(node, 'invertClippingMask') === 'true',
          blend: modes[blend],
          culling: g.text(node, 'culling') === 'true',
          controllers: g
            .list(node, '_extensions')
            .filter((e) => e.tagName === 'CControllerExtension')
            .flatMap((e) =>
              g.list(e, 'controlCurves').map((curve) => ({
                guid: g.guid(g.field(curve, 'curveId'))!,
                width: g.number(curve, 'lineWidth', 200),
                hardness: g.number(curve, 'lineHardnessPercent', 50) / 100,
                points: g.list(curve, '_curvePoints').map((cp) => {
                  const binding = g.field(cp, 'pointInTriangle');
                  return {
                    indices: [1, 2, 3].map((i) => g.number(binding, 'ptIndex' + i)) as [
                      number,
                      number,
                      number,
                    ],
                    weights: [1, 2, 3].map((i) => g.number(binding, 'weight' + i)) as [
                      number,
                      number,
                      number,
                    ],
                  };
                }),
              })),
            ),
        });
      } else {
        const columns = g.number(node, 'col'),
          rows = g.number(node, 'row');
        if (
          common.kind === 'warp' &&
          (!Number.isInteger(columns) ||
            !Number.isInteger(rows) ||
            columns < 1 ||
            rows < 1 ||
            common.forms[0].positions.length !== (columns + 1) * (rows + 1) * 2)
        )
          throw new Error('Invalid warp grid dimensions.');
        if (common.kind === 'glue') continue;
        scene.deformers.push({
          ...common,
          kind: common.kind,
          columns,
          rows,
          quad: g.text(node, 'isQuadTransform') === 'true',
          baseAngle: g.number(node, 'baseAngle'),
          handleLength: g.number(node, 'handleLengthOnCanvas', 80),
          bezier: g
            .list(node, '_extensions')
            .filter((n) => n.tagName === 'CWarpDeformerBezierExtension')
            .map((n) => ({
              level: g.number(n, 'editLevel'),
              columns: g.number(n, 'bezierCol'),
              rows: g.number(n, 'bezierRow'),
            })),
        });
      }
    } catch (error) {
      warning(`${metadata.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  scene.glues = g
    .sources('affecterSourceSet')
    .filter((n) => n.tagName === 'CGlueSource')
    .map((node) => {
      const guid = g.guid(g.field(node, 'guid'))!,
        old = reused.get(guid);
      if (old?.kind === 'glue' && !previous!.changed.has(guid)) return old;
      const common = base(node),
        meshA = g.guid(g.field(node, 'targetArtMeshA_guid'))!,
        meshB = g.guid(g.field(node, 'targetArtMeshB_guid'))!;
      const uidList = (id: string) => {
        const mesh = g.sources('drawableSourceSet').find((n) => g.guid(g.field(n, 'guid')) === id),
          ext = g
            .list(mesh || null, '_extensions')
            .find((n) => n.tagName === 'CEditableMeshExtension');
        return g.numbers(g.field(ext || null, 'editableMesh'), 'pointUid');
      };
      const a = uidList(meshA),
        b = uidList(meshB),
        uids = g.numbers(node, 'bindVertexUids'),
        weights = g.numbers(node, 'weights');
      return {
        ...common,
        kind: 'glue' as const,
        meshA,
        meshB,
        pairs: Array.from({ length: uids.length / 2 }, (_, i) => ({
          indexA: a.indexOf(uids[i * 2]),
          indexB: b.indexOf(uids[i * 2 + 1]),
          weightA: weights[i * 2],
          weightB: weights[i * 2 + 1],
        })).filter((p) => p.indexA >= 0 && p.indexB >= 0),
      };
    });
  const deformerIds = new Set(scene.deformers.map((n) => n.guid));
  for (const node of [...scene.meshes, ...scene.deformers]) {
    if (node.deformerGuid && !deformerIds.has(node.deformerGuid))
      throw new Error(`${node.id}: required parent deformer is unavailable.`);
  }
  const supportedMeshIds = new Set(scene.meshes.map((n) => n.guid));
  for (const mesh of scene.meshes)
    if (mesh.clips.some((id) => !supportedMeshIds.has(id)))
      throw new Error(`${mesh.id}: a required clipping mesh is unavailable.`);
  scene.textures = images.map((image) => ({
    url: image.path,
    width: image.width,
    height: image.height,
  }));
  if (
    !scene.meshes.length &&
    document.model.objects.some((o) => o.kind === 'mesh' || o.kind === 'artpath')
  )
    throw new Error(
      scene.warnings.join('\n') || 'The project contains no renderable source meshes.',
    );
  return { scene, images };
}
