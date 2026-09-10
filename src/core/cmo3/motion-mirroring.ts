import { MotionMirroringError, type MotionMirroring } from '../../shared/motion-mirroring';
import type { Cmo3Document } from './document';
import { readSourceScene } from './scene';
import { XmlEdit } from './edit';
import { editParameterKeys } from './parameter-keys';
import { writeFormScene } from './form-edit';
import {
  mirrorMotionScene,
  motionMirrorCenter,
  motionMirroringPlan,
} from '../model/motion-mirroring';

/** Runs inside one document transaction, including any newly inserted grid keys. */
export function mirrorNativeMotion(
  document: Cmo3Document,
  value: MotionMirroring,
  values: Record<string, number>,
) {
  const scene = readSourceScene(document).scene;
  const plan = motionMirroringPlan(document.model, scene, value.guids, value.parameterId, values);
  const e = new XmlEdit(document.graph);
  for (const node of plan.nodes) {
    if (e.g.list(e.g.field(e.source(node.guid), 'keyformMorphTargetSet'), '_morphTargets').length)
      throw new MotionMirroringError('motionBlendShape', node.id);
  }
  const center = plan.nodes.some((n) => n.kind === 'mesh')
    ? motionMirrorCenter(document.model, scene, value, plan.sourceValues)
    : 0;
  for (const node of plan.nodes) {
    const binding = node.bindings.find((b) => b.parameterId === value.parameterId)!;
    if (binding.keys.some((k) => Math.abs(k - plan.targetValue) < 1e-6)) continue;
    editParameterKeys(
      document,
      [node.guid],
      [
        {
          parameterGuid: plan.parameter.guid,
          keys: [
            ...binding.keys.map((k) => ({ value: k, previous: k })),
            { value: plan.targetValue },
          ],
        },
      ],
      plan.sourceValues,
    );
  }
  const before = readSourceScene(document).scene;
  writeFormScene(document, before, mirrorMotionScene(before, value, plan.sourceValues, center));
}
