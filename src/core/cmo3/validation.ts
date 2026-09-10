import type { Cmo3Document } from './document';
import { readSourceScene } from './scene';
import { readAtlasWorkspace } from './atlas';
import { ModelEvaluator } from '../model/evaluate';
import { resolvePose } from '../../shared/workflow';
import { ROOT_DEFORMER } from './edit';
import { physicsIssues } from './physics';

export interface ModelIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  guid?: string;
  formGuid?: string;
  reference?: string;
  frameIndex?: number;
}

/** Check serialized native structure independently of Lattice's permissive class lookup. */
export function validateNativeDocument(document: Cmo3Document): ModelIssue[] {
  const issues: ModelIssue[] = [],
    g = document.graph;
  const issue = (code: string, message: string, extra: Partial<ModelIssue> = {}) =>
    issues.push({ severity: 'error', code, message, ...extra });
  const imports = Array.from(g.document.childNodes)
    .filter((n) => n.nodeType === 7 && n.nodeName === 'import')
    .map((n) => n.nodeValue || '');
  const names = new Set(imports.map((p) => p.split(/[.$]/).at(-1)));
  const missingTypes = new Set<string>();
  const ids = new Set(g.elements.map((n) => n.getAttribute('xs.id')).filter(Boolean));
  const files = new Set(document.archive.entries.map((e) => e.path));
  const shared = g.document.getElementsByTagName('shared')[0];
  for (const n of g.elements) {
    if (/^[A-Z]/.test(n.tagName) && !names.has(n.tagName)) missingTypes.add(n.tagName);
    const ref = n.getAttribute('xs.ref'),
      id = n.getAttribute('xs.id');
    if (ref && !ids.has(ref))
      issue('BROKEN_XML_REFERENCE', `Unresolved XML reference ${ref}.`, { reference: ref });
    if (id && n.parentNode !== shared)
      issue('INLINE_SHARED_OBJECT', `Shared object ${id} is not registered at root/shared.`, {
        reference: id,
      });
    if (n.tagName === 'file' && n.hasAttribute('path') && !files.has(n.getAttribute('path')!))
      issue('MISSING_RESOURCE', `Archive resource ${n.getAttribute('path')} is missing.`, {
        reference: n.getAttribute('path') || '',
      });
    if (/^(float|double|int)-array$/.test(n.tagName)) {
      const text = n.textContent?.trim() || '',
        values = text ? text.split(/\s+/).map(Number) : [];
      if (
        !ref &&
        (values.some((v) => !Number.isFinite(v)) ||
          (n.hasAttribute('count') && values.length !== Number(n.getAttribute('count'))))
      )
        issue('INVALID_NUMERIC_ARRAY', `Invalid ${n.tagName} length or non-finite value.`, {
          reference: id || n.getAttribute('xs.n') || undefined,
        });
    }
  }
  for (const name of missingTypes)
    issue('MISSING_TYPE_IMPORT', `Native XML type ${name} has no import declaration.`, {
      reference: name,
    });
  const registry = imports.indexOf('com.live2d.graphics.psd.blend.ACBlend');
  if (
    imports.some(
      (p, i) =>
        p.startsWith('com.live2d.graphics.psd.blend.CBlend_') && (registry < 0 || i < registry),
    )
  )
    issue('INVALID_IMPORT_ORDER', 'Declare ACBlend before its concrete PSD blend modes.');
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  for (const object of objects.values())
    for (const field of ['parentGuid', 'deformerGuid'] as const) {
      const seen = new Set<string>([object.guid]);
      let parent = object[field];
      while (
        parent &&
        parent !== ROOT_DEFORMER &&
        parent !== '00000000-0000-0000-0000-000000000000'
      ) {
        if (seen.has(parent)) {
          issue('HIERARCHY_CYCLE', `${object.id}: Cyclic ${field}.`, { guid: object.guid });
          break;
        }
        seen.add(parent);
        const next = objects.get(parent);
        if (!next) {
          issue('MISSING_PARENT', `${object.id}: Missing ${field}.`, {
            guid: object.guid,
            reference: parent,
          });
          break;
        }
        parent = next[field];
      }
    }
  issues.push(...physicsIssues(document.model.physics, document.model.parameters));
  return issues;
}

export function validateModel(
  document: Cmo3Document,
  options: { poses: Record<string, number>[]; requireAtlas: boolean },
) {
  const issues = validateNativeDocument(document);
  const add = (code: string, message: string, extra: Partial<ModelIssue> = {}) =>
    issues.push({ severity: 'warning', code, message, ...extra });
  let checkedPoses = 0;
  if (!issues.some((i) => i.severity === 'error')) {
    try {
      const { scene } = readSourceScene(document);
      scene.warnings.forEach((message) => add('UNSUPPORTED_SOURCE', message));
      const parameters = new Map(scene.parameters.map((p) => [p.id, p]));
      for (const node of [
        ...scene.parts,
        ...scene.meshes,
        ...scene.deformers,
        ...(scene.glues || []),
      ]) {
        const count = node.bindings.reduce((n, b) => n * b.keys.length, 1),
          keys = new Set<string>();
        for (const b of node.bindings)
          if (!parameters.has(b.parameterId))
            add('MISSING_PARAMETER', `${node.id}: Bound parameter is missing.`, {
              guid: node.guid,
              severity: 'error',
              reference: b.parameterId,
            });
        for (const f of node.forms) {
          const key = f.keys.join(',');
          if (
            keys.has(key) ||
            f.keys.length !== node.bindings.length ||
            f.keys.some(
              (k, i) => k < 0 || !Number.isInteger(k) || k >= node.bindings[i].keys.length,
            )
          )
            add('INVALID_KEYFORM_GRID', `${node.id}: Duplicate or invalid keyform coordinates.`, {
              guid: node.guid,
              formGuid: f.guid,
              severity: 'error',
            });
          keys.add(key);
          const numbers = [
            ...f.positions,
            f.opacity,
            f.drawOrder,
            ...f.multiply,
            ...f.screen,
            ...(f.rotation ? [f.rotation.x, f.rotation.y, f.rotation.angle, f.rotation.scale] : []),
          ];
          if (numbers.some((n) => !Number.isFinite(n)))
            add('NON_FINITE_FORM', `${node.id}: Non-finite keyform data.`, {
              guid: node.guid,
              formGuid: f.guid,
              severity: 'error',
            });
        }
        if (node.forms.length !== count)
          add(
            'INCOMPLETE_KEYFORM_GRID',
            `${node.id}: Expected ${count} keyforms, found ${node.forms.length}.`,
            { guid: node.guid, severity: 'error' },
          );
      }
      for (const mesh of scene.meshes)
        if (
          !mesh.path &&
          (mesh.indices.length % 3 ||
            mesh.indices.some((i) => i < 0 || !Number.isInteger(i) || i >= mesh.uvs.length / 2) ||
            mesh.forms.some((f) => f.positions.length !== mesh.uvs.length))
        )
          add('INVALID_TOPOLOGY', `${mesh.id}: Mesh vertices, UVs and triangles disagree.`, {
            guid: mesh.guid,
            severity: 'error',
          });
      const atlas = readAtlasWorkspace(document, () => '');
      for (const image of atlas.unassigned)
        if (image.meshGuids.length)
          add('UNASSIGNED_TEXTURE', `${image.name}: Model image is not assigned to an atlas.`, {
            reference: image.guid,
            severity: options.requireAtlas ? 'error' : 'warning',
          });
      for (const p of document.model.parameters)
        if (!Object.keys(p.bindings).length)
          add('UNBOUND_PARAMETER', `${p.id}: No objects are bound.`, { guid: p.guid });
      if (!issues.some((i) => i.severity === 'error')) {
        const evaluator = new ModelEvaluator(scene),
          neutral = evaluator.evaluate({});
        const base = new Map(neutral.map((m) => [m.source.guid, m]));
        for (const [frameIndex, pose] of [{}, ...options.poses].entries()) {
          const meshes = evaluator.evaluate(resolvePose(scene.parameters, pose));
          checkedPoses++;
          for (const mesh of meshes) {
            if (mesh.positions.some((p) => !Number.isFinite(p) || Math.abs(p) > 1e7))
              add('INVALID_EVALUATED_GEOMETRY', `${mesh.source.id}: Invalid evaluated position.`, {
                guid: mesh.source.guid,
                frameIndex,
                severity: 'error',
              });
            const b = base.get(mesh.source.guid)!,
              ids = mesh.source.indices;
            const area = (p: ArrayLike<number>, a: number, b: number, c: number) =>
              (p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) -
              (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2]);
            let flipped = 0;
            for (let i = 0; i < ids.length; i += 3) {
              const a = area(b.positions, ids[i], ids[i + 1], ids[i + 2]),
                v = area(mesh.positions, ids[i], ids[i + 1], ids[i + 2]);
              if (Math.abs(a) > 0.001 && a * v < -0.000001) flipped++;
            }
            if (flipped)
              add(
                'FLIPPED_TRIANGLES',
                `${mesh.source.id}: ${flipped} triangles change orientation from the default pose.`,
                { guid: mesh.source.guid, frameIndex },
              );
          }
        }
      }
    } catch (error) {
      add('EVALUATION_FAILED', error instanceof Error ? error.message : String(error), {
        severity: 'error',
      });
    }
  }
  return {
    valid: !issues.some((i) => i.severity === 'error'),
    nativeEditorVerified: false,
    checkedPoses,
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}
