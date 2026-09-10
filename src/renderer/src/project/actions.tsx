import { useEffect, useState } from 'react';
import type { ProjectResource } from '../../../shared/project';
import { relatedProjectImages, relatedProjectMeshes } from '../../../shared/project';
import { locked } from '../../../core/model/selection';
import { useEditor } from '../store';
import { TreeDialog } from '../tree/TreeMenu';
import { AtlasDialog } from '../modeling/AtlasDialog';
import type { MessageKey } from '../i18n';

const labels: Record<ProjectResource['kind'], MessageKey> = {
  document: 'project',
  sourceRoot: 'projectSourceRoot',
  modelRoot: 'projectModelRoot',
  sourceImage: 'projectSourceImage',
  sourceGroup: 'projectSourceGroup',
  sourceLayer: 'projectSourceLayer',
  modelGroup: 'projectModelGroup',
  modelImage: 'projectModelImage',
  imageInput: 'projectImageInput',
};
export const resourceKindLabel = (resource: ProjectResource, t: (key: MessageKey) => string) =>
  t(labels[resource.kind]);
export const resourceName = (resource: ProjectResource, t: (key: MessageKey) => string) =>
  resource.name || resourceKindLabel(resource, t);

function ImagePreview({ resource, close }: { resource: ProjectResource; close: () => void }) {
  const { t, perform } = useEditor(),
    [actual, setActual] = useState(false);
  return (
    <TreeDialog title={resource.name} close={close} className="project-image-dialog">
      <div className="project-preview-toolbar">
        <button aria-pressed={!actual} onClick={() => setActual(false)}>
          {t('projectFit')}
        </button>
        <button aria-pressed={actual} onClick={() => setActual(true)}>
          {t('projectActual')}
        </button>
        <span>
          {resource.image!.width} × {resource.image!.height}
        </span>
        <button onClick={() => perform(() => window.lattice.exportImageDialog(resource.key))}>
          {t('projectExportImage')}
        </button>
      </div>
      <div className={`project-image-stage${actual ? ' actual' : ''}`}>
        <img
          src={resource.image!.url}
          alt={resource.name}
          style={
            actual ? { width: resource.image!.width, height: resource.image!.height } : undefined
          }
        />
      </div>
      <footer>
        <button onClick={close}>{t('projectClose')}</button>
      </footer>
    </TreeDialog>
  );
}

export function useProjectActions() {
  const { state, command, perform, t } = useEditor();
  const [dialog, setDialog] = useState<
    | { kind: 'image'; key: string }
    | { kind: 'atlas' }
    | { kind: 'delete'; keys: string[]; revision: number }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDialog(null);
    setBusy(false);
  }, [state.document?.rootPartGuid]);
  const project = state.project,
    resources = project?.resources || [];
  const objects = new Map(state.document?.objects.map((o) => [o.guid, o]));
  const editableMeshes =
    state.selectedGuids.length > 0 &&
    state.selectedGuids.every((id) => objects.get(id)?.kind === 'mesh' && !locked(objects, id));
  const selectMeshes = (keys: string[]) =>
    command({ type: 'selectMany', guids: relatedProjectMeshes(project!, keys) });
  const selectImages = (keys: string[]) =>
    command({ type: 'selectProject', keys: relatedProjectImages(project!, keys) });
  const locateSelected = () =>
    command({
      type: 'selectProject',
      keys: resources
        .filter(
          (r) =>
            r.kind === 'modelImage' && r.meshGuids.some((id) => state.selectedGuids.includes(id)),
        )
        .map((r) => r.key),
    });
  const create = (keys: string[]) =>
    command({ type: 'createMeshesFromImages', keys, expectedRevision: state.revision });
  const assign = (key: string) =>
    command({
      type: 'assignModelImage',
      key,
      guids: state.selectedGuids,
      expectedRevision: state.revision,
    });
  const remove = (keys: string[]) => setDialog({ kind: 'delete', keys, revision: state.revision });
  const close = () => {
    if (!busy) setDialog(null);
  };
  const previewResource =
    dialog?.kind === 'image' ? resources.find((r) => r.key === dialog.key && r.image) : undefined;
  const items =
    dialog?.kind === 'delete' ? resources.filter((r) => dialog.keys.includes(r.key)) : [];
  const node =
    state.document &&
    project &&
    (previewResource ? (
      <ImagePreview resource={previewResource} close={close} />
    ) : dialog?.kind === 'atlas' ? (
      <AtlasDialog close={close} />
    ) : dialog?.kind === 'delete' ? (
      <TreeDialog title={t('projectDeleteImages')} close={close}>
        <p>{t('projectDeleteHint')}</p>
        <ul className="project-delete-list">
          {items.map((r) => (
            <li key={r.key}>{r.name}</li>
          ))}
        </ul>
        <footer>
          <button disabled={busy} onClick={close}>
            {t('cancel')}
          </button>
          <button
            className="danger"
            disabled={busy || !items.length}
            onClick={() => {
              setBusy(true);
              perform(async () => {
                try {
                  await window.lattice.command({
                    type: 'deleteProjectImages',
                    keys: dialog.keys,
                    expectedRevision: dialog.revision,
                  });
                  setDialog(null);
                } finally {
                  setBusy(false);
                }
              });
            }}
          >
            {t('partConfirmDelete')}
          </button>
        </footer>
      </TreeDialog>
    ) : null);
  return {
    selectMeshes,
    selectImages,
    locateSelected,
    create,
    assign,
    remove,
    editableMeshes,
    node,
    preview: (key: string) => setDialog({ kind: 'image', key }),
    atlas: () => setDialog({ kind: 'atlas' }),
    exportImage: (key: string) => perform(() => window.lattice.exportImageDialog(key)),
    locateSource: (key: string) => command({ type: 'selectProject', keys: [key] }),
  };
}
