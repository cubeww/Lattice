import { useEditor } from '../store';
import { PropertyInput, PropertyCheck } from '../inspector/PropertyInput';
import { useProjectActions, resourceKindLabel, resourceName } from './actions';
import type { ProjectResourceProperties } from '../../../shared/project';
import './project.css';

export function ProjectInspector() {
  const { state, command, t } = useEditor(),
    actions = useProjectActions();
  const project = state.project!,
    items = project.resources.filter((r) => state.projectSelection.includes(r.key)),
    r = items[0];
  if (!r) return null;
  const canEdit = state.previewReady,
    multiple = items.length > 1;
  const edit = (values: ProjectResourceProperties) =>
    command({ type: 'editProjectResource', key: r.key, values, expectedRevision: state.revision });
  const time = (value: number | undefined) =>
    value !== undefined && value >= 0 ? new Date(value).toLocaleString(state.locale) : '—';
  const allModels = items.every((r) => r.kind === 'modelImage'),
    meshes = [...new Set(items.flatMap((r) => r.meshGuids))];
  const read = (label: string, value: string | number) => (
    <div className="project-read-property" key={label}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
  return (
    <div className="inspector project-inspector panel-scroll" data-testid="project-inspector">
      <div className="inspector-section">
        {multiple ? `${items.length} ${t('projectSelection')}` : resourceKindLabel(r, t)}
      </div>
      <div key={JSON.stringify([items, state.preview?.id])}>
        {!multiple && r.editable.includes('name') && (
          <PropertyInput
            label={t('projectName')}
            value={r.name}
            maxLength={256}
            disabled={!canEdit}
            commit={(name) => edit({ name })}
          />
        )}
        {!multiple && r.kind === 'document' && (
          <>
            <div className="project-document-name">
              {state.document!.name}
              <small>.cmo3</small>
            </div>
            <p className="project-file-path">{state.document!.path}</p>
            {read(
              t('canvas'),
              `${state.document!.canvas.width} × ${state.document!.canvas.height}`,
            )}
            {read(t('projectSourceCount'), project.sourceCount)}
            {read(t('projectImageCount'), project.modelImageCount)}
            {read(t('projectAtlasCount'), project.atlasCount)}
            <label className="inspector-property">
              <span>{t('projectTextureMode')}</span>
              <select
                aria-label={t('projectTextureMode')}
                disabled={!canEdit}
                value={project.textureMode}
                onChange={(e) =>
                  command({
                    type: 'setTextureMode',
                    mode: e.target.value as 'atlas' | 'modelImage',
                    expectedRevision: state.revision,
                  })
                }
              >
                <option value="modelImage">{t('projectModelMode')}</option>
                <option value="atlas">{t('projectAtlasMode')}</option>
              </select>
            </label>
            <button className="project-action" disabled={!canEdit} onClick={actions.atlas}>
              {t('atlas')}
            </button>
          </>
        )}
        {(multiple || r.kind !== 'document') && (
          <>
            {read(t('projectMeshCount'), meshes.length)}
            {!allModels &&
              read(t('projectImageCount'), new Set(items.flatMap((r) => r.modelImageKeys)).size)}
            {read(t('projectAtlasCount'), new Set(items.flatMap((r) => r.atlasGuids)).size)}
          </>
        )}
        {!multiple &&
          r.width !== undefined &&
          read(t('projectDimensions'), `${r.width} × ${r.height}`)}
        {!multiple && r.kind === 'sourceImage' && (
          <>
            {read(t('projectImported'), time(r.importedAt))}
            {read(t('projectModified'), time(r.modifiedAt))}
          </>
        )}
        {!multiple && r.editable.includes('layerId') && (
          <PropertyInput
            label={t('projectLayerId')}
            value={r.layerId}
            maxLength={256}
            disabled={!canEdit}
            commit={(layerId) => edit({ layerId })}
          />
        )}
        {!multiple && r.editable.includes('replaced') && (
          <PropertyCheck
            label={t('projectReplaced')}
            value={r.replaced}
            disabled={!canEdit}
            commit={(replaced) => edit({ replaced })}
          />
        )}
        {!multiple && r.editable.includes('memo') && (
          <PropertyInput
            label={t('projectMemo')}
            value={r.memo}
            multiline
            maxLength={16384}
            disabled={!canEdit}
            commit={(memo) => edit({ memo })}
          />
        )}
      </div>
      {!multiple && r.image && (
        <>
          <button
            className="project-image-card"
            onClick={() => actions.preview(r.key)}
            aria-label={t('projectViewImage')}
          >
            <img src={r.image.url} alt={r.name} />
          </button>
          <div className="project-image-meta">
            <span>
              {r.image.width} × {r.image.height} px
            </span>
            <button onClick={() => actions.exportImage(r.key)}>{t('projectExportImage')}</button>
          </div>
        </>
      )}
      {!multiple && r.current && <p className="project-current">{t('projectCurrent')}</p>}
      <div className="project-inspector-actions">
        {meshes.length > 0 && (
          <button onClick={() => actions.selectMeshes(items.map((r) => r.key))}>
            {t('projectSelectMeshes')}
          </button>
        )}
        {!allModels && items.some((r) => r.modelImageKeys.length) && r.kind !== 'document' && (
          <button onClick={() => actions.selectImages(items.map((r) => r.key))}>
            {t('projectSelectImages')}
          </button>
        )}
        {!multiple && r.sourceKey && (
          <button onClick={() => actions.locateSource(r.sourceKey!)}>
            {t('projectLocateSource')}
          </button>
        )}
        {allModels && (
          <button disabled={!canEdit} onClick={() => actions.create(items.map((r) => r.key))}>
            {t('projectCreateMeshes')}
          </button>
        )}
        {allModels && !multiple && (
          <button
            disabled={!canEdit || !actions.editableMeshes}
            onClick={() => actions.assign(r.key)}
          >
            {t('projectAssign')}
          </button>
        )}
        {allModels && (
          <button
            disabled={!canEdit || items.some((r) => r.meshGuids.length || r.atlasGuids.length)}
            title={
              items.some((r) => r.meshGuids.length || r.atlasGuids.length)
                ? t('projectImageUsed')
                : undefined
            }
            onClick={() => actions.remove(items.map((r) => r.key))}
          >
            {t('projectDeleteImages')}
          </button>
        )}
      </div>
      {multiple && (
        <ul className="project-selected-list">
          {items.map((r) => (
            <li key={r.key}>{resourceName(r, t)}</li>
          ))}
        </ul>
      )}
      {actions.node}
    </div>
  );
}
