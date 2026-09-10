import {
  Check,
  X,
  MousePointer2,
  Lasso,
  PenTool,
  Eraser,
  Hand,
  Trash2,
  Network,
  Grid2X2,
  Undo2,
  Redo2,
  Scan,
} from 'lucide-react';
import { useEditor } from '../store';
import { IconButton } from '../components';
import { useManualMeshSession, useManualMeshState } from './manual-mesh-session';

export function MeshEditBar() {
  const session = useManualMeshSession(),
    snapshot = useManualMeshState(),
    { t } = useEditor();
  if (!session || !snapshot) return null;
  return (
    <div
      className="mesh-edit-bar"
      data-testid="mesh-edit-mode"
      role="region"
      aria-label={t('meshEditMode')}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="mesh-edit-heading">
        <strong>{t('meshEditMode')}</strong>
        <span title={session.name}>{session.name}</span>
        <button
          className="primary"
          onClick={session.finish}
          disabled={!snapshot.ready || !snapshot.valid || snapshot.busy}
          title={t('meshEditFinish') + ' · Enter'}
        >
          <Check size={16} />
          {t('meshEditFinish')}
        </button>
        <IconButton
          icon={X}
          label={t('cancel')}
          disabled={snapshot.busy}
          onClick={session.cancel}
        />
      </div>
      <div className="mesh-edit-status">
        <label>
          <input
            type="checkbox"
            checked={snapshot.showOthers}
            onChange={(e) => session.setShowOthers(e.target.checked)}
            disabled={snapshot.busy}
          />
          {t('meshEditShowOthers')}
        </label>
        <span>
          {snapshot.ready
            ? `${snapshot.vertices} ${t('vertices')} · ${snapshot.triangles} ${t('autoMeshTriangles')}`
            : t('meshEditLoading')}
        </span>
      </div>
      {(snapshot.error || (snapshot.ready && !snapshot.valid)) && (
        <p role="alert">{snapshot.error || t('meshEditInvalid')}</p>
      )}
    </div>
  );
}

export function MeshEditTools() {
  const session = useManualMeshSession(),
    snapshot = useManualMeshState(),
    { t } = useEditor();
  if (!session || !snapshot) return null;
  const disabled = !snapshot.ready || snapshot.busy;
  return (
    <div className="tool-details panel-scroll mesh-edit-tools">
      <div className="mesh-edit-tool-row" role="toolbar" aria-label={t('meshEditMode')}>
        {(
          [
            ['select', MousePointer2, 'meshEditSelect'],
            ['lasso', Lasso, 'lasso'],
            ['add', PenTool, 'addVertex'],
            ['erase', Eraser, 'meshEditErase'],
            ['pan', Hand, 'pan'],
          ] as const
        ).map(([tool, icon, label]) => (
          <IconButton
            key={tool}
            icon={icon}
            label={t(label)}
            active={snapshot.tool === tool}
            disabled={disabled}
            onClick={() => session.setTool(tool)}
          />
        ))}
        <span className="toolbar-divider" />
        <IconButton
          icon={Undo2}
          label={t('meshEditUndo')}
          disabled={disabled || !snapshot.canUndo}
          onClick={() => session.undo()}
        />
        <IconButton
          icon={Redo2}
          label={t('meshEditRedo')}
          disabled={disabled || !snapshot.canRedo}
          onClick={() => session.redo()}
        />
      </div>
      <div className="mesh-edit-tool-row">
        <button
          disabled={disabled}
          onClick={() => session.connect()}
          title={t('meshEditConnectHint')}
        >
          <Network size={14} />
          {t('meshEditConnect')}
        </button>
        <button
          disabled={disabled || snapshot.vertices + snapshot.triangles * 1.5 > 10000}
          onClick={() => session.subdivide()}
        >
          <Grid2X2 size={14} />
          {t('meshEditSubdivide')}
        </button>
        <IconButton
          icon={Trash2}
          label={t('removeVertex')}
          disabled={disabled || !snapshot.selected}
          onClick={() => session.remove()}
        />
        <IconButton
          icon={Scan}
          label={t('fit')}
          onClick={() => window.dispatchEvent(new Event('lattice:fit'))}
        />
      </div>
      {snapshot.tool === 'erase' && (
        <label className="mesh-eraser-size">
          <span>{t('meshEditEraserSize')}</span>
          <input
            key={snapshot.eraserSize}
            type="number"
            min={0.1}
            max={10000}
            step={1}
            defaultValue={snapshot.eraserSize}
            disabled={disabled}
            onBlur={(event) => {
              session.setEraserSize(Number.parseFloat(event.currentTarget.value));
              event.currentTarget.value = String(session.snapshot.eraserSize);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.value = String(snapshot.eraserSize);
              if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
            }}
          />
          <span>px</span>
        </label>
      )}
      <p>
        {t(
          snapshot.tool === 'add'
            ? 'meshEditAddHint'
            : snapshot.tool === 'erase'
              ? 'meshEditEraseHint'
              : snapshot.tool === 'pan'
                ? 'panToolHint'
                : 'meshEditSelectHint',
        )}
      </p>
      <span className="mesh-edit-shortcuts">{t('meshEditShortcuts')}</span>
    </div>
  );
}
