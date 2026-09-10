import {
  FolderOpen,
  FilePlus2,
  ArrowUpRight,
  FileBox,
  BoxSelect,
  Grid2X2,
  Scan,
  Minus,
  Plus,
  X,
  CircleAlert,
  LoaderCircle,
} from 'lucide-react';
import { useEditor } from '../store';
import { Brand, IconButton } from '../components';
import { SourceCanvas } from './SourceCanvas';
import type { ViewState } from '../../../shared/types';
import { useManualMeshSession } from '../modeling/manual-mesh-session';

export function Viewport() {
  const { state, command, t, perform, open } = useEditor();
  const meshSession = useManualMeshSession();
  const doc = state.document;
  const patch = (value: Partial<ViewState>) => command({ type: 'view', value });
  return (
    <div className="viewport-panel">
      {doc && (
        <div className="document-bar">
          <FileBox size={14} />
          <strong>{doc.name}</strong>
          <span className="document-extension">.cmo3</span>
          {state.dirty && <span className="dirty-dot" />}
          <IconButton
            icon={X}
            label={t('close')}
            disabled={!!meshSession}
            onClick={() => perform(() => window.lattice.closeDocument())}
          />
          <div className="document-bar-spacer" />
          {state.preview && (
            <span className="preview-badge">
              <span className="status-dot" />
              {t('sourcePreview')}
            </span>
          )}
        </div>
      )}
      {doc && (
        <div className="viewport-tools">
          <IconButton
            icon={BoxSelect}
            label={t('mesh')}
            active={state.view.mesh}
            onClick={() => patch({ mesh: !state.view.mesh })}
          />
          <IconButton
            icon={Grid2X2}
            label={t('grid')}
            active={state.view.grid}
            onClick={() => patch({ grid: !state.view.grid })}
          />
          <span className="toolbar-divider" />
          <span className="canvas-size mono">
            {doc.canvas.width} × {doc.canvas.height}
          </span>
          <span className="document-bar-spacer" />
          {!!state.preview?.warnings.length && (
            <span className="preview-warning" title={state.preview.warnings.join('\n')}>
              <CircleAlert size={12} />
              {t('partialPreview')}
            </span>
          )}
        </div>
      )}
      <div
        className={`viewport-surface ${doc && state.preview ? `background-${state.view.background}` : ''}`}
      >
        {!doc ? (
          <div className="welcome">
            <div className="welcome-brand">
              <Brand large />
              <span>Lattice</span>
            </div>
            <span className="eyebrow">{t('firstStage')}</span>
            <h1>{t('welcome')}</h1>
            <p>{t('intro')}</p>
            <div className="welcome-actions">
              <button
                className="secondary-button"
                onClick={() => perform(() => window.lattice.newDocument())}
              >
                <FilePlus2 size={16} />
                {t('newModel')}
                <kbd>Ctrl N</kbd>
              </button>
              <button className="primary-button" onClick={() => open()}>
                <FolderOpen size={16} />
                {t('openButton')}
                <kbd>Ctrl O</kbd>
              </button>
              {state.sampleAvailable && (
                <button
                  className="secondary-button"
                  onClick={() => perform(() => window.lattice.openSample())}
                >
                  {t('sample')}
                  <ArrowUpRight size={15} />
                </button>
              )}
            </div>
            {state.recentFiles.length > 0 && (
              <div className="recent-files">
                <span className="section-caption">{t('recent')}</span>
                {state.recentFiles.slice(0, 4).map((path) => (
                  <button key={path} title={path} onClick={() => open(path)}>
                    <FileBox size={15} />
                    <span>{path.split(/[\\/]/).pop()}</span>
                    <ArrowUpRight size={12} />
                  </button>
                ))}
              </div>
            )}
            <div className="welcome-footer">
              <span className="mini-pill">.cmo3</span>
              <span className="mini-pill">.psd</span>
              <span>{t('sourcePreview')}</span>
              <span>MCP</span>
            </div>
          </div>
        ) : (
          <>
            {state.preview && <SourceCanvas key={state.preview.id} />}
            {!state.previewReady && !state.previewError && (
              <div className="loading-state">
                <LoaderCircle size={18} className="spin" />
                {t('previewLoading')}
              </div>
            )}
            {state.previewError && (
              <div className="preview-error">
                <CircleAlert size={28} />
                <strong>{t('previewFailed')}</strong>
                <p>{state.previewError}</p>
                <p>{t('nativeHint')}</p>
              </div>
            )}
          </>
        )}
      </div>
      <div className="view-controls">
        <select
          aria-label={t('background')}
          value={state.view.background}
          onChange={(e) => patch({ background: e.target.value as ViewState['background'] })}
        >
          <option value="checker">{t('checker')}</option>
          <option value="white">{t('white')}</option>
          <option value="dark">{t('dark')}</option>
        </select>
        <span className="toolbar-divider" />
        <IconButton
          icon={Minus}
          label={t('zoomOut')}
          disabled={!state.previewReady}
          onClick={() => patch({ zoom: Math.max(0.05, state.view.zoom / 1.2) })}
        />
        <span className="zoom-value mono">
          {Math.round(state.view.zoom * 100)}
          <span>%</span>
        </span>
        <IconButton
          icon={Plus}
          label={t('zoomIn')}
          disabled={!state.previewReady}
          onClick={() => patch({ zoom: Math.min(8, state.view.zoom * 1.2) })}
        />
        <span className="toolbar-divider" />
        <button
          className="actual-button mono"
          title={t('actual')}
          disabled={!state.previewReady}
          onClick={() => patch({ zoom: 1, panX: 0, panY: 0 })}
        >
          1:1
        </button>
        <IconButton
          icon={Scan}
          label={t('fit')}
          disabled={!state.previewReady}
          onClick={() => window.dispatchEvent(new Event('lattice:fit'))}
        />
        <span className="document-bar-spacer" />
        <span className="viewport-help">{t('shortcuts')}</span>
      </div>
    </div>
  );
}
