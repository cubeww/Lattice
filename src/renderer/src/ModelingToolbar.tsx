import { AtlasDialog } from './modeling/AtlasDialog';
import { GlueDialog } from './modeling/GlueDialog';
import {
  MousePointer2,
  Hand,
  Lasso,
  Paintbrush,
  Brush,
  Network,
  RotateCw,
  LocateFixed,
  Triangle,
  Workflow,
  Spline,
  PenTool,
  Link2,
  Images,
} from 'lucide-react';
import { useState } from 'react';
import { DeformerDialog } from './modeling/DeformerDialog';
import { MeshEditor } from './modeling/MeshEditor';
import { AutomaticMeshDialog } from './modeling/AutomaticMeshDialog';
import { IconButton } from './components';
import { useEditor } from './store';
import { useManualMeshSession } from './modeling/manual-mesh-session';
export const canvasTools = {
  select: MousePointer2,
  pan: Hand,
  lasso: Lasso,
  brushSelect: Paintbrush,
  deformBrush: Brush,
  rotationDraw: LocateFixed,
  deformPath: Spline,
  artPath: PenTool,
  glue: Link2,
};
export function ModelingToolbar() {
  const { state, command, t } = useEditor();
  const meshSession = useManualMeshSession();
  const [dialog, setDialog] = useState<
    'warp' | 'rotation' | 'mesh' | 'autoMesh' | 'glue' | 'atlas' | null
  >(null);
  const selectedMeshes = state.selectedGuids.filter((id) =>
    state.document?.objects.some((o) => o.guid === id && o.kind === 'mesh'),
  );
  return (
    <>
      <div
        className="modeling-toolbar"
        role="toolbar"
        aria-label={t('modelingTools')}
        inert={!!meshSession}
      >
        <span className="edit-level-label">{t('editLevel')}</span>
        {([1, 2, 3] as const).map((level) => (
          <button
            key={level}
            type="button"
            className={'edit-level' + (state.view.editLevel === level ? ' active' : '')}
            aria-label={t('editLevel') + ' ' + level}
            title={t(level === 1 ? 'level1Hint' : level === 2 ? 'level2Hint' : 'level3Hint')}
            aria-pressed={state.view.editLevel === level}
            disabled={!state.document}
            onClick={() => command({ type: 'view', value: { editLevel: level } })}
          >
            {level}
          </button>
        ))}
        <span className="toolbar-divider" />
        <IconButton
          icon={Images}
          label={t('atlas')}
          disabled={!state.previewReady}
          onClick={() => setDialog('atlas')}
        />
        <IconButton
          icon={Triangle}
          label={t('meshEdit')}
          disabled={!state.previewReady || selectedMeshes.length !== 1}
          onClick={() => setDialog('mesh')}
        />
        <IconButton
          icon={Workflow}
          label={t('autoMesh')}
          disabled={!state.previewReady || !selectedMeshes.length}
          onClick={() => setDialog('autoMesh')}
        />
        <span className="toolbar-divider" />
        <IconButton
          icon={Network}
          label={t('createWarp')}
          disabled={!state.previewReady}
          onClick={() => setDialog('warp')}
        />
        <IconButton
          icon={RotateCw}
          label={t('createRotation')}
          disabled={!state.previewReady}
          onClick={() => setDialog('rotation')}
        />
        <IconButton
          icon={LocateFixed}
          label={t('rotationDraw')}
          disabled={!state.previewReady}
          active={state.view.tool === 'rotationDraw'}
          onClick={() => command({ type: 'view', value: { tool: 'rotationDraw' } })}
        />
        <span className="toolbar-divider" />
        {(['select', 'lasso', 'brushSelect', 'deformPath', 'deformBrush'] as const).map((tool) => (
          <IconButton
            key={tool}
            icon={canvasTools[tool]}
            label={t(tool)}
            active={state.view.tool === tool}
            disabled={!state.previewReady}
            onClick={() => command({ type: 'view', value: { tool } })}
          />
        ))}
        <IconButton
          icon={Link2}
          label={t('glue')}
          disabled={!state.previewReady}
          active={state.view.tool === 'glue'}
          onClick={() => setDialog('glue')}
        />
        <IconButton
          icon={PenTool}
          label={t('artPath')}
          disabled={!state.previewReady}
          active={state.view.tool === 'artPath'}
          onClick={() => command({ type: 'view', value: { tool: 'artPath' } })}
        />
        <span className="toolbar-divider" />
        <IconButton
          icon={Hand}
          label={t('pan')}
          disabled={!state.previewReady}
          active={state.view.tool === 'pan'}
          onClick={() => command({ type: 'view', value: { tool: 'pan' } })}
        />
      </div>
      {dialog === 'atlas' ? (
        <AtlasDialog close={() => setDialog(null)} />
      ) : dialog === 'glue' ? (
        <GlueDialog close={() => setDialog(null)} />
      ) : dialog === 'mesh' ? (
        <MeshEditor guid={selectedMeshes[0]} close={() => setDialog(null)} />
      ) : dialog === 'autoMesh' ? (
        <AutomaticMeshDialog guids={selectedMeshes} close={() => setDialog(null)} />
      ) : (
        dialog && <DeformerDialog kind={dialog} close={() => setDialog(null)} />
      )}
    </>
  );
}
