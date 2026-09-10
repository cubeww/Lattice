import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { psdImportOptionsSchema } from '../shared/psd';
import { formEditSchema } from '../shared/form-edit';
import { motionMirroringSchema } from '../shared/motion-mirroring';
import { physicsEditSchema, physicsSimulationSchema } from '../shared/physics';
import { affineSchema, commandSchema } from '../shared/commands';
import {
  OperationError,
  operationError,
  sceneQuerySchema,
  geometryQuerySchema,
  renderModelSchema,
  validationQuerySchema,
  waitForIdleSchema,
} from '../shared/workflow';

const { values } = parseArgs({ options: { connection: { type: 'string' } } });
if (!values.connection)
  throw new Error('Usage: node out/mcp/index.js --connection <Lattice userData>/bridge.json');
const connectionPath = values.connection;
const connectionSchema = z.object({
  url: z.string().url(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

async function request(route: string, body?: unknown) {
  const connection = connectionSchema.parse(JSON.parse(await readFile(connectionPath, 'utf8')));
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
    throw new Error('Bridge must be on the local loopback address.');
  const response = await fetch(new URL(route, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = result.error;
    throw new OperationError(
      error?.code || 'BRIDGE_ERROR',
      error?.message || `Editor error ${response.status}`,
      { ...error?.details, revision: result.revision },
    );
  }
  return result;
}
const content = (result: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
});
const run = async (action: () => Promise<unknown>) => {
  try {
    return content(await action());
  } catch (error) {
    return {
      ...content({ error: operationError(error) }),
      isError: true,
    };
  }
};
const guid = z.string().describe('Object GUID returned by get_scene_info; not its display name.');

serveStdio(() => {
  const server = new McpServer({ name: 'lattice', version: '0.1.0' });
  server.registerTool(
    'get_physics_settings',
    {
      description:
        'Read native CMO3 physics groups in evaluation order, FPS, parameter IDs/ranges, pendulum presets and configuration issues. Group GUIDs and data GUIDs are stable; inputs/outputs reference parameter IDs.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(() => request('/physics')),
  );
  server.registerTool(
    'edit_physics',
    {
      description:
        'Edit physics in one undo step without reloading textures. putGroup inserts or replaces a complete group (generate unique UUIDs for new groups/inputs/outputs/particles); root particle has radius 0, outputs reference pendulum indices starting at 1. Set FPS, reorder all group GUIDs, delete a group, or replace all settings. Duration=radius, shaking influence=mobility 0..1, reaction time=delay, convergence=acceleration. Input types X/Y/Angle and weights are percentages. Angle outputs use radians × scale. No per-frame model edits are needed; use simulate_physics to measure output peaks.',
      inputSchema: z.object({
        edits: z.array(physicsEditSchema).min(1).max(256),
        expectedRevision: z.number().int().nonnegative(),
      }),
    },
    (input) => run(() => request('/command', { type: 'editPhysics', ...input })),
  );
  server.registerTool(
    'simulate_physics',
    {
      description:
        'Run the same physics solver as the live preview without changing model parameters, history or selection. Frames are consecutive held input poses; omitted parameters use model defaults. Returns sampled complete poses, per-output raw peaks/percent/clipping and final pendulum positions. Feed returned poses to render_model for visual inspection. Disabled groups affect only this simulation. At most 120 seconds.',
      inputSchema: physicsSimulationSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => request('/physics/simulate', input)),
  );
  server.registerTool(
    'import_physics',
    {
      description:
        'Import a .physics3.json into the current native CMO3 in one undo step. replace replaces existing physics; append assigns fresh group IDs and preserves the current FPS. All parameter IDs must exist. Custom runtime gravity/wind cannot be stored in CMO3 and are rejected.',
      inputSchema: z.object({
        path: z.string().min(1),
        mode: z.enum(['replace', 'append']),
        expectedRevision: z.number().int().nonnegative(),
      }),
    },
    (input) => run(() => request('/command', { type: 'importPhysics', ...input })),
  );
  server.registerTool(
    'export_physics',
    {
      description:
        'Atomically export native physics to a standard .physics3.json, including FPS and group names. Does not compile MOC3 or modify a model3.json; reference the exported filename from FileReferences.Physics in the runtime model3.json.',
      inputSchema: z.object({
        path: z.string().min(1),
        expectedRevision: z.number().int().nonnegative(),
      }),
    },
    (input) => run(() => request('/command', { type: 'exportPhysics', ...input })),
  );
  server.registerTool(
    'get_editor_status',
    {
      description:
        'Read compact document, revision, selection, parameter values and undo/preview status. All edits return this summary; reuse the returned revision for the next edit. Query scene/geometry only when needed.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(() => request('/status')),
  );
  server.registerTool(
    'wait_for_idle',
    {
      description:
        'Wait for queued edits, source assets and the actual viewport frame. afterRevision is a minimum revision. Returns current status and rendered revision/scene revision. Does not change state or undo history. Screenshots and render_model already wait automatically.',
      inputSchema: waitForIdleSchema,
      annotations: { readOnlyHint: true },
    },
    (options) => run(() => request('/wait', options)),
  );
  server.registerTool(
    'validate_model',
    {
      description:
        'Check native CMO3 type imports, references, resources, hierarchy, keyform grids, mesh topology and evaluated poses. Includes the default pose; omitted parameter values use source defaults. requireAtlas makes unassigned model images errors. Returns structured errors/warnings and nativeEditorVerified:false: this is local validation, not proof of a round trip through Cubism.',
      inputSchema: validationQuerySchema,
      annotations: { readOnlyHint: true },
    },
    (options) => run(() => request('/validate', options)),
  );
  server.registerTool(
    'render_model',
    {
      description:
        'Render clean model PNGs with the editor’s own renderer, after the current revision is drawn. Omit poses for the current parameter values; explicit poses fill omitted parameters from source defaults. guids frames objects and descendants, retaining surrounding model context; bounds is an explicit canvas crop. All poses share the same framing. Returns metadata then one PNG per pose. No selection, camera, parameter or undo changes. Finish mesh editing previews first.',
      inputSchema: renderModelSchema.safeExtend({
        expectedRevision: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (options) => {
      try {
        const { images, ...result } = await request('/render', options);
        return {
          content: [
            ...content({
              ...result,
              frames: images.map(({ data: _data, ...frame }: Record<string, unknown>) => frame),
            }).content,
            ...images.map((frame: { data: string }) => ({
              type: 'image' as const,
              mimeType: 'image/png',
              data: frame.data,
            })),
          ],
        };
      } catch (error) {
        return { ...content({ error: operationError(error) }), isError: true };
      }
    },
  );
  server.registerTool(
    'mirror_motion',
    {
      description:
        'Parameter > Motion Mirroring in one undo step. Mirror the current source keyform to 2 × parameter default − current value, inserting the destination key if missing and switching to that value. Other parameter values stay fixed. Select unlocked ArtMeshes, warp or rotation deformers bound to one normal, non-repeating, unlinked parameter; both source and default keyforms must exist. direction is horizontal or vertical. ArtMesh axis can be canvas center, a perpendicular native guide (GUID from get_scene_info.document.guides), or a rotation deformer center. Deformers mirror movement relative to their default form. Existing destination forms are overwritten; source geometry and mesh topology are preserved. Blend-shape targets are not supported.',
      inputSchema: z.object({
        value: motionMirroringSchema,
        expectedRevision: z.number().int().nonnegative(),
      }),
    },
    (input) => run(() => request('/command', { type: 'mirrorMotion', ...input })),
  );
  server.registerTool(
    'copy_forms',
    {
      description:
        'Copy the current (including interpolated) forms of selected objects into the editor form clipboard. Geometry is copied in canvas coordinates, with selected vertex weights. Returns clipboard serial and object metadata. Does not modify the document.',
      inputSchema: z.object({
        guids: z.array(guid).min(1).max(1000),
        expectedRevision: z.number().int().nonnegative(),
      }),
    },
    (input) => run(() => request('/command', { type: 'copyForms', ...input })),
  );
  server.registerTool(
    'get_form_clipboard',
    {
      description:
        'Read copied forms, vertex weights and clipboard serial for Edit Form. The clipboard can be pasted across models.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(() => request('/form-clipboard')),
  );
  server.registerTool(
    'edit_forms',
    {
      description:
        'Modeling > Edit Form in one undo step. Paste/blend uses explicit source/target GUID mappings and the clipboard serial; weight 0..1. Optional per-type settings select appearance/geometry and mirroring. Flip affects all keyforms and optionally reverses selected parameter axes; scale can affect current or all forms. ReshapeWarp uses Edit Level 2/3 Bezier handles. ExpandWarp encloses child forms and remaps them. Revert restores the current keyform from original mesh/deformer geometry. UpdateOriginal stores selected deformer poses; deleteOriginals removes all stored deformer originals. Current-form edits require existing key values.',
      inputSchema: z.object({
        value: formEditSchema,
        expectedRevision: z.number().int().nonnegative(),
      }),
    },
    (input) => run(() => request('/command', { type: 'editForms', ...input })),
  );
  server.registerTool(
    'get_project_resources',
    {
      description:
        'Read the native Project resource tree, original layers, model images, source connections, dimensions and ArtMesh/atlas references. Resource keys address Project items; they are distinct from scene object GUIDs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    () =>
      run(async () => {
        const state = await request('/scene', { include: ['project'] });
        return {
          revision: state.revision,
          project: state.project,
          selection: state.projectSelection,
        };
      }),
  );
  server.registerTool(
    'get_scene_info',
    {
      description:
        'Read source objects, parameters and key bindings plus compact status. guids filters objects and their descendants. include defaults to objects/parameters/view; request project or log explicitly. Use get_editor_status when only the revision or current pose is needed.',
      annotations: { readOnlyHint: true },
      inputSchema: sceneQuerySchema,
    },
    (options) => run(() => request('/scene', options)),
  );
  server.registerTool(
    'get_object_info',
    {
      description:
        'Read source metadata and editable Inspector properties at the current parameter pose, including keyform and lock state. Does not change selection.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ guid }),
    },
    ({ guid }) =>
      run(async () => {
        const inspected = await request(`/inspector?guid=${encodeURIComponent(guid)}`);
        return { ...inspected.objects[0], revision: inspected.revision };
      }),
  );
  server.registerTool(
    'open_project',
    {
      description:
        'Open .cmo3 or import RGB 8-bit PSD and wait until its viewport has drawn. psd.mode: newModel (default), addGroup, or replaceSource with sourceKey from the Project tree. Adding/replacing preserves modeling and is undoable; expectedRevision is required. New models refuse to discard unsaved edits and need a .cmo3 save path. Returns compact status and rendered revision.',
      inputSchema: z.object({
        path: z.string(),
        psd: psdImportOptionsSchema.optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      }),
    },
    (input) => run(() => request('/command', { type: 'open', ...input })),
  );
  server.registerTool(
    'new_project',
    {
      description:
        'Create a 1000 × 2000 blank model with standard parts and parameters. Refuses to discard unsaved edits. Save the new model with a .cmo3 path.',
      inputSchema: z.object({}),
    },
    () => run(() => request('/command', { type: 'new' })),
  );
  server.registerTool(
    'select_object',
    {
      description: 'Select an object in the editor and synchronize the Inspector.',
      inputSchema: z.object({ guid: guid.nullable() }),
    },
    ({ guid }) => run(() => request('/command', { type: 'select', guid })),
  );
  server.registerTool(
    'rename_object',
    {
      description: 'Change a native source object name; supports undo and CMO3 saving.',
      inputSchema: z.object({ guid, name: z.string().max(256) }),
    },
    ({ guid, name }) => run(() => request('/command', { type: 'rename', guid, name })),
  );
  server.registerTool(
    'transform_mesh',
    {
      description:
        'Transform one visible, unlocked ArtMesh at an existing keyform. Supply a canvas-space affine matrix [a,b,c,d,tx,ty], where x′=a*x+c*y+tx and y′=b*x+d*y+ty. expectedRevision must match get_scene_info.revision. The entire gesture is one undoable native CMO3 edit; parameters between this mesh’s keys are rejected.',
      inputSchema: z.object({
        guid,
        matrix: affineSchema,
        expectedRevision: z.number().int().nonnegative(),
      }),
    },
    (args) => run(() => request('/command', { type: 'transformMesh', ...args })),
  );
  server.registerTool(
    'set_parameter',
    {
      description:
        'Evaluate the native CMO3 keyforms at a parameter value within its source range. One undo step. Does not author keyforms or persist the pose.',
      inputSchema: z.object({ id: z.string(), value: z.number().finite() }),
    },
    ({ id, value }) => run(() => request('/command', { type: 'setParameter', id, value })),
  );
  server.registerTool(
    'reset_parameters',
    {
      description:
        'Reset preview parameters to source defaults in one undo step. Omit ids to reset all.',
      inputSchema: z.object({ ids: z.array(z.string()).optional() }),
    },
    ({ ids }) => run(() => request('/command', { type: 'resetParameters', ids })),
  );
  server.registerTool(
    'set_view',
    {
      description:
        'Adjust the editor tool, edit level, zoom, pan, background and mesh/grid overlays.',
      inputSchema: z.object({
        zoom: z.number().min(0.05).max(8).optional(),
        mesh: z.boolean().optional(),
        grid: z.boolean().optional(),
        panX: z.number().finite().optional(),
        panY: z.number().finite().optional(),
        background: z.enum(['checker', 'white', 'dark']).optional(),
        tool: z
          .enum([
            'select',
            'pan',
            'lasso',
            'brushSelect',
            'deformBrush',
            'rotationDraw',
            'deformPath',
            'artPath',
            'glue',
          ])
          .optional(),
        editLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      }),
    },
    (value) => run(() => request('/command', { type: 'view', value })),
  );
  server.registerTool(
    'save_project',
    {
      description:
        'Validate the native structure, then atomically save modeling edits and textures to CMO3. Invalid imports, references or resources reject the save before changing the destination. Optional path performs Save As. For pose/atlas checks use validate_model. Does not export MOC3 or verify the official editor.',
      inputSchema: z.object({ path: z.string().optional() }),
    },
    ({ path }) => run(() => request('/command', { type: 'save', path })),
  );
  server.registerTool(
    'undo',
    { description: 'Undo one source edit.', inputSchema: z.object({}) },
    () => run(() => request('/command', { type: 'undo' })),
  );
  server.registerTool(
    'redo',
    { description: 'Redo one source edit.', inputSchema: z.object({}) },
    () => run(() => request('/command', { type: 'redo' })),
  );
  server.registerTool(
    'get_editor_screenshot',
    {
      description:
        'Wait for the actual viewport frame and capture the editor window. Returns rendered revision metadata and a PNG; no fixed sleep is needed. Use render_model for clean model images or parameter comparisons.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await request('/screenshot');
        return {
          content: [
            ...content({ revision: result.revision, rendered: result.rendered }).content,
            { type: 'image' as const, data: result.data as string, mimeType: 'image/png' },
          ],
        };
      } catch (error) {
        return { ...content({ error: operationError(error) }), isError: true };
      }
    },
  );
  server.registerTool(
    'get_texture_atlases',
    {
      description:
        'Read atlas pages, placements and unassigned model images (IDs, dimensions and visibility) for edit_texture_atlases. Image bytes are omitted; use the editor screenshot for visual feedback.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(() => request('/atlases')),
  );
  server.registerTool(
    'get_model_geometry',
    {
      description:
        'Read evaluated geometry and revision without moving the preview. guids filters objects and descendants. fields selects positions/topology/forms/controllers/appearance (all by default); bounds and identity are always included. Optional parameters evaluate an explicit pose, filling omitted values from source defaults. Without parameters, uses the current preview pose.',
      inputSchema: geometryQuerySchema,
      annotations: { readOnlyHint: true },
    },
    (options) => run(() => request('/geometry', options)),
  );
  const modelingTools: Record<string, [string, string]> = {
    editKeyformBatch: [
      'edit_keyforms',
      'Author multiple existing keyforms in one atomic undo step, preserving current parameters and selection. Each frame gives explicit parameter coordinates (omitted parameters use source defaults) and edits by object GUID: indexed points in canvas or local space, rotation x/y/angle/scale, appearance opacity/drawOrder/multiply/screen. Parent transforms are applied before child canvas coordinates. First create parameter bindings/keys with edit_parameter_keys. No interpolated, locked or blend-shape forms; hidden objects may be authored. Repeated actual keyforms are rejected, including poses differing only in unbound parameters. Any failure rolls back the entire batch and identifies the frame/object. expectedRevision must match the last returned revision.',
    ],
    selectProject: [
      'select_project_resources',
      'Select Project resources by their keys and show their Inspector properties. Preserve the ArtMesh selection for image assignment.',
    ],
    editProjectResource: [
      'edit_project_resource',
      'Edit a native resource name, memo, source layer ID or replaced flag. Supported fields are listed in get_project_resources. Undoable and saved to CMO3.',
    ],
    createMeshesFromImages: [
      'create_meshes_from_images',
      'Create one four-vertex ArtMesh per model image, using its native canvas placement and a one-pixel border. New meshes have draw order 500 and belong to the selected part. One undo step.',
    ],
    assignModelImage: [
      'assign_model_image',
      'Assign a model image to unlocked ArtMeshes while preserving their mesh geometry and keyforms. Recalculate UVs from source coordinates and remove obsolete atlas inputs. One undo step.',
    ],
    setTextureMode: [
      'set_texture_mode',
      'Switch between model-image and texture-atlas display while preserving keyform geometry. Atlas mode requires an existing placement for each model image. Undoable and saved to CMO3.',
    ],
    deleteProjectImages: [
      'delete_project_images',
      'Delete model images unused by ArtMeshes, texture atlases or other native data. Preserve original layers. Undoable and saved to CMO3.',
    ],
    exportProjectImage: [
      'export_project_image',
      'Export a model image or original source layer as lossless PNG. Does not change the document.',
    ],
    createPart: [
      'create_part',
      'Create a native Part before the first selected object (first root item if selection is empty), optionally grouping the selection as children. Name, unique ID and draw order 0–1000; one undoable edit. Requires current expectedRevision.',
    ],
    movePartObjects: [
      'move_part_objects',
      'Move objects under parentGuid (null for Root), optionally before a sibling beforeGuid. Preserve selected parent/child relationships and native sibling order. Does not change the Deformer hierarchy. Undoable; rejects cycles, locks and stale expectedRevision.',
    ],
    deletePartObjects: [
      'delete_part_objects',
      'Delete selected objects and their Part descendants (subtree), or dissolve selected Parts retaining their child objects (partsOnly). Removes dependent glue and mask links; converts surviving deformer children. Unknown native references are rejected. Undoable; requires current expectedRevision.',
    ],
    pruneEmptyParts: [
      'prune_empty_parts',
      'Remove empty Part chains below parentGuid (null for the entire model), keeping the anchor and locked branches. Undoable native edit; requires current expectedRevision.',
    ],
    setObjectFlags: [
      'set_object_flags',
      'Set native visibility and/or lock flags for object GUIDs in one undoable CMO3 edit. Locked objects can be unlocked. Hiding a deformer hides its editing guides while child artwork continues to deform and render. Supply the current expectedRevision.',
    ],
    moveDeformerObjects: [
      'move_deformer_objects',
      'Move selected mesh, ArtPath or deformer GUIDs under deformerGuid (null for Root). Selected descendants travel with their selected parent, retaining the internal hierarchy. Coordinates are converted at each existing keyform. One undoable CMO3 edit; rejects cycles, locked targets and stale expectedRevision.',
    ],
    pruneEmptyDeformers: [
      'prune_empty_deformers',
      'Remove empty deformer chains below parentGuid, retaining that selected parent. null scans the entire model. Keeps locked branches and rejects external native references. Does not delete artwork. Supports undo and native saving; requires current expectedRevision.',
    ],
    editObjectProperties: [
      'edit_object_properties',
      'Edit Inspector properties for GUIDs in one undoable native CMO3 change. Read get_object_info.values for supported fields; only existing keyforms accept appearance changes. Opacity/intensity use 0–1, scale is a factor, angles use degrees, colors use #RRGGBB. null parents mean Root. Deformer changes convert each keyform at its own parameter keys. baseAngle shifts all relative angles to preserve poses; setting it to baseAngle + angle freezes the current rotation. Bézier divisions target edit level 2. expectedRevision must match the current scene.',
    ],
    setParameters: [
      'set_parameters',
      'Atomically set several preview parameter values by ID in one undo step. All values must lie within their source ranges.',
    ],
    parameterPanel: [
      'set_parameter_panel',
      'Set parameter row selection by GUID, folder collapse state, active-object filtering, snapping or order lock. Does not select model objects.',
    ],
    createParameter: [
      'create_parameter',
      'Create a native normal parameter with a unique ID, name, range, default and description in the specified parameter folder. Supports undo and CMO3 saving.',
    ],
    editParameter: [
      'edit_parameter',
      'Edit native normal parameter settings by GUID. The range must include existing keys. Renaming an ID retains the preview value and native GUID bindings.',
    ],
    createParameterGroup: [
      'create_parameter_folder',
      'Create a native parameter folder inside parentGuid. Folder GUIDs and child order are returned by get_scene_info.',
    ],
    renameParameterGroup: ['rename_parameter_folder', 'Rename a native parameter folder.'],
    moveParameterEntries: [
      'move_parameter_entries',
      'Move parameter or folder GUIDs into groupGuid, optionally before an existing child. A selected folder moves with its contents.',
    ],
    deleteParameterEntries: [
      'delete_parameter_entries',
      'Delete selected parameter or folder GUIDs, including all nested contents of selected folders. Removed parameter axes retain the current pose of linked objects. One undo step.',
    ],
    linkParameter: [
      'link_parameters',
      'Link a parameter with the next normal parameter in its folder for XY control, or separate it. Saves the native combined flag.',
    ],
    editParameterKeys: [
      'edit_parameter_keys',
      'Replace specified parameter axes for the given object GUIDs. Each key has value and optional previous to move an existing key while preserving its shape. New keys sample current interpolation; an empty keys array removes the axis and retains its current pose. Use get_scene_info parameters.bindings to preserve existing keys when adding presets. Requires unlocked objects; normal parameter grids only. One undo step.',
    ],
    setParameterDefaults: [
      'set_parameter_defaults',
      'Save current preview values as native parameter defaults. Omit ids to update all. Supports undo.',
    ],
    selectMany: [
      'select_objects',
      'Select several object GUIDs and optionally weighted vertices. Vertex indices refer to get_model_geometry.',
    ],
    selectRegion: [
      'select_model_region',
      'Select weighted edit vertices by a rectangle (two opposite corners), lasso polygon or brush path in canvas pixels. mode replaces, adds to, or subtracts from vertex weights. guids restrict candidates; Parts include their meshes. Omit guids to use selected objects, or all visible meshes when nothing is selected. Hidden/locked objects are skipped. Rectangle selects intersected objects; lasso/brush retain object selection. Optional brush settings override current settings for this operation only. Selection does not dirty the model or add an undo step. Requires current expectedRevision.',
    ],
    deformBrush: [
      'apply_deform_brush',
      'Apply a move, inflate or smooth brush stroke using at least two canvas-pixel points. Same algorithm as the viewport, with automatic sampling between points. guids restrict targets; omit to use selected objects. Parts include their meshes. Hidden/locked objects are skipped. Optional settings override current brush settings. selection supplies vertex weights (0–1); omit to use current weights, or pass {} to affect all target vertices. Only affected existing keyforms are edited; interpolated poses are rejected atomically. One stroke is one undo step; no-effect strokes preserve history. Requires current expectedRevision.',
    ],
    editVertices: [
      'edit_vertices',
      'Atomically edit mesh, ArtPath or warp vertices in canvas coordinates at existing keyforms. One command is one undo step.',
    ],
    createDeformer: [
      'create_deformer',
      'Create a native warp or rotation deformer around selected objects, or as a child of a selected deformer. Preserve child poses and hierarchy.',
    ],
    editRotation: [
      'edit_rotation',
      'Edit a rotation deformer at its existing keyform. Origin uses parent-local coordinates; angle uses degrees. Set preserveChildren=true with x/y only to reposition the pivot and compensate every direct child keyform at its own parameter keys, keeping child canvas shapes. One undo step.',
    ],
    editTopology: [
      'edit_mesh_topology',
      'Replace mesh topology using normalized UV coordinates in the active texture mode. Set textureMode to modelImage or atlas to switch modes atomically before interpreting the UVs; modelImage matches inline manual editing. Preserve retained vertex IDs using sourceIndex. Optional edges contain a, b vertex indices and native priority: 10 automatic triangulation, 20 user triangulation, 30 normal, 40 locked; include every triangle edge. Omit edges to fix all triangle edges. Rebind every keyform, deform path and glue reference. One undo step.',
    ],
    automaticMesh: [
      'generate_mesh',
      'Generate alpha-contour meshes with separate outside/inside vertex intervals and margins (source-image pixels), minimum boundary points and alpha threshold (0–254). Matches the live Automatic Mesh preview. Preserves keyforms, deform paths and glue anchors; all selected meshes form one undo step. Standard settings: outsideInterval=50, insideInterval=50, outsideMargin=14, insideMargin=14, minimumMargin=5, minimumBoundaryPoints=10, alphaThreshold=0.',
    ],
    createController: [
      'create_deform_path',
      'Add a deform path to a mesh using canvas coordinates, influence width and hardness.',
    ],
    createArtPath: [
      'create_art_path',
      'Create a native ArtPath drawable with editable curve points, line width and hexadecimal RGB color.',
    ],
    setGlue: [
      'set_glue',
      'Create or update glue between explicit vertex pairs of two meshes. weightA controls A toward B; weightB controls B toward A.',
    ],
    removeGlue: ['remove_glue', 'Remove a native glue object and its binding. Supports undo.'],
    editGlueWeights: [
      'edit_glue_weights',
      'Update weights for several glue objects in one undoable transaction.',
    ],
    editAtlases: [
      'edit_texture_atlases',
      'Create or edit atlas pages using assigned or unassigned model-image IDs from get_texture_atlases. Regenerate PNGs and native texture inputs. Each image may appear at most once; omitted images remain unassigned. Empty pages or an empty page list are allowed. Sizes must be powers of two from 64 to 8192. One undo step.',
    ],
    autoLayoutAtlas: [
      'auto_layout_texture_atlas',
      'Create or repack a texture atlas without calculating placements. value.atlasGuid identifies an existing page; omit to create one. Optional name/width/height retain existing values or default to Texture N and 1024×1024. addImages accepts unassigned (all unassigned images), visible (visible unassigned images), or an explicit array of unassigned model-image GUIDs; [] just repacks current items or creates an empty page. padding is a per-image pixel margin. Uses the same rectangular packing as the UI, retaining angles/aspect ratios and shrinking to fit. Other pages remain intact. Regenerates PNG/native bindings atomically in one undo step; requires current expectedRevision.',
    ],
    toolSettings: [
      'set_tool_settings',
      'Set selection, deformation and glue brush size, strength, shape, hardness, angle, or the new ArtPath line style.',
    ],
  };
  for (const schema of commandSchema.options) {
    const type = schema.shape.type.value,
      tool = modelingTools[type];
    if (!tool) continue;
    server.registerTool(
      tool[0],
      {
        description: tool[1],
        inputSchema: z.object(
          Object.fromEntries(
            Object.entries(schema.shape).filter(([key]) => key !== 'type' && key !== 'editId'),
          ),
        ),
      },
      (args) => run(() => request('/command', commandSchema.parse({ type, ...args }))),
    );
  }
  return server;
});
