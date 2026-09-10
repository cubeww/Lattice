import { useEffect, useRef, useState } from 'react';
import {
  FolderOpen,
  Save,
  Undo2,
  Redo2,
  MousePointer2,
  Hand,
  LayoutDashboard,
  X,
  ChevronDown,
  Check,
  CircleHelp,
  Scan,
  BoxSelect,
  Grid2X2,
} from 'lucide-react';
import { useEditor } from './store';
import { Brand, IconButton } from './components';
import { Workspace } from './Workspace';
import { ModelingToolbar } from './ModelingToolbar';
import { FormEditing } from './forms/FormEditing';
import type { MessageKey } from './i18n';
import {
  getManualMeshSession,
  useManualMeshSession,
  useManualMeshState,
} from './modeling/manual-mesh-session';

export function App() {
  const { state, command, perform, open, t, error, dismissError } = useEditor();
  const meshSession = useManualMeshSession(),
    meshState = useManualMeshState();
  const undo = () => (meshSession ? meshSession.undo() : command({ type: 'undo' }));
  const redo = () => (meshSession ? meshSession.redo() : command({ type: 'redo' }));
  const canUndo = meshState ? meshState.canUndo && !meshState.busy : state.canUndo;
  const canRedo = meshState ? meshState.canRedo && !meshState.busy : state.canRedo;
  const [menu, setMenu] = useState<string | null>(null),
    [about, setAbout] = useState(false);
  const header = useRef<HTMLElement>(null);
  const current = useRef({ state, command, perform, open });
  current.current = { state, command, perform, open };
  const save = () => perform(() => window.lattice.saveDocument());
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) setMenu(null);
    };
    const keys = (event: KeyboardEvent) => {
      const { state, command, perform, open } = current.current;
      if (document.querySelector('[role=dialog][aria-modal=true],[data-form-edit-dialog]')) return;
      if (getManualMeshSession()) return;
      const input = (event.target as HTMLElement).matches(
        'input:not([type="range"]),textarea,select,[contenteditable="true"]',
      );
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        setMenu(null);
        setAbout(false);
        return;
      }
      if (modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        open();
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setMenu(null);
        perform(() => window.lattice.newDocument());
      }
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (state.document) {
          if (event.shiftKey) perform(() => window.lattice.saveDialog());
          else perform(() => window.lattice.saveDocument());
        }
      }
      if (input) return;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        command({ type: event.shiftKey ? 'redo' : 'undo' });
      }
      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        command({ type: 'redo' });
      }
      if ((event.target as HTMLElement).closest('.parameter-panel,.parameter-menu')) return;
      const tools = {
        v: 'select',
        h: 'pan',
        l: 'lasso',
        b: 'brushSelect',
        d: 'deformBrush',
        r: 'rotationDraw',
        p: 'deformPath',
        a: 'artPath',
        g: 'glue',
      } as const;
      if (!modifier && ['1', '2', '3'].includes(event.key) && state.document)
        command({ type: 'view', value: { editLevel: Number(event.key) as 1 | 2 | 3 } });
      if (!modifier && event.key.toLowerCase() in tools)
        command({
          type: 'view',
          value: { tool: tools[event.key.toLowerCase() as keyof typeof tools] },
        });
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', keys);
    };
  }, []);
  type Item = { label: MessageKey; action: () => void; disabled?: boolean; shortcut?: string };
  const items: Record<string, Item[]> = {
    file: [
      {
        label: 'newModel',
        disabled: !!meshSession,
        action: () => perform(() => window.lattice.newDocument()),
        shortcut: 'Ctrl N',
      },
      {
        label: 'open',
        disabled: !!meshSession,
        action: () => open(),
        shortcut: 'Ctrl O',
      },
      {
        label: 'save',
        action: save,
        disabled: !state.document || !!meshSession,
        shortcut: 'Ctrl S',
      },
      {
        label: 'saveAs',
        action: () => perform(() => window.lattice.saveDialog()),
        disabled: !state.document || !!meshSession,
        shortcut: 'Ctrl Shift S',
      },
      {
        label: 'close',
        action: () => perform(() => window.lattice.closeDocument()),
        disabled: !state.document || !!meshSession,
      },
    ],
    edit: [
      {
        label: 'undo',
        action: undo,
        disabled: !canUndo,
        shortcut: 'Ctrl Z',
      },
      {
        label: 'redo',
        action: redo,
        disabled: !canRedo,
        shortcut: 'Ctrl Shift Z',
      },
    ],
    show: [
      { label: 'fit', action: () => window.dispatchEvent(new Event('lattice:fit')), shortcut: 'F' },
      { label: 'mesh', action: () => command({ type: 'view', value: { mesh: !state.view.mesh } }) },
      { label: 'grid', action: () => command({ type: 'view', value: { grid: !state.view.grid } }) },
    ],
    window: [
      {
        label: 'resetLayout',
        disabled: !!meshSession,
        action: () => window.dispatchEvent(new Event('lattice:reset-layout')),
      },
    ],
    help: [{ label: 'about', action: () => setAbout(true) }],
  };
  return (
    <main className="app">
      <header ref={header}>
        <div className="menubar">
          <div className="app-brand">
            <Brand />
            <strong>Lattice</strong>
          </div>
          <div className="menubar-divider" />
          {(['file', 'edit', 'show', 'modeling', 'window', 'help'] as const).map((key) => (
            <div className="menu-anchor" key={key}>
              <button
                className={`menu-trigger ${menu === key ? 'open' : ''}`}
                aria-expanded={menu === key}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse')
                    setMenu((active) => (active === null ? null : key));
                }}
                onClick={() => setMenu(menu === key ? null : key)}
              >
                {t(key)}
              </button>
              {key === 'modeling' ? (
                <FormEditing open={menu === key} closeMenu={() => setMenu(null)} />
              ) : (
                menu === key && (
                  <div className="menu-popover" role="menu">
                    {items[key].map((item) => (
                      <button
                        role="menuitem"
                        key={item.label}
                        disabled={item.disabled}
                        onClick={() => {
                          setMenu(null);
                          item.action();
                        }}
                      >
                        {t(item.label)}
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          ))}
          <span className="header-spacer" />
          <span className="version-tag">0.1</span>
          <select
            className="locale-select"
            aria-label={t('language')}
            value={state.locale}
            onChange={(e) =>
              command({ type: 'locale', value: e.target.value as 'en' | 'zh-CN' | 'ja' })
            }
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </div>
        <div className="main-toolbar">
          <div className="mode-select">
            <LayoutDashboard size={15} />
            <strong>{t(meshSession ? 'meshEditMode' : 'modeling')}</strong>
            <ChevronDown size={12} />
          </div>
          <span className="toolbar-divider" />
          <IconButton
            icon={FolderOpen}
            label={t('open')}
            disabled={!!meshSession}
            onClick={() => open()}
          />
          <IconButton
            icon={Save}
            label={t('save')}
            disabled={!state.document || !!meshSession}
            onClick={save}
          />
          <span className="toolbar-divider" />
          <IconButton icon={Undo2} label={t('undo')} disabled={!canUndo} onClick={undo} />
          <IconButton icon={Redo2} label={t('redo')} disabled={!canRedo} onClick={redo} />
          <span className="toolbar-divider" />
          <ModelingToolbar />
          <span className="toolbar-divider" />
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
            disabled={!state.previewReady}
            onClick={() => window.dispatchEvent(new Event('lattice:fit'))}
          />
          <span className="header-spacer" />
          <span className="mode-label">{t('firstStage')}</span>
          <IconButton
            icon={LayoutDashboard}
            label={t('resetLayout')}
            disabled={!!meshSession}
            onClick={() => window.dispatchEvent(new Event('lattice:reset-layout'))}
          />
        </div>
      </header>
      <Workspace />
      <footer className="statusbar">
        <span className={`status-indicator ${state.dirty ? 'modified' : ''}`}>
          {state.dirty ? <span className="dirty-dot" /> : <Check size={12} />}{' '}
          {t(state.dirty ? 'modified' : state.document ? 'saved' : 'ready')}
        </span>
        <span className="status-divider" />
        {state.document ? (
          <>
            <span>
              {state.document.objects.length} {t('objects')}
            </span>
            <span>
              {state.document.parameters.length} {t('params')}
            </span>
          </>
        ) : (
          <span>{t('noDocument')}</span>
        )}
        <span className="header-spacer" />
        <span className="status-source">{state.document ? '.cmo3' : ''}</span>
        <span className="status-divider" />
        <span className="bridge-status">
          <span className={`status-dot ${state.bridge.connected ? '' : 'offline'}`} />
          {t(state.bridge.connected ? 'bridgeReady' : 'bridgeOffline')}
        </span>
      </footer>
      {error && (
        <div className="error-toast" role="alert">
          <CircleHelp size={18} />
          <p>{error}</p>
          <IconButton icon={X} label={t('closeNotice')} onClick={dismissError} />
        </div>
      )}
      {about && (
        <div className="modal-backdrop" onClick={() => setAbout(false)}>
          <section
            className="about-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('about')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-close">
              <IconButton icon={X} label={t('closeNotice')} onClick={() => setAbout(false)} />
            </div>
            <Brand large />
            <h2>Lattice</h2>
            <p>{t('aboutText')}</p>
            <div className="about-meta">
              <span>{t('aboutAuthor')}</span>
              <span aria-hidden="true">·</span>
              <span>{t('aboutLicense')}</span>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
