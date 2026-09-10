import { editAtlases, readAtlasWorkspace } from './cmo3/atlas';
import { writePhysics, physicsIssues } from './cmo3/physics';
import {
  applyPhysicsEdits,
  duplicatePhysicsGroup,
  physicsSimulationSchema,
} from '../shared/physics';
import { exportPhysics3, importPhysics3 } from './physics/format';
import { PhysicsRuntime } from './physics/runtime';
import { physicsPresets } from '../shared/physics-presets';
import { visibleAtlasImages, type AtlasImage } from '../shared/atlas';
import { autoLayoutAtlas } from '../shared/atlas-layout';
import { EventEmitter } from 'node:events';
import { resolve, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Cmo3Document } from './cmo3/document';
import { atomicWrite, readBounded } from './files';
import { SourceAssets } from './source-assets';
import { commandSchema } from '../shared/commands';
import type { EditorState, Locale, VertexEdit } from '../shared/types';
import { ModelEvaluator } from './model/evaluate';
import { DeformationStroke, selectPointRegion, validateBrushStroke } from './model/brush';
import {
  modelingPoints,
  groupVertexEdits,
  changedVertexEdits,
  pointTriangles,
} from './model/modeling-points';
import { applyMatrix, inversePoint, keyformAt, locked, identityMatrix } from './model/selection';
import { createDeformer, editRotation } from './cmo3/deformers';
import { setGlue, removeGlue, editGlueWeights } from './cmo3/glue';
import { createArtPath } from './cmo3/artpath';
import { createController } from './cmo3/controller';
import { editTopology, automaticMesh } from './cmo3/topology';
import {
  createParameter,
  editParameter,
  createParameterGroup,
  renameParameterGroup,
  moveParameterEntries,
  removeParameterEntries,
  linkParameter,
  setParameterDefaults,
} from './cmo3/parameters';
import { editParameterKeys } from './cmo3/parameter-keys';
import { parameterDescendants } from '../shared/parameters';
import { inspectObjects, editObjectProperties } from './cmo3/inspector';
import { setObjectFlags, moveDeformerObjects, pruneEmptyDeformers } from './cmo3/tree';
import { createPart, movePartObjects, deletePartObjects, pruneEmptyParts } from './cmo3/parts';
import { editProjectResource, deleteProjectImages, projectImageBytes } from './cmo3/project';
import { createMeshesFromImages, assignModelImage, setTextureMode } from './cmo3/image-mesh';
import { newModel } from './cmo3/new-model';
import { importPsd } from './cmo3/import-psd';
import { stat } from 'node:fs/promises';
import { applyFields, captureFields, type FieldPatch } from './cmo3/field-edit';
import type { FormClipboard } from '../shared/form-edit';
import { copyForms } from './model/form-edit';
import { editNativeForms } from './cmo3/form-edit';
import { updateOriginalForms } from './cmo3/original-forms';
import { readSourceScene } from './cmo3/scene';
import { mirrorNativeMotion } from './cmo3/motion-mirroring';
import { motionMirroringPlan } from './model/motion-mirroring';
import { editKeyformBatch } from './cmo3/keyform-batch';
import { validateModel, validateNativeDocument } from './cmo3/validation';
import {
  editorStatus,
  geometryQuerySchema,
  sceneQuerySchema,
  resolvePose,
  OperationError,
  assertRevision,
  type GeometryQuery,
} from '../shared/workflow';
import { related, boundsOf } from './model/selection';

type PositionEdit = { guid: string; formGuid: string; before: string; after: string };
type ParameterValueEdit = {
  kind: 'parameters';
  changes: { guid: string; before: number; after: number }[];
};
type DocumentEditContext = {
  parameterValuesBefore: Record<string, number>;
  selectionBefore: string[];
  selectionAfter: string[];
  projectBefore: string[];
  projectAfter: string[];
  targetBefore: EditorState['inspectorTarget'];
  targetAfter: EditorState['inspectorTarget'];
};
type EditorEdit =
  | ParameterValueEdit
  | { kind: 'name'; guid: string; before: string; after: string }
  | { kind: 'positions'; changes: PositionEdit[] }
  | (DocumentEditContext & {
      kind: 'fields';
      patches: FieldPatch[];
      sceneChanged: boolean | string[];
      resourcesChanged: boolean;
    })
  | {
      kind: 'archive';
      before: Buffer;
      after: Buffer;
      selectionBefore: string[];
      selectionAfter: string[];
      projectBefore: string[];
      projectAfter: string[];
      targetBefore: EditorState['inspectorTarget'];
      targetAfter: EditorState['inspectorTarget'];
    }
  | {
      kind: 'structure';
      before: string;
      after: string;
      parameterValuesBefore: Record<string, number>;
      parameterValuesAfter?: Record<string, number>;
      selectionBefore: string[];
      selectionAfter: string[];
      projectBefore: string[];
      projectAfter: string[];
      targetBefore: EditorState['inspectorTarget'];
      targetAfter: EditorState['inspectorTarget'];
    };

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const defaultParameterPanel = () => ({
  selection: [] as string[],
  collapsed: [] as string[],
  onlyActive: false,
  dragLocked: true,
  snap: true,
});
export const defaultView = () => ({
  zoom: 1,
  panX: 0,
  panY: 0,
  grid: false,
  mesh: false,
  background: 'checker' as const,
  tool: 'select' as const,
  editLevel: 2 as const,
});

export class Editor extends EventEmitter {
  private source: Cmo3Document | null = null;
  private dirtySource: Cmo3Document | null = null;
  private documentChanged = false;
  private fieldDirty: boolean | undefined;
  assets: SourceAssets | null = null;
  private diskHash = '';
  private history: EditorEdit[] = [];
  private historyIndex = 0;
  private parameterEdit: { id: string; edit: ParameterValueEdit } | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private state: EditorState;
  private copiedForms: FormClipboard = { serial: 0, items: [] };

  constructor(
    settings: { locale?: Locale; recentFiles?: string[]; sampleAvailable?: boolean } = {},
  ) {
    super();
    this.state = {
      revision: 0,
      documentRevision: 0,
      document: null,
      preview: null,
      previewReady: false,
      previewError: null,
      selectedGuid: null,
      selectedGuids: [],
      pointSelection: {},
      formClipboard: { serial: 0, items: [] },
      toolSettings: {
        size: 100,
        hardness: 0.3,
        strength: 1,
        shape: 'circle',
        angle: 0,
        brushMode: 'move',
        pathWidth: 10,
        pathColor: '#25252b',
      },
      parameterValues: {},
      parameterPanel: defaultParameterPanel(),
      inspector: [],
      project: null,
      projectSelection: [],
      inspectorTarget: 'objects',
      dirty: false,
      canUndo: false,
      canRedo: false,
      view: defaultView(),
      locale: settings.locale || 'zh-CN',
      recentFiles: settings.recentFiles || [],
      sampleAvailable: settings.sampleAvailable ?? false,
      log: [],
      bridge: { connected: false, port: null },
    };
  }

  snapshot(): EditorState {
    return structuredClone(this.state);
  }
  status() {
    return structuredClone(editorStatus(this.state));
  }
  async idle() {
    await this.pending;
  }
  sceneInfo(raw: unknown = {}) {
    const query = sceneQuerySchema.parse(raw),
      state = this.state;
    const selected = this.queryObjects(query.guids);
    const document = state.document && {
      ...editorStatus(state).document,
      formatVersion: state.document.formatVersion,
      guides: state.document.guides,
      rootPartGuid: state.document.rootPartGuid,
      rootParameterGroupGuid: state.document.rootParameterGroupGuid,
      ...(query.include.includes('objects')
        ? { objects: state.document.objects.filter((o) => selected.has(o.guid)) }
        : {}),
      ...(query.include.includes('parameters')
        ? { parameters: state.document.parameters, parameterGroups: state.document.parameterGroups }
        : {}),
    };
    return structuredClone({
      ...editorStatus(state),
      document,
      preview: state.preview,
      ...(query.include.includes('view') ? { view: state.view } : {}),
      ...(query.include.includes('project')
        ? { project: state.project, projectSelection: state.projectSelection }
        : {}),
      ...(query.include.includes('log') ? { log: state.log } : {}),
    });
  }
  private queryObjects(guids?: string[]) {
    const objects = new Map(this.state.document?.objects.map((o) => [o.guid, o]) || []);
    for (const guid of guids || [])
      if (!objects.has(guid))
        throw new OperationError('OBJECT_NOT_FOUND', `Unknown object ${guid}.`, { guid });
    return new Set(
      [...objects.keys()].filter(
        (id) => !guids || guids.some((guid) => related(objects, id, guid)),
      ),
    );
  }
  queryGeometry(raw: GeometryQuery = {}) {
    const query = geometryQuerySchema.parse(raw),
      selected = this.queryObjects(query.guids);
    if (!this.assets) throw new OperationError('NO_PROJECT', 'No source model is open.');
    const parameters =
      query.parameters === undefined
        ? this.state.parameterValues
        : resolvePose(this.assets.scene.parameters, query.parameters);
    const data = this.geometry(parameters, selected);
    const project = (node: (typeof data.meshes)[number] | (typeof data.deformers)[number]) => {
      const fields: Record<string, unknown> = { guid: node.guid, bounds: boundsOf(node.positions) };
      if ('id' in node) fields.id = node.id;
      else {
        fields.kind = node.kind;
        fields.columns = node.columns;
        fields.rows = node.rows;
      }
      if (query.fields.includes('positions')) fields.positions = node.positions;
      if (query.fields.includes('forms'))
        Object.assign(
          fields,
          'form' in node ? { form: node.form } : { editableForm: node.editableForm },
        );
      if (query.fields.includes('topology') && 'uvs' in node)
        Object.assign(fields, { uvs: node.uvs, indices: node.indices, edges: node.edges });
      if (query.fields.includes('controllers') && 'controllers' in node)
        fields.controllers = node.controllers;
      if (query.fields.includes('appearance') && 'visible' in node)
        Object.assign(fields, {
          visible: node.visible,
          opacity: node.opacity,
          drawOrder: node.drawOrder,
        });
      return fields;
    };
    return {
      revision: data.revision,
      parameters: { ...parameters },
      meshes: data.meshes.filter((m) => selected.has(m.guid)).map(project),
      deformers: data.deformers.filter((d) => selected.has(d.guid)).map(project),
      ...(query.fields.includes('controllers') ? { glues: data.glues } : {}),
    };
  }
  validate(options: { poses: Record<string, number>[]; requireAtlas: boolean }) {
    if (!this.source) throw new OperationError('NO_PROJECT', 'No project is open.');
    return {
      revision: this.state.revision,
      ...validateModel(new Cmo3Document(this.source.serialize(), this.source.model.path), options),
    };
  }
  formClipboard(): FormClipboard {
    return structuredClone(this.copiedForms);
  }
  inspect(guids: string[]) {
    if (!this.source || !this.assets) throw new Error('No project is open.');
    return {
      revision: this.state.revision,
      objects: inspectObjects(
        this.source,
        this.assets.scene,
        guids,
        this.state.parameterValues,
      ).map((info) => ({
        ...this.source!.model.objects.find((o) => o.guid === info.guid),
        ...info,
      })),
    };
  }
  atlasInfo() {
    if (!this.source) throw new Error('No project is open.');
    const workspace = readAtlasWorkspace(this.source, () => '');
    const visible = visibleAtlasImages(
      [...workspace.atlases.flatMap((a) => a.items), ...workspace.unassigned],
      this.source.model.objects,
    );
    const info = <T extends AtlasImage>({ url, ...image }: T) => ({
      ...image,
      visible: visible.has(image.guid),
    });
    return {
      revision: this.state.revision,
      atlases: workspace.atlases.map((a) => ({
        ...a,
        items: a.items.map(info),
      })),
      unassigned: workspace.unassigned.map(info),
    };
  }
  geometry(parameters = this.state.parameterValues, guids?: Set<string>) {
    if (!this.assets) throw new Error('The source preview is not ready.');
    const evaluator = new ModelEvaluator(this.assets.scene),
      meshes = evaluator.evaluate(parameters);
    return {
      revision: this.state.revision,
      meshes: meshes
        .filter((m) => !guids || guids.has(m.source.guid))
        .map((m) => ({
          guid: m.source.guid,
          id: m.source.id,
          positions: [...(m.controlPositions || m.positions)],
          uvs: m.source.uvs,
          indices: m.source.indices,
          edges: m.source.editableEdges,
          controllers: m.source.controllers,
          visible: m.visible,
          opacity: m.opacity,
          drawOrder: m.drawOrder,
          editableForm: keyformAt(m.source, parameters)?.guid || null,
        })),
      deformers: evaluator.evaluatedDeformers
        .filter((d) => !guids || guids.has(d.source.guid))
        .map((d) => ({
          guid: d.source.guid,
          kind: d.source.kind,
          positions: [...d.positions],
          columns: d.source.columns,
          rows: d.source.rows,
          form: keyformAt(d.source, parameters),
        })),
      glues: this.assets.scene.glues?.filter(
        (g) => !guids || guids.has(g.guid) || guids.has(g.meshA) || guids.has(g.meshB),
      ),
    };
  }
  private publish(updateInspector = true) {
    this.state.project = this.assets?.project || null;
    const keys = new Set(this.state.project?.resources.map((r) => r.key));
    this.state.projectSelection = this.state.projectSelection.filter((key) => keys.has(key));
    if (!this.state.projectSelection.length) this.state.inspectorTarget = 'objects';
    if (updateInspector)
      this.state.inspector =
        this.source && this.assets ? this.inspect(this.state.selectedGuids).objects : [];
    // Preview, selection and view commands do not change the native document.
    // Check content only after a document edit or a replacement (open/save/undo).
    if (this.source !== this.dirtySource || this.documentChanged) {
      this.state.documentRevision++;
      this.state.dirty = this.fieldDirty ?? (this.source?.dirty || false);
      this.fieldDirty = undefined;
      this.dirtySource = this.source;
      this.documentChanged = false;
    }
    const changingParameters = this.parameterEdit?.edit.changes.some((c) => c.before !== c.after);
    this.state.canUndo = !!changingParameters || this.historyIndex > 0;
    this.state.canRedo = !changingParameters && this.historyIndex < this.history.length;
    this.state.revision++;
    this.emit('change', this.snapshot());
  }
  private log(message: string) {
    this.state.log = [...this.state.log.slice(-99), { time: new Date().toISOString(), message }];
  }
  setBridge(port: number | null) {
    this.state.bridge = { connected: port !== null, port };
    this.publish();
  }
  previewReady(id: string, error: string | null) {
    if (id !== this.state.preview?.id) return;
    this.state.previewReady = !error;
    this.state.previewError = error;
    if (error) this.log(error);
    this.publish();
  }
  private requireClean(confirmedRevision?: number) {
    if (this.state.dirty && confirmedRevision === undefined)
      throw new Error('Save the current project before opening or closing it.');
  }
  physicsInfo() {
    if (!this.source) throw new Error('Open a model first.');
    return {
      revision: this.state.revision,
      settings: this.source.model.physics,
      parameters: this.source.model.parameters.map(
        ({ id, name, min, max, default: defaultValue, keys }) => ({
          id,
          name,
          min,
          max,
          default: defaultValue,
          keys,
        }),
      ),
      presets: physicsPresets,
      issues: physicsIssues(this.source.model.physics, this.source.model.parameters),
    };
  }
  simulatePhysics(raw: unknown) {
    if (!this.source) throw new Error('Open a model first.');
    const options = physicsSimulationSchema.parse(raw),
      model = this.source.model;
    const errors = physicsIssues(model.physics, model.parameters).filter(
      (i) => i.severity === 'error',
    );
    if (errors.length) throw new Error(errors.map((i) => i.message).join('\n'));
    const runtime = new PhysicsRuntime(model.physics, model.parameters);
    runtime.disabled = new Set(options.disabledGroups);
    for (const guid of runtime.disabled)
      if (!model.physics.groups.some((g) => g.guid === guid))
        throw new Error(`Unknown physics group: ${guid}`);
    const defaults = Object.fromEntries(model.parameters.map((p) => [p.id, p.default]));
    const samples: { time: number; parameters: Record<string, number> }[] = [];
    let elapsed = 0,
      nextSample = 0;
    for (const frame of options.frames) {
      for (const [id, value] of Object.entries(frame.parameters)) {
        const p = model.parameters.find((p) => p.id === id);
        if (!p || value < p.min || value > p.max)
          throw new Error(`Invalid physics input parameter: ${id}`);
      }
      const values = { ...defaults, ...frame.parameters };
      const steps = Math.ceil(frame.duration * Math.max(model.physics.fps, options.sampleFps));
      for (let i = 0; i < steps; i++) {
        const pose = runtime.advance(frame.duration / steps, values);
        elapsed += frame.duration / steps;
        if (elapsed + 1e-8 >= nextSample) {
          samples.push({ time: elapsed, parameters: pose });
          nextSample = elapsed + 1 / options.sampleFps;
        }
      }
    }
    return {
      revision: this.state.revision,
      duration: elapsed,
      samples,
      peaks: runtime.peaks,
      groups: runtime.snapshot(),
    };
  }
  private applyEdit(
    edit: EditorEdit,
    direction: 'before' | 'after',
    prepared?: { source: Cmo3Document; assets: SourceAssets },
  ) {
    if (edit.kind === 'parameters') {
      const parameters = new Map(this.state.document?.parameters.map((p) => [p.guid, p]));
      for (const change of edit.changes) {
        const parameter = parameters.get(change.guid)!;
        this.state.parameterValues[parameter.id] = change[direction];
      }
    } else if (edit.kind === 'name') {
      const patches = captureFields(this.source!.graph, () =>
        this.source!.rename(edit.guid, edit[direction]),
      );
      this.fieldDirty = this.source!.dirtyAfterFields(patches);
    } else if (edit.kind === 'structure' || edit.kind === 'archive' || edit.kind === 'fields') {
      let source: Cmo3Document, assets: SourceAssets;
      if (prepared) ({ source, assets } = prepared);
      else if (edit.kind === 'fields') {
        source = this.source!;
        applyFields(source.graph, edit.patches, direction);
        try {
          source.refreshModel();
          assets = new SourceAssets(source, this.assets, edit.sceneChanged, edit.resourcesChanged);
        } catch (error) {
          applyFields(source.graph, edit.patches, direction === 'before' ? 'after' : 'before');
          source.refreshModel();
          throw error;
        }
      } else {
        source =
          edit.kind === 'structure'
            ? this.source!.withXml(edit[direction])
            : this.source!.withArchive(edit[direction]);
        assets = new SourceAssets(source, this.assets);
      }
      if (edit.kind === 'fields') this.fieldDirty = source.dirtyAfterFields(edit.patches);
      this.source = source;
      this.assets = assets;
      const oldValues = new Map(
        this.state.document?.parameters.map((p) => [p.guid, this.state.parameterValues[p.id]]),
      );
      const restoredValues =
        direction === 'before'
          ? edit.kind === 'structure' || edit.kind === 'fields'
            ? edit.parameterValuesBefore
            : {}
          : edit.kind === 'structure'
            ? edit.parameterValuesAfter || {}
            : {};
      this.state.document = source.model;
      this.state.parameterValues = Object.fromEntries(
        source.model.parameters.map((p) => [
          p.id,
          Math.max(
            p.min,
            Math.min(p.max, restoredValues[p.guid] ?? oldValues.get(p.guid) ?? p.default),
          ),
        ]),
      );
      const entries = new Set(
        [...source.model.parameters, ...source.model.parameterGroups].map((p) => p.guid),
      );
      this.state.parameterPanel.selection = this.state.parameterPanel.selection.filter((id) =>
        entries.has(id),
      );
      this.state.parameterPanel.collapsed = this.state.parameterPanel.collapsed.filter((id) =>
        entries.has(id),
      );
      this.state.preview = assets.descriptor;
      const ids = edit[direction === 'before' ? 'selectionBefore' : 'selectionAfter'].filter((id) =>
        source.model.objects.some((o) => o.guid === id),
      );
      this.state.selectedGuids = ids;
      this.state.selectedGuid = ids.at(-1) || null;
      this.state.projectSelection = [
        ...edit[direction === 'before' ? 'projectBefore' : 'projectAfter'],
      ];
      this.state.inspectorTarget = edit[direction === 'before' ? 'targetBefore' : 'targetAfter'];
      if (edit.kind !== 'fields') this.state.pointSelection = {};
      else {
        const counts = new Map(
          [...assets.scene.meshes, ...assets.scene.deformers].map((node) => [
            node.guid,
            node.forms[0].positions.length / 2,
          ]),
        );
        this.state.pointSelection = Object.fromEntries(
          Object.entries(this.state.pointSelection)
            .filter(([guid]) => counts.has(guid))
            .map(([guid, points]) => [
              guid,
              Object.fromEntries(
                Object.entries(points).filter(([index]) => Number(index) < counts.get(guid)!),
              ),
            ]),
        );
      }
    } else {
      const before = edit.changes.map((change) =>
        this.source!.meshPositions(change.guid, change.formGuid),
      );
      try {
        const patches = captureFields(this.source!.graph, () => {
          for (const change of edit.changes)
            this.source!.setMeshPositions(change.guid, change.formGuid, change[direction]);
        });
        this.assets!.updateGeometry(
          this.source!,
          edit.changes.map((change) => change.guid),
        );
        this.fieldDirty = this.source!.dirtyAfterFields(patches);
      } catch (error) {
        edit.changes.forEach((change, i) =>
          this.source!.setMeshPositions(change.guid, change.formGuid, before[i]),
        );
        throw error;
      }
    }
    if (edit.kind !== 'parameters') this.documentChanged = true;
  }
  private structure(
    expectedRevision: number,
    change: (source: Cmo3Document) => string[] | string | void,
    parameterValuesAfter?: Record<string, number>,
  ) {
    assertRevision(expectedRevision, this.state.revision);
    if (!this.source || !this.assets || !this.state.previewReady)
      throw new Error('The source preview is not ready.');
    const before = this.source.xml(),
      draft = this.source.withXml(before),
      selectionBefore = [...this.state.selectedGuids];
    const selected = change(draft),
      source = typeof selected === 'string' ? draft.withXml(selected) : draft;
    source.graph.normalize();
    source.refreshModel();
    const after = source.xml();
    if (before === after) {
      if (parameterValuesAfter)
        this.setParameters(
          Object.fromEntries(
            this.source.model.parameters
              .filter((p) => p.guid in parameterValuesAfter)
              .map((p) => [p.id, parameterValuesAfter[p.guid]]),
          ),
        );
      return;
    }
    const edit: EditorEdit = {
      kind: 'structure',
      before,
      after,
      parameterValuesAfter,
      parameterValuesBefore: Object.fromEntries(
        this.source.model.parameters.map((p) => [
          p.guid,
          this.state.parameterValues[p.id] ?? p.default,
        ]),
      ),
      selectionBefore,
      selectionAfter: Array.isArray(selected) ? selected : selectionBefore,
      projectBefore: [...this.state.projectSelection],
      projectAfter: [...this.state.projectSelection],
      targetBefore: this.state.inspectorTarget,
      targetAfter: Array.isArray(selected) ? 'objects' : this.state.inspectorTarget,
    };
    this.applyEdit(edit, 'after', { source, assets: new SourceAssets(source, this.assets) });
    this.record(edit);
  }
  private fields(
    expectedRevision: number,
    change: (source: Cmo3Document) => void,
    sceneChanged: boolean | string[] = true,
    resourcesChanged = false,
  ) {
    assertRevision(expectedRevision, this.state.revision);
    if (!this.source || !this.assets || !this.state.previewReady)
      throw new Error('The source preview is not ready.');
    const source = this.source;
    const context: DocumentEditContext = {
      parameterValuesBefore: Object.fromEntries(
        source.model.parameters.map((p) => [p.guid, this.state.parameterValues[p.id] ?? p.default]),
      ),
      selectionBefore: [...this.state.selectedGuids],
      selectionAfter: [...this.state.selectedGuids],
      projectBefore: [...this.state.projectSelection],
      projectAfter: [...this.state.projectSelection],
      targetBefore: this.state.inspectorTarget,
      targetAfter: this.state.inspectorTarget,
    };
    const patches = captureFields(source.graph, () => change(source));
    if (!patches.length) return;
    let assets: SourceAssets;
    try {
      source.refreshModel();
      assets = new SourceAssets(source, this.assets, sceneChanged, resourcesChanged);
    } catch (error) {
      applyFields(source.graph, patches, 'before');
      source.refreshModel();
      throw error;
    }
    const edit: EditorEdit = {
      kind: 'fields',
      patches,
      sceneChanged,
      resourcesChanged,
      ...context,
    };
    this.applyEdit(edit, 'after', { source, assets });
    this.record(edit);
  }
  private editVertices(edits: VertexEdit[], expectedRevision: number) {
    assertRevision(expectedRevision, this.state.revision);
    if (!this.source || !this.assets || !this.state.previewReady)
      throw new Error('The source preview is not ready.');
    const objects = new Map(this.source.model.objects.map((o) => [o.guid, o]));
    const evaluator = new ModelEvaluator(this.assets.scene),
      evaluated = evaluator.evaluate(this.state.parameterValues);
    const seen = new Set<string>();
    const changes = edits
      .map((edit) => {
        if (seen.has(edit.guid)) throw new Error('Duplicate edited mesh.');
        seen.add(edit.guid);
        if (locked(objects, edit.guid)) throw new Error('This mesh or its parent is locked.');
        const mesh =
          evaluated.find((m) => m.source.guid === edit.guid) ||
          evaluator.evaluatedDeformers.find(
            (d) => d.source.guid === edit.guid && d.source.kind === 'warp',
          );
        if (!mesh || !mesh.visible || ('opacity' in mesh && mesh.opacity <= 0.01))
          throw new Error('Select visible editable geometry.');
        const form = keyformAt(mesh.source, this.state.parameterValues);
        if (!form)
          throw new Error('Align this mesh’s parameters with existing key values before editing.');
        const positions = [...form.positions],
          indices = new Set<number>();
        for (const point of edit.points) {
          if (point.index >= positions.length / 2 || indices.has(point.index))
            throw new Error('Invalid edited vertex index.');
          indices.add(point.index);
          const i = point.index * 2,
            local = inversePoint(
              mesh.toCanvas,
              [point.x, point.y],
              [positions[i], positions[i + 1]],
            );
          positions[i] = Math.fround(local[0]);
          positions[i + 1] = Math.fround(local[1]);
        }
        if (positions.every((p, i) => p === form.positions[i])) return null;
        return {
          guid: edit.guid,
          formGuid: form.guid,
          before: this.source!.meshPositions(edit.guid, form.guid),
          after: positions.join(' '),
        };
      })
      .filter((change) => change !== null);
    if (!changes.length) return;
    const edit: EditorEdit = { kind: 'positions', changes };
    this.applyEdit(edit, 'after');
    this.record(edit);
    this.log(`Edited ${changes.length} mesh keyform(s)`);
  }
  private operationPoints(
    expectedRevision: number,
    guids: string[] | undefined,
    allIfEmpty: boolean,
  ) {
    assertRevision(expectedRevision, this.state.revision);
    if (!this.source || !this.assets || !this.state.previewReady)
      throw new Error('The source preview is not ready.');
    const scope = guids ?? this.state.selectedGuids;
    const objects = new Map(this.source.model.objects.map((o) => [o.guid, o]));
    if (scope.some((id) => !objects.has(id))) throw new Error('Object not found.');
    const evaluator = new ModelEvaluator(this.assets.scene),
      meshes = evaluator.evaluate(this.state.parameterValues);
    return modelingPoints(
      meshes,
      evaluator.evaluatedDeformers,
      objects,
      scope,
      guids === undefined && !scope.length && allIfEmpty,
    );
  }
  private record(edit: EditorEdit) {
    if (edit.kind !== 'parameters') this.documentChanged = true;
    // A model edit or another parameter command closes the current UI gesture.
    this.finishParameterEdit();
    this.history.splice(this.historyIndex);
    this.history.push(edit);
    this.historyIndex++;
  }
  private finishParameterEdit(cancel = false) {
    const active = this.parameterEdit;
    this.parameterEdit = null;
    if (!active) return;
    const changes = active.edit.changes.filter((c) => c.before !== c.after);
    if (!changes.length) return;
    const edit: ParameterValueEdit = { kind: 'parameters', changes };
    if (cancel) this.applyEdit(edit, 'before');
    else this.record(edit);
  }
  private parameterChanges(values: Record<string, number>) {
    return Object.entries(values).map(([id, value]) => {
      const parameter = this.state.document?.parameters.find((p) => p.id === id);
      if (!parameter) throw new Error('Source parameter not found.');
      if (value < parameter.min || value > parameter.max)
        throw new Error(`Parameter must be in [${parameter.min}, ${parameter.max}].`);
      return {
        guid: parameter.guid,
        before: this.state.parameterValues[id] ?? parameter.default,
        after: value,
      };
    });
  }
  private setParameters(values: Record<string, number>, editId?: string) {
    // Ignore late pointer events after undo, document changes or another edit.
    if (editId && this.parameterEdit?.id !== editId) return;
    const changes = this.parameterChanges(values);
    if (editId) {
      const targets = changes.map((change) => {
        const target = this.parameterEdit!.edit.changes.find((c) => c.guid === change.guid);
        if (!target) throw new Error('Parameter is not part of this gesture.');
        return target;
      });
      changes.forEach((change, i) => (targets[i].after = change.after));
    } else {
      this.finishParameterEdit();
      const changed = changes.filter((c) => c.before !== c.after);
      if (changed.length) this.record({ kind: 'parameters', changes: changed });
    }
    Object.assign(this.state.parameterValues, values);
  }
  private clear() {
    this.source = null;
    this.assets = null;
    this.history = [];
    this.historyIndex = 0;
    this.parameterEdit = null;
    Object.assign(this.state, {
      document: null,
      preview: null,
      previewReady: false,
      previewError: null,
      selectedGuid: null,
      selectedGuids: [],
      project: null,
      projectSelection: [],
      inspectorTarget: 'objects',
      pointSelection: {},
      parameterValues: {},
      parameterPanel: defaultParameterPanel(),
      view: defaultView(),
    });
  }

  // UI and MCP commands use the same serialized transaction queue.
  dispatch(raw: unknown, confirmedRevision?: number): Promise<EditorState> {
    const run = this.pending.then(async () => {
      const command = commandSchema.parse(raw);
      if ('expectedRevision' in command && command.expectedRevision !== undefined)
        assertRevision(command.expectedRevision, this.state.revision);
      if (confirmedRevision !== undefined && confirmedRevision !== this.state.revision)
        throw new Error('The project changed while the file dialog was open. Try again.');
      switch (command.type) {
        case 'editPhysics':
          this.fields(
            command.expectedRevision,
            (draft) => writePhysics(draft, applyPhysicsEdits(draft.model.physics, command.edits)),
            false,
          );
          break;
        case 'importPhysics': {
          assertRevision(command.expectedRevision, this.state.revision);
          const imported = importPhysics3(
            JSON.parse(
              (await readBounded(resolve(command.path), 8 * 1024 * 1024)).toString('utf8'),
            ),
          );
          this.fields(
            command.expectedRevision,
            (draft) => {
              if (command.mode === 'replace') writePhysics(draft, imported);
              else {
                const groups = [...draft.model.physics.groups];
                for (const group of imported.groups)
                  groups.push(duplicatePhysicsGroup(group, groups, randomUUID));
                writePhysics(draft, { fps: draft.model.physics.fps, groups });
              }
            },
            false,
          );
          break;
        }
        case 'exportPhysics': {
          assertRevision(command.expectedRevision, this.state.revision);
          if (!this.source) throw new Error('Open a model first.');
          if (!command.path.toLowerCase().endsWith('.physics3.json'))
            throw new Error('Export physics as .physics3.json.');
          const errors = physicsIssues(
            this.source.model.physics,
            this.source.model.parameters,
          ).filter((i) => i.severity === 'error');
          if (errors.length) throw new Error(errors.map((i) => i.message).join('\n'));
          await atomicWrite(
            resolve(command.path),
            JSON.stringify(exportPhysics3(this.source.model.physics), null, 2),
          );
          this.log(`Exported physics to ${resolve(command.path)}`);
          break;
        }
        case 'editKeyformBatch': {
          this.fields(
            command.expectedRevision,
            (draft) => {
              editKeyformBatch(draft, this.assets!.scene, command.frames);
            },
            [...new Set(command.frames.flatMap((frame) => frame.edits.map((edit) => edit.guid)))],
          );
          break;
        }
        case 'copyForms': {
          if (!this.assets || !this.source || command.expectedRevision !== this.state.revision)
            throw new Error('The scene changed. Copy the forms again.');
          const items = copyForms(
            this.assets.scene,
            this.source.model.objects,
            command.guids,
            this.state.parameterValues,
            this.state.pointSelection,
          );
          this.copiedForms = { serial: this.copiedForms.serial + 1, items };
          this.state.formClipboard = {
            serial: this.copiedForms.serial,
            items: items.map(({ guid, id, name, kind, weights }) => ({
              guid,
              id,
              name,
              kind,
              pointCount: weights.length,
            })),
          };
          break;
        }
        case 'editForms': {
          const edit = command.value;
          const changed: string[] = [];
          this.fields(
            command.expectedRevision,
            (draft) => {
              changed.push(
                ...editNativeForms(
                  draft,
                  this.assets!.scene,
                  edit,
                  this.state.parameterValues,
                  this.copiedForms,
                ),
              );
            },
            ['updateOriginal', 'deleteOriginals'].includes(edit.action) ? false : changed,
          );
          if (edit.action === 'expandWarp') this.state.pointSelection = {};
          break;
        }
        case 'mirrorMotion': {
          if (!this.source || !this.assets || !this.state.previewReady)
            throw new Error('The source preview is not ready.');
          const plan = motionMirroringPlan(
            this.source.model,
            this.assets.scene,
            command.value.guids,
            command.value.parameterId,
            this.state.parameterValues,
          );
          this.structure(
            command.expectedRevision,
            (draft) => mirrorNativeMotion(draft, command.value, this.state.parameterValues),
            { [plan.parameter.guid]: plan.targetValue },
          );
          break;
        }
        case 'selectProject': {
          if (
            command.keys.some((key) => !this.assets?.project.resources.some((r) => r.key === key))
          )
            throw new Error('Project resource not found.');
          this.state.projectSelection = [...new Set(command.keys)];
          this.state.inspectorTarget = command.keys.length ? 'project' : 'objects';
          break;
        }
        case 'editProjectResource':
          this.fields(
            command.expectedRevision,
            (draft) => editProjectResource(draft, command.key, command.values),
            false,
            true,
          );
          break;
        case 'createMeshesFromImages':
          this.structure(command.expectedRevision, (draft) =>
            createMeshesFromImages(draft, command.keys, this.state.selectedGuids),
          );
          this.state.inspectorTarget = 'objects';
          break;
        case 'assignModelImage':
          this.structure(command.expectedRevision, (draft) =>
            assignModelImage(draft, command.key, command.guids),
          );
          break;
        case 'setTextureMode':
          this.structure(command.expectedRevision, (draft) => setTextureMode(draft, command.mode));
          break;
        case 'deleteProjectImages':
          this.structure(command.expectedRevision, (draft) =>
            deleteProjectImages(draft, command.keys),
          );
          break;
        case 'exportProjectImage': {
          if (!this.source || command.expectedRevision !== this.state.revision)
            throw new Error('The project changed. Try exporting again.');
          if (extname(command.path).toLowerCase() !== '.png')
            throw new Error('Export images as PNG.');
          await atomicWrite(resolve(command.path), projectImageBytes(this.source, command.key));
          this.log(`Exported image to ${resolve(command.path)}`);
          break;
        }
        case 'createPart':
          this.structure(command.expectedRevision, (draft) => [createPart(draft, command.value)]);
          break;
        case 'movePartObjects':
          this.structure(command.expectedRevision, (draft) =>
            movePartObjects(draft, command.guids, command.parentGuid, command.beforeGuid),
          );
          break;
        case 'deletePartObjects':
          this.structure(command.expectedRevision, (draft) =>
            deletePartObjects(draft, command.guids, command.mode, this.state.parameterValues),
          );
          break;
        case 'pruneEmptyParts':
          this.structure(command.expectedRevision, (draft) =>
            pruneEmptyParts(draft, command.parentGuid),
          );
          break;
        case 'setObjectFlags':
          this.fields(
            command.expectedRevision,
            (draft) => setObjectFlags(draft, command.guids, command.values),
            command.values.visible !== undefined ? command.guids : false,
          );
          break;
        case 'moveDeformerObjects':
          this.structure(command.expectedRevision, (draft) =>
            moveDeformerObjects(
              draft,
              command.guids,
              command.deformerGuid,
              this.state.parameterValues,
            ),
          );
          break;
        case 'pruneEmptyDeformers':
          this.structure(command.expectedRevision, (draft) =>
            pruneEmptyDeformers(draft, command.parentGuid),
          );
          break;
        case 'editObjectProperties': {
          const change = (draft: Cmo3Document) =>
            editObjectProperties(
              draft,
              command.guids,
              command.values,
              this.state.parameterValues,
              this.assets!.scene,
            );
          if (command.values.parentGuid !== undefined || command.values.deformerGuid !== undefined)
            this.structure(command.expectedRevision, change);
          else this.fields(command.expectedRevision, change, command.guids);
          break;
        }
        case 'beginParameterEdit': {
          const values = Object.fromEntries(
            command.ids.map((id) => [id, this.state.parameterValues[id]]),
          );
          const changes = this.parameterChanges(values);
          this.finishParameterEdit();
          this.parameterEdit = { id: command.editId, edit: { kind: 'parameters', changes } };
          break;
        }
        case 'endParameterEdit':
          if (this.parameterEdit?.id === command.editId) this.finishParameterEdit(command.cancel);
          break;
        case 'parameterPanel': {
          const entries = new Set(
            [
              ...(this.state.document?.parameters || []),
              ...(this.state.document?.parameterGroups || []),
            ].map((p) => p.guid),
          );
          if (command.value.selection?.some((id) => !entries.has(id)))
            throw new Error('Parameter selection changed.');
          Object.assign(this.state.parameterPanel, command.value);
          break;
        }
        case 'createParameter': {
          let guid = '';
          this.structure(command.expectedRevision, (source) => {
            guid = createParameter(source, command.value, command.groupGuid);
          });
          this.state.parameterPanel.selection = [guid];
          this.state.parameterPanel.collapsed = this.state.parameterPanel.collapsed.filter(
            (id) => id !== command.groupGuid,
          );
          break;
        }
        case 'editParameter':
          this.fields(
            command.expectedRevision,
            (source) => editParameter(source, command.guid, command.value),
            this.source?.model.parameters.find((p) => p.guid === command.guid)?.id !==
              command.value.id
              ? true
              : [],
          );
          break;
        case 'createParameterGroup': {
          let guid = '';
          this.structure(command.expectedRevision, (source) => {
            guid = createParameterGroup(source, command.name, command.parentGuid);
          });
          this.state.parameterPanel.selection = [guid];
          this.state.parameterPanel.collapsed = this.state.parameterPanel.collapsed.filter(
            (id) => id !== command.parentGuid,
          );
          break;
        }
        case 'renameParameterGroup':
          this.fields(
            command.expectedRevision,
            (source) => renameParameterGroup(source, command.guid, command.name),
            false,
          );
          break;
        case 'moveParameterEntries':
          this.structure(command.expectedRevision, (source) =>
            moveParameterEntries(source, command.guids, command.groupGuid, command.beforeGuid),
          );
          break;
        case 'linkParameter':
          this.fields(
            command.expectedRevision,
            (source) => linkParameter(source, command.guid, command.combined),
            false,
          );
          break;
        case 'editParameterKeys':
          this.structure(command.expectedRevision, (source) =>
            editParameterKeys(source, command.guids, command.edits, this.state.parameterValues),
          );
          break;
        case 'deleteParameterEntries':
          this.structure(command.expectedRevision, (source) => {
            const targets = parameterDescendants(source.model.parameterGroups, command.guids);
            if (targets.includes(source.model.rootParameterGroupGuid))
              throw new Error('The root folder cannot be deleted.');
            const parameters = source.model.parameters.filter((p) => targets.includes(p.guid));
            const objects = [...new Set(parameters.flatMap((p) => Object.keys(p.bindings)))];
            const draft = objects.length
              ? source.withXml(
                  editParameterKeys(
                    source,
                    objects,
                    parameters.map((p) => ({ parameterGuid: p.guid, keys: [] })),
                    this.state.parameterValues,
                  ),
                )
              : source;
            removeParameterEntries(draft, targets);
            return draft.xml();
          });
          break;
        case 'setParameterDefaults':
          this.fields(
            command.expectedRevision,
            (source) => setParameterDefaults(source, this.state.parameterValues, command.ids),
            [],
          );
          break;
        case 'new':
        case 'open': {
          const path = command.type === 'open' ? resolve(command.path) : null;
          const extension = path ? extname(path).toLowerCase() : null;
          if (extension && !['.cmo3', '.psd'].includes(extension))
            throw new Error('Open a .cmo3 or .psd file.');
          const options = command.type === 'open' ? command.psd : undefined;
          const integrating = options && options.mode !== 'newModel';
          if (options && extension !== '.psd')
            throw new Error('PSD import options require a .psd file.');
          if (integrating) {
            if (command.type !== 'open' || command.expectedRevision !== this.state.revision)
              throw new Error('The project changed. Open the PSD import dialog again.');
            if (!this.source || !this.assets || !this.state.previewReady)
              throw new Error('Open a model before adding or replacing PSD artwork.');
          } else this.requireClean(confirmedRevision);
          const bytes = path ? await readBounded(path, 512 * 1024 * 1024) : null;
          const imported =
            extension === '.psd'
              ? importPsd(
                  bytes!,
                  path!,
                  this.state.locale,
                  (await stat(path!)).mtimeMs,
                  integrating ? { document: this.source!, options } : undefined,
                )
              : null;
          if (integrating && imported) {
            const before = this.source!.serialize(),
              after = imported.document.serialize();
            const edit: EditorEdit = {
              kind: 'archive',
              before,
              after,
              selectionBefore: [...this.state.selectedGuids],
              selectionAfter:
                options.mode === 'addGroup' ? imported.addedGuids : [...this.state.selectedGuids],
              projectBefore: [...this.state.projectSelection],
              projectAfter: [imported.sourceKey],
              targetBefore: this.state.inspectorTarget,
              targetAfter: this.state.inspectorTarget,
            };
            this.applyEdit(edit, 'after');
            this.record(edit);
            this.state.recentFiles = [
              path!,
              ...this.state.recentFiles.filter((p) => p !== path),
            ].slice(0, 8);
            for (const warning of imported.warnings) this.log(warning);
            this.log(
              `${options.mode === 'addGroup' ? 'Added PSD group' : 'Replaced PSD artwork'}: ${path}`,
            );
            break;
          }
          const document =
            imported?.document ??
            (bytes ? new Cmo3Document(bytes, path) : newModel(this.state.locale));
          // Prepare the complete replacement before dropping the current document.
          let assets: SourceAssets | null = null,
            previewError: string | null = null;
          try {
            assets = new SourceAssets(document);
          } catch (error) {
            if (imported || command.type === 'new') throw error;
            previewError = error instanceof Error ? error.message : String(error);
          }
          this.clear();
          this.source = document;
          this.assets = assets;
          this.state.preview = assets?.descriptor || null;
          this.state.previewError = previewError;
          for (const warning of [
            ...(assets?.descriptor.warnings || []),
            ...(imported?.warnings || []),
            ...(previewError ? [previewError] : []),
          ])
            this.log(warning);
          this.diskHash = bytes && !imported ? hash(bytes) : '';
          this.state.document = document.model;
          this.state.parameterPanel.collapsed = document.model.parameterGroups
            .filter((g) => !g.expanded && g.guid !== document.model.rootParameterGroupGuid)
            .map((g) => g.guid);
          this.state.parameterValues = Object.fromEntries(
            document.model.parameters.map((p) => [p.id, p.default]),
          );
          if (path)
            this.state.recentFiles = [
              path,
              ...this.state.recentFiles.filter((p) => p !== path),
            ].slice(0, 8);
          this.log(path ? `Opened ${path}` : 'Created a new model');
          break;
        }
        case 'close':
          this.requireClean(confirmedRevision);
          this.clear();
          break;
        case 'select': {
          if (
            command.guid !== null &&
            !this.state.document?.objects.some((o) => o.guid === command.guid)
          )
            throw new Error('Object not found.');
          this.state.selectedGuid = command.guid;
          this.state.selectedGuids = command.guid ? [command.guid] : [];
          this.state.pointSelection = {};
          this.state.inspectorTarget = 'objects';
          break;
        }
        case 'selectMany': {
          const ids = [...new Set(command.guids)],
            objects = this.state.document?.objects || [];
          if (ids.some((id) => !objects.some((o) => o.guid === id)))
            throw new Error('Object not found.');
          for (const [id, points] of Object.entries(command.points || {})) {
            const mesh = [
              ...(this.assets?.scene.meshes || []),
              ...(this.assets?.scene.deformers || []),
            ].find((m) => m.guid === id);
            if (
              !ids.includes(id) ||
              !mesh ||
              Object.keys(points).some((i) => Number(i) >= mesh.forms[0].positions.length / 2)
            )
              throw new Error('Invalid selected vertex.');
          }
          this.state.selectedGuids = ids;
          this.state.selectedGuid = ids.at(-1) || null;
          this.state.pointSelection = command.points || {};
          this.state.inspectorTarget = 'objects';
          break;
        }
        case 'toolSettings':
          Object.assign(this.state.toolSettings, command.value);
          break;
        case 'selectRegion': {
          const points = this.operationPoints(command.expectedRevision, command.guids, true);
          const weights = selectPointRegion(
            points,
            command.region,
            command.mode === 'replace' ? {} : this.state.pointSelection,
            { ...this.state.toolSettings, ...command.settings },
            command.mode === 'subtract',
          );
          const weighted = Object.keys(weights).filter((id) =>
            Object.values(weights[id]).some((w) => w > 0),
          );
          const guids =
            command.region.type === 'rectangle'
              ? weighted
              : [...new Set([...this.state.selectedGuids, ...weighted])];
          this.state.selectedGuids = guids;
          this.state.selectedGuid = guids.at(-1) || null;
          this.state.pointSelection = Object.fromEntries(
            Object.entries(weights).filter(([id]) => guids.includes(id)),
          );
          this.state.inspectorTarget = 'objects';
          break;
        }
        case 'deformBrush': {
          const points = this.operationPoints(command.expectedRevision, command.guids, false);
          validateBrushStroke(
            command.points,
            command.settings?.size ?? this.state.toolSettings.size,
            points.length,
          );
          if (command.selection) {
            const valid = new Set(points.map((p) => `${p.guid}:${p.index}`));
            for (const [guid, weights] of Object.entries(command.selection))
              if (Object.keys(weights).some((index) => !valid.has(`${guid}:${Number(index)}`)))
                throw new Error('Invalid brush selection vertex.');
          }
          const stroke = new DeformationStroke(
            groupVertexEdits(points),
            (guid) => pointTriangles(this.assets!.scene, guid),
            { ...this.state.toolSettings, ...command.settings },
            command.selection ?? this.state.pointSelection,
          );
          for (let i = 1; i < command.points.length; i++)
            stroke.move(command.points[i - 1], command.points[i]);
          const edits = changedVertexEdits(stroke.edits, points);
          if (edits.length) this.editVertices(edits, command.expectedRevision);
          break;
        }
        case 'editVertices':
          this.editVertices(command.edits, command.expectedRevision);
          break;
        case 'autoLayoutAtlas':
        case 'editAtlases': {
          if (
            command.expectedRevision !== this.state.revision ||
            !this.source ||
            !this.state.previewReady
          )
            throw new Error('The scene changed. Try the atlas edit again.');
          let atlases;
          if (command.type === 'autoLayoutAtlas') {
            const workspace = readAtlasWorkspace(this.source, () => '');
            const visible = visibleAtlasImages(workspace.unassigned, this.source.model.objects);
            const page = autoLayoutAtlas(workspace, visible, command.value, randomUUID());
            if (!page)
              throw new Error(
                'The images do not fit this atlas. Increase its size or reduce the margin.',
              );
            atlases = command.value.atlasGuid
              ? workspace.atlases.map((a) => (a.guid === page.guid ? page : a))
              : [...workspace.atlases, page];
            const previous = workspace.atlases.find((a) => a.guid === page.guid);
            if (
              previous &&
              previous.name === page.name &&
              previous.width === page.width &&
              previous.height === page.height &&
              previous.items.length === page.items.length &&
              previous.items.every((p, i) => {
                const n = page.items[i];
                return (
                  p.guid === n.guid &&
                  (['x', 'y', 'scaleX', 'scaleY', 'angle'] as const).every(
                    (k) => Math.abs(p[k] - n[k]) < 1e-5,
                  )
                );
              })
            )
              break;
          } else atlases = command.atlases;
          const before = this.source.serialize(),
            after = editAtlases(this.source.withXml(this.source.xml()), atlases),
            selectionBefore = [...this.state.selectedGuids];
          const edit: EditorEdit = {
            kind: 'archive',
            before,
            after,
            selectionBefore,
            selectionAfter: selectionBefore,
            projectBefore: [...this.state.projectSelection],
            projectAfter: [...this.state.projectSelection],
            targetBefore: this.state.inspectorTarget,
            targetAfter: this.state.inspectorTarget,
          };
          this.applyEdit(edit, 'after');
          this.record(edit);
          break;
        }
        case 'setGlue': {
          const objects = new Map(this.state.document?.objects.map((o) => [o.guid, o]));
          if (
            [
              command.value.meshA,
              command.value.meshB,
              ...(command.guid ? [command.guid] : []),
            ].some((id) => locked(objects, id))
          )
            throw new Error('Selected geometry is locked.');
          this.structure(command.expectedRevision, (draft) => [
            setGlue(draft, command.value, command.guid),
          ]);
          break;
        }
        case 'removeGlue':
          if (locked(new Map(this.state.document?.objects.map((o) => [o.guid, o])), command.guid))
            throw new Error('Glue is locked.');
          this.structure(command.expectedRevision, (draft) => {
            removeGlue(draft, command.guid);
            return [];
          });
          break;
        case 'editGlueWeights': {
          const objects = new Map(this.state.document?.objects.map((o) => [o.guid, o]));
          this.fields(
            command.expectedRevision,
            (draft) => {
              for (const change of command.changes) {
                const glue = this.assets?.scene.glues?.find((g) => g.guid === change.guid);
                if (!glue) throw new Error('Glue not found.');
                if ([glue.guid, glue.meshA, glue.meshB].some((id) => locked(objects, id)))
                  throw new Error('Selected geometry is locked.');
                editGlueWeights(draft, glue.guid, change.weights);
              }
            },
            command.changes.map((change) => change.guid),
          );
          break;
        }
        case 'createArtPath':
          this.structure(command.expectedRevision, (draft) => [
            createArtPath(draft, command.points, command, this.state.parameterValues),
          ]);
          break;
        case 'createController': {
          if (locked(new Map(this.state.document?.objects.map((o) => [o.guid, o])), command.guid))
            throw new Error('Selected geometry is locked.');
          this.structure(command.expectedRevision, (draft) =>
            createController(
              draft,
              command.guid,
              command.points,
              command.width,
              command.hardness,
              this.state.parameterValues,
            ),
          );
          break;
        }
        case 'createDeformer':
          this.structure(command.expectedRevision, (draft) => {
            const guid = createDeformer(draft, command.value, this.state.parameterValues);
            draft.graph.normalize();
            draft.refreshModel();
            updateOriginalForms(
              draft,
              readSourceScene(draft).scene,
              [guid],
              this.state.parameterValues,
              'DEFORMER_CREATED',
            );
            return [guid];
          });
          break;
        case 'editTopology':
        case 'automaticMesh': {
          const guids = command.type === 'editTopology' ? [command.guid] : command.guids,
            objects = new Map(this.state.document?.objects.map((o) => [o.guid, o]));
          if (guids.some((id) => locked(objects, id)))
            throw new Error('Selected geometry is locked.');
          this.structure(command.expectedRevision, (draft) => {
            if (command.type === 'editTopology') {
              if (command.textureMode) setTextureMode(draft, command.textureMode);
              editTopology(draft, command.guid, command.vertices, command.indices, command.edges);
            } else automaticMesh(draft, guids, command.settings);
          });
          break;
        }
        case 'editRotation': {
          const node = this.assets?.scene.deformers.find((d) => d.guid === command.guid),
            objects = new Map(this.state.document?.objects.map((o) => [o.guid, o]));
          if (!node || locked(objects, command.guid))
            throw new Error('Select an unlocked rotation deformer.');
          const changed: string[] = [];
          this.fields(
            command.expectedRevision,
            (draft) =>
              changed.push(
                ...editRotation(
                  draft,
                  this.assets!.scene,
                  command.guid,
                  this.state.parameterValues,
                  command.value,
                  command.preserveChildren,
                ),
              ),
            changed,
          );
          break;
        }
        case 'rename': {
          const object = this.state.document?.objects.find((o) => o.guid === command.guid);
          if (!object || !this.source) throw new Error('Object not found.');
          if (locked(new Map(this.source.model.objects.map((o) => [o.guid, o])), object.guid))
            throw new Error('This object or its parent is locked.');
          if (object.name === command.name) return this.snapshot();
          const before = object.name;
          const edit: EditorEdit = { kind: 'name', guid: object.guid, before, after: command.name };
          this.applyEdit(edit, 'after');
          this.record(edit);
          this.log(`Renamed ${object.id}: ${before || object.id} → ${command.name || object.id}`);
          break;
        }
        case 'transformMesh': {
          if (command.expectedRevision !== this.state.revision)
            throw new Error('The scene changed during the drag. Try the edit again.');
          if (!this.source || !this.assets || !this.state.previewReady)
            throw new Error('The source preview is not ready.');
          const objects = new Map(this.source.model.objects.map((o) => [o.guid, o]));
          if (locked(objects, command.guid)) throw new Error('This mesh or its parent is locked.');
          const mesh = new ModelEvaluator(this.assets.scene)
            .evaluate(this.state.parameterValues)
            .find((m) => m.source.guid === command.guid);
          if (!mesh || !mesh.visible || mesh.opacity <= 0.01)
            throw new Error('Select a visible source mesh.');
          const form = keyformAt(mesh.source, this.state.parameterValues);
          if (!form)
            throw new Error(
              'Align this mesh’s parameters with existing key values before editing.',
            );
          if (command.matrix.every((v, i) => Math.abs(v - identityMatrix[i]) < 1e-9))
            return this.snapshot();
          this.editVertices(
            [
              {
                guid: command.guid,
                points: Array.from(
                  { length: (mesh.controlPositions || mesh.positions).length / 2 },
                  (_, index) => {
                    const p = mesh.controlPositions || mesh.positions;
                    const [x, y] = applyMatrix(command.matrix, p[index * 2], p[index * 2 + 1]);
                    return { index, x, y };
                  },
                ),
              },
            ],
            command.expectedRevision,
          );
          break;
        }
        case 'undo': {
          this.finishParameterEdit();
          if (this.historyIndex > 0 && this.source) {
            const edit = this.history[this.historyIndex - 1];
            this.applyEdit(edit, 'before');
            this.historyIndex--;
          }
          break;
        }
        case 'redo': {
          this.finishParameterEdit();
          if (this.historyIndex < this.history.length && this.source) {
            const edit = this.history[this.historyIndex];
            this.applyEdit(edit, 'after');
            this.historyIndex++;
          }
          break;
        }
        case 'save': {
          if (!this.source) throw new Error('No project is open.');
          this.finishParameterEdit();
          const path = command.path ? resolve(command.path) : this.source.model.path;
          if (!path) throw new Error('Choose a .cmo3 path with Save As for this new project.');
          if (extname(path).toLowerCase() !== '.cmo3')
            throw new Error('Save projects with the .cmo3 extension.');
          if (
            path === this.source.model.path &&
            hash(await readBounded(path, 512 * 1024 * 1024)) !== this.diskHash
          ) {
            throw new Error('The project changed on disk. Use Save As to preserve both versions.');
          }
          const bytes = this.source.serialize();
          // Verify the archive and object graph before replacing any file.
          const validated = new Cmo3Document(bytes, path);
          const issues = validateNativeDocument(validated);
          if (issues.some((i) => i.severity === 'error'))
            throw new OperationError(
              'MODEL_VALIDATION_FAILED',
              'Native CMO3 validation failed; the destination file was not changed.',
              { issues },
            );
          await atomicWrite(path, bytes);
          this.source = validated;
          this.state.document = validated.model;
          this.diskHash = hash(bytes);
          this.state.recentFiles = [
            path,
            ...this.state.recentFiles.filter((p) => p !== path),
          ].slice(0, 8);
          this.log(`Saved ${path}`);
          break;
        }
        case 'setParameters':
        case 'setParameter': {
          const values =
            command.type === 'setParameter' ? { [command.id]: command.value } : command.values;
          this.setParameters(values, command.type === 'setParameters' ? command.editId : undefined);
          break;
        }
        case 'resetParameters':
          this.setParameters(
            Object.fromEntries(
              (this.state.document?.parameters || [])
                .filter((p) => !command.ids || command.ids.includes(p.id))
                .map((p) => [p.id, p.default]),
            ),
          );
          break;
        case 'view':
          if (command.expectedCamera) {
            const { previewId, ...camera } = command.expectedCamera;
            // A queued local gesture cannot overwrite a newer external camera or document.
            if (
              previewId !== (this.state.preview?.id || null) ||
              Object.entries(camera).some(
                ([key, value]) => this.state.view[key as keyof typeof camera] !== value,
              )
            )
              return this.snapshot();
          }
          Object.assign(this.state.view, command.value);
          break;
        case 'locale':
          this.state.locale = command.value;
          break;
      }
      this.publish(command.type !== 'view');
      return this.snapshot();
    });
    this.pending = run.catch(() => undefined);
    return run;
  }
}
