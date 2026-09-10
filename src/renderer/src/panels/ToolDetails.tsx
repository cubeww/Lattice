import { RotateCcw, Grid2X2, BoxSelect, Scan } from 'lucide-react';
import { useEditor } from '../store';
import { IconButton } from '../components';
import { canvasTools } from '../ModelingToolbar';
import { useManualMeshSession } from '../modeling/manual-mesh-session';
import { MeshEditTools } from '../modeling/MeshEditControls';

export function ToolDetails() {
  const { state, command, t } = useEditor();
  const meshSession = useManualMeshSession();
  if (meshSession) return <MeshEditTools />;
  const ToolIcon = canvasTools[state.view.tool],
    brush = ['brushSelect', 'deformBrush', 'glue'].includes(state.view.tool);
  const settings = state.toolSettings;
  return (
    <div className="tool-details panel-scroll">
      <div className="tool-heading">
        <ToolIcon size={16} />
        <strong>{t(state.view.tool)}</strong>
        <kbd>
          {
            {
              select: 'V',
              pan: 'H',
              lasso: 'L',
              brushSelect: 'B',
              deformBrush: 'D',
              rotationDraw: 'R',
              deformPath: 'P',
              artPath: 'A',
              glue: 'G',
            }[state.view.tool]
          }
        </kbd>
      </div>
      <p>
        {t(
          state.view.tool === 'select'
            ? 'selectToolHint'
            : state.view.tool === 'pan'
              ? 'panToolHint'
              : state.view.tool === 'lasso'
                ? 'lassoHint'
                : state.view.tool === 'brushSelect'
                  ? 'brushSelectHint'
                  : state.view.tool === 'rotationDraw'
                    ? 'rotationDrawHint'
                    : state.view.tool === 'glue'
                      ? 'glueHint'
                      : ['artPath', 'deformPath'].includes(state.view.tool)
                        ? 'pathHint'
                        : 'deformBrushHint',
        )}
      </p>
      {['artPath', 'deformPath'].includes(state.view.tool) && (
        <>
          <label className="property">
            <span>{t('pathWidth')}</span>
            <input
              aria-label={t('pathWidth')}
              type="number"
              min="0.1"
              max="1000"
              step="0.1"
              value={state.view.tool === 'artPath' ? settings.pathWidth : settings.size * 2}
              onChange={(e) => {
                if (e.target.validity.valid)
                  command({
                    type: 'toolSettings',
                    value:
                      state.view.tool === 'artPath'
                        ? { pathWidth: Number(e.target.value) }
                        : { size: Number(e.target.value) / 2 },
                  });
              }}
            />
          </label>
          {state.view.tool === 'artPath' && (
            <label className="property">
              <span>{t('pathColor')}</span>
              <input
                type="color"
                aria-label={t('pathColor')}
                value={settings.pathColor}
                onChange={(e) =>
                  command({ type: 'toolSettings', value: { pathColor: e.target.value } })
                }
              />
            </label>
          )}
        </>
      )}
      {state.view.tool === 'deformBrush' && (
        <div className="brush-modes">
          {(['move', 'inflate', 'smooth'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={settings.brushMode === mode}
              onClick={() => command({ type: 'toolSettings', value: { brushMode: mode } })}
            >
              {t(
                mode === 'move' ? 'moveBrush' : mode === 'inflate' ? 'inflateBrush' : 'smoothBrush',
              )}
            </button>
          ))}
        </div>
      )}
      {brush && (
        <div className="brush-settings">
          <label className="property">
            <span>{t('brushShape')}</span>
            <select
              aria-label={t('brushShape')}
              value={settings.shape}
              onChange={(e) =>
                command({
                  type: 'toolSettings',
                  value: { shape: e.target.value as 'circle' | 'square' },
                })
              }
            >
              <option value="circle">{t('circle')}</option>
              <option value="square">{t('square')}</option>
            </select>
          </label>
          {(['size', 'strength', 'hardness', 'angle'] as const).map((key) => (
            <label className="property" key={key}>
              <span>
                {t(
                  key === 'size'
                    ? 'brushSize'
                    : key === 'strength'
                      ? 'brushStrength'
                      : key === 'hardness'
                        ? 'brushHardness'
                        : 'brushAngle',
                )}
              </span>
              <input
                type="number"
                aria-label={t(
                  key === 'size'
                    ? 'brushSize'
                    : key === 'strength'
                      ? 'brushStrength'
                      : key === 'hardness'
                        ? 'brushHardness'
                        : 'brushAngle',
                )}
                min={key === 'size' ? 0.1 : key === 'angle' ? -180 : key === 'strength' ? 1 : 0}
                max={key === 'size' ? 10000 : key === 'angle' ? 180 : 100}
                step={key === 'size' ? 0.1 : 1}
                value={
                  key === 'strength' || key === 'hardness'
                    ? Math.round(settings[key] * 100)
                    : settings[key]
                }
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (e.target.validity.valid)
                    command({
                      type: 'toolSettings',
                      value: { [key]: key === 'strength' || key === 'hardness' ? n / 100 : n },
                    });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {!!Object.keys(state.pointSelection).length && (
        <div className="point-count">
          {t('selectedPoints')}:{' '}
          {Object.values(state.pointSelection).reduce(
            (n, points) => n + Object.values(points).filter((w) => w > 0).length,
            0,
          )}{' '}
          <button onClick={() => command({ type: 'selectMany', guids: state.selectedGuids })}>
            {t('clearPoints')}
          </button>
        </div>
      )}
      <div className="tool-options">
        <IconButton
          icon={BoxSelect}
          label={t('mesh')}
          active={state.view.mesh}
          onClick={() => command({ type: 'view', value: { mesh: !state.view.mesh } })}
        />
        <IconButton
          icon={Grid2X2}
          label={t('grid')}
          active={state.view.grid}
          onClick={() => command({ type: 'view', value: { grid: !state.view.grid } })}
        />
        <IconButton
          icon={Scan}
          label={t('fit')}
          onClick={() => window.dispatchEvent(new Event('lattice:fit'))}
        />
        <IconButton
          icon={RotateCcw}
          label={t('resetView')}
          onClick={() => {
            command({ type: 'view', value: { panX: 0, panY: 0 } });
            window.dispatchEvent(new Event('lattice:fit'));
          }}
        />
      </div>
    </div>
  );
}
