import type { Cmo3Document } from './document';
import type { SourceScene, Color } from '../../shared/scene';
import { OperationError, resolvePose, type KeyformBatch } from '../../shared/workflow';
import { ModelEvaluator } from '../model/evaluate';
import type { EvaluatedDeformer, EvaluatedMesh } from '../model/evaluate';
import { formDepth, formNodes } from '../model/form-edit';
import { inversePoint, keyformAt, locked } from '../model/selection';
import { writeFormScene } from './form-edit';
import { inspectObjects } from './inspector';
import { XmlEdit } from './edit';

/** Author explicit existing keyforms without moving the editor's preview pose. */
export function editKeyformBatch(document: Cmo3Document, scene: SourceScene, frames: KeyformBatch) {
  const after = structuredClone(scene);
  const nodes = new Map(formNodes(after).map((n) => [n.guid, n]));
  const objects = new Map(document.model.objects.map((o) => [o.guid, o]));
  const touched = new Set<string>();
  const evaluator = new ModelEvaluator(after);
  for (const [frameIndex, frame] of frames.entries()) {
    let parameters: Record<string, number>;
    try {
      parameters = resolvePose(scene.parameters, frame.parameters);
    } catch (error) {
      if (error instanceof OperationError) error.details.frameIndex = frameIndex;
      throw error;
    }
    const guids = new Set<string>();
    for (const edit of frame.edits) {
      const node = nodes.get(edit.guid);
      const fail = (code: string, message: string): never => {
        throw new OperationError(code, message, {
          frameIndex,
          guid: edit.guid,
          parameters: frame.parameters,
        });
      };
      if (!node) fail('OBJECT_NOT_FOUND', `Unknown editable object ${edit.guid}.`);
      if (guids.has(edit.guid))
        fail('DUPLICATE_KEYFORM', 'An object occurs twice in the same pose.');
      guids.add(edit.guid);
      if (locked(objects, edit.guid))
        fail('OBJECT_LOCKED', `${node!.id}: Object or parent is locked.`);
      const source = new XmlEdit(document.graph).source(edit.guid);
      if (
        document.graph.list(document.graph.field(source, 'keyformMorphTargetSet'), '_morphTargets')
          .length
      )
        fail('UNSUPPORTED_FORM', 'Batch editing supports normal keyform grids only.');
      if (
        document.graph
          .list(document.graph.field(source, 'keyformGridSource'), 'keyformBindings')
          .some(
            (binding) =>
              !['LINEAR', ''].includes(
                document.graph.field(binding, 'extendedInterpolationType')?.getAttribute('v') ||
                  'LINEAR',
              ),
          )
      )
        fail('UNSUPPORTED_FORM', 'Extended interpolation is not supported by batch editing.');
      const form = keyformAt(node!, parameters);
      if (!form)
        fail('KEYFORM_MISSING', `${node!.id}: Create parameter keys before editing this pose.`);
      const key = `${edit.guid}:${form!.guid}`;
      if (touched.has(key))
        fail('DUPLICATE_KEYFORM', `${node!.id}: Several poses resolve to the same keyform.`);
      touched.add(key);
      if (edit.points && !['mesh', 'warp'].includes(node!.kind))
        fail('UNSUPPORTED_FORM', 'Vertex editing requires a mesh, ArtPath or warp.');
      if (edit.rotation && !form!.rotation)
        fail('UNSUPPORTED_FORM', 'Rotation fields require a rotation deformer.');
    }
    const appearanceEdits = frame.edits.filter((edit) => edit.appearance);
    const properties = new Map(
      inspectObjects(
        document,
        scene,
        appearanceEdits.map((edit) => edit.guid),
        parameters,
      ).map((info) => [info.guid, info.values]),
    );
    for (const edit of appearanceEdits) {
      const supported = properties.get(edit.guid)!;
      for (const field of Object.keys(edit.appearance || {}))
        if (!(field in supported))
          throw new OperationError(
            'UNSUPPORTED_FORM',
            `${nodes.get(edit.guid)!.id}: ${field} is not supported.`,
            { frameIndex, guid: edit.guid },
          );
    }
    // Parent changes must be evaluated before converting child canvas coordinates.
    const ordered = [...frame.edits].sort(
      (a, b) => formDepth(nodes.get(a.guid)!, nodes) - formDepth(nodes.get(b.guid)!, nodes),
    );
    let evaluatedDepth = -1;
    let evaluatedNodes = new Map<string, EvaluatedMesh | EvaluatedDeformer>();
    for (const edit of ordered) {
      const node = nodes.get(edit.guid)!,
        form = keyformAt(node, parameters)!;
      if (edit.rotation)
        Object.assign(
          form.rotation!,
          Object.fromEntries(
            Object.entries(edit.rotation).map(([key, value]) => [key, Math.fround(value!)]),
          ),
        );
      if (edit.points) {
        const depth = formDepth(node, nodes);
        if (edit.space !== 'local' && depth !== evaluatedDepth) {
          const meshes = evaluator.evaluate(parameters);
          evaluatedNodes = new Map(
            [...meshes, ...evaluator.evaluatedDeformers].map((n) => [n.source.guid, n]),
          );
          evaluatedDepth = depth;
        }
        const evaluated = evaluatedNodes.get(edit.guid)!;
        const indices = new Set<number>();
        for (const p of edit.points) {
          if (p.index >= form.positions.length / 2 || indices.has(p.index))
            throw new OperationError('INVALID_VERTEX', 'Invalid or duplicated vertex index.', {
              frameIndex,
              guid: edit.guid,
              index: p.index,
            });
          indices.add(p.index);
          const i = p.index * 2;
          let local: number[];
          try {
            local =
              edit.space === 'local'
                ? [p.x, p.y]
                : inversePoint(
                    evaluated.toCanvas,
                    [p.x, p.y],
                    [form.positions[i], form.positions[i + 1]],
                  );
          } catch (error) {
            throw new OperationError(
              'INVALID_TRANSFORM',
              error instanceof Error ? error.message : String(error),
              { frameIndex, guid: edit.guid, index: p.index },
            );
          }
          form.positions[i] = Math.fround(local[0]);
          form.positions[i + 1] = Math.fround(local[1]);
        }
      }
      if (edit.appearance) {
        const { opacity, drawOrder, multiply, screen } = edit.appearance;
        if (opacity !== undefined) form.opacity = Math.fround(opacity);
        if (drawOrder !== undefined) form.drawOrder = drawOrder;
        for (const [key, color] of [
          ['multiply', multiply],
          ['screen', screen],
        ] as const)
          if (color)
            form[key] = [
              ...[1, 3, 5].map((i) => Math.fround(parseInt(color.slice(i, i + 2), 16) / 255)),
              1,
            ] as Color;
      }
    }
  }
  return writeFormScene(document, scene, after);
}
