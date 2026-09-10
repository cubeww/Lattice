import { useEffect, useRef, type ComponentType } from 'react';
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import { ObjectTree } from './panels/Tree';
import { Inspector } from './panels/Inspector';
import { ToolDetails } from './panels/ToolDetails';
import { Parameters } from './panels/Parameters';
import { Project, Log } from './panels/Project';
import { Viewport } from './viewport/Viewport';
import { useEditor } from './store';
import type { MessageKey } from './i18n';
import { useManualMeshSession } from './modeling/manual-mesh-session';

function editLocked(Component: ComponentType) {
  return function ModeLockedPanel() {
    const session = useManualMeshSession();
    return (
      <div className="mode-locked-panel" inert={!!session}>
        <Component />
      </div>
    );
  };
}

const components = {
  parts: editLocked(() => <ObjectTree />),
  deformers: editLocked(() => <ObjectTree deformers />),
  inspector: editLocked(Inspector),
  tools: ToolDetails,
  parameters: editLocked(Parameters),
  project: editLocked(Project),
  log: Log,
  viewport: Viewport,
};
const ids = Object.keys(components);
function Tab(props: IDockviewPanelHeaderProps) {
  const { t } = useEditor();
  return (
    <div className="panel-tab">
      <span>{t(props.api.id as MessageKey)}</span>
    </div>
  );
}
export function Workspace() {
  const { state, t } = useEditor();
  const api = useRef<DockviewApi | null>(null);
  const subscription = useRef<{ dispose(): void } | null>(null);
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveLayout = () => {
    if (pendingSave.current === null) return;
    clearTimeout(pendingSave.current);
    pendingSave.current = null;
    if (api.current)
      localStorage.setItem('lattice.workspace', JSON.stringify(api.current.toJSON()));
  };
  const reset = () => {
    if (!api.current) return;
    const dock = api.current;
    dock.clear();
    dock.addPanel({
      id: 'viewport',
      component: 'viewport',
      title: t('viewport'),
      minimumWidth: 350,
    });
    dock.addPanel({
      id: 'tools',
      component: 'tools',
      title: t('tools'),
      position: { referencePanel: 'viewport', direction: 'left' },
      initialWidth: 292,
      minimumWidth: 235,
    });
    dock.addPanel({
      id: 'parts',
      component: 'parts',
      title: t('parts'),
      position: { referencePanel: 'tools', direction: 'left' },
      initialWidth: 242,
      minimumWidth: 195,
    });
    dock.addPanel({
      id: 'project',
      component: 'project',
      title: t('project'),
      position: { referencePanel: 'parts', direction: 'within' },
    });
    dock.addPanel({
      id: 'deformers',
      component: 'deformers',
      title: t('deformers'),
      position: { referencePanel: 'parts', direction: 'below' },
      initialHeight: 340,
      minimumHeight: 150,
    });
    dock.addPanel({
      id: 'log',
      component: 'log',
      title: t('log'),
      position: { referencePanel: 'deformers', direction: 'within' },
    });
    dock.addPanel({
      id: 'inspector',
      component: 'inspector',
      title: t('inspector'),
      position: { referencePanel: 'tools', direction: 'below' },
      initialHeight: 280,
      minimumHeight: 130,
    });
    dock.addPanel({
      id: 'parameters',
      component: 'parameters',
      title: t('parameters'),
      position: { referencePanel: 'inspector', direction: 'below' },
      initialHeight: 350,
      minimumHeight: 150,
      minimumWidth: 280,
    });
    dock.getPanel('parts')?.api.setActive();
    dock.getPanel('deformers')?.api.setActive();
    dock.getPanel('viewport')?.api.setActive();
    dock.getPanel('tools')?.group.api.setSize({ height: 155 });
    dock.getPanel('inspector')?.group.api.setSize({ height: 250 });
  };
  const ready = (event: DockviewReadyEvent) => {
    api.current = event.api;
    const saved = localStorage.getItem('lattice.workspace');
    if (saved) {
      try {
        event.api.fromJSON(JSON.parse(saved));
        if (ids.some((id) => !event.api.getPanel(id)) || event.api.panels.length !== ids.length)
          throw new Error('Incomplete workspace');
      } catch {
        reset();
      }
    } else reset();
    subscription.current = event.api.onDidLayoutChange(() => {
      if (pendingSave.current !== null) clearTimeout(pendingSave.current);
      pendingSave.current = setTimeout(saveLayout, 250);
    });
  };
  useEffect(() => {
    const handler = () => reset();
    window.addEventListener('lattice:reset-layout', handler);
    window.addEventListener('pagehide', saveLayout);
    window.addEventListener('beforeunload', saveLayout);
    return () => {
      saveLayout();
      window.removeEventListener('lattice:reset-layout', handler);
      window.removeEventListener('pagehide', saveLayout);
      window.removeEventListener('beforeunload', saveLayout);
      subscription.current?.dispose();
    };
  }, []);
  useEffect(() => {
    for (const panel of api.current?.panels || []) panel.api.setTitle(t(panel.id as MessageKey));
  }, [state.locale]);
  return (
    <div className="workspace">
      <DockviewReact
        components={components}
        defaultTabComponent={Tab}
        theme={themeLight}
        onReady={ready}
        disableFloatingGroups={false}
      />
    </div>
  );
}
