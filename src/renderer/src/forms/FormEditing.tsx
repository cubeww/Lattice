import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { defaultPasteSettings, type FormEdit, type PasteSettings } from '../../../shared/form-edit';
import type { SourceScene } from '../../../shared/scene';
import { suggestedPasteTargets } from '../../../core/model/form-edit';
import { locked } from '../../../core/model/selection';
import { useEditor } from '../store';
import type { MessageKey } from '../i18n';
import { getManualMeshSession } from '../modeling/manual-mesh-session';
import { getMeshPreview, subscribeMeshPreview } from '../modeling/mesh-preview';
import { FormDialog, type FormDialogData } from './FormDialog';
import { PasteSpecial } from './PasteSpecial';
import { PhysicsSettings } from '../physics/PhysicsSettings';
import './forms.css';

type Action =
  | 'copy'
  | 'paste'
  | 'blend'
  | 'flip'
  | 'scale'
  | 'reshapeWarp'
  | 'expandWarp'
  | 'revert'
  | 'updateOriginal'
  | 'deleteOriginals';
export function FormEditing({ open, closeMenu }: { open: boolean; closeMenu: () => void }) {
  const { state, t, perform, command } = useEditor();
  const activePreview = useSyncExternalStore(subscribeMeshPreview, getMeshPreview);
  const [submenu, setSubmenu] = useState(false),
    [physics, setPhysics] = useState(false),
    [special, setSpecial] = useState(false),
    [settings, setSettings] = useState<PasteSettings>(defaultPasteSettings);
  const [confirm, setConfirm] = useState(
    () => localStorage.getItem('lattice.confirmMultiPaste') !== 'false',
  );
  const [dialog, setDialog] = useState<FormDialogData | null>(null),
    [remove, setRemove] = useState(false),
    [loading, setLoading] = useState(false),
    [copied, setCopied] = useState(false);
  const current = useRef(state);
  current.current = state;
  const nodes = new Map(state.document?.objects.map((o) => [o.guid, o]));
  const selection = state.selectedGuids.flatMap((id) => {
    const o = nodes.get(id);
    return o && !locked(nodes, id) && o.guid !== state.document?.rootPartGuid && o.kind !== 'glue'
      ? [o]
      : [];
  });
  const ready =
    !!state.previewReady &&
    !getManualMeshSession() &&
    !dialog &&
    !remove &&
    !loading &&
    !activePreview;
  const geometry = selection.filter((o) => o.kind !== 'part'),
    warps = selection.filter((o) => o.kind === 'warp'),
    deformers = selection.filter((o) => ['warp', 'rotation'].includes(o.kind));
  useEffect(() => {
    if (!open) setSubmenu(false);
  }, [open]);
  useEffect(() => {
    if (!remove) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setRemove(false);
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [remove]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const act = (action: Action) => {
    closeMenu();
    if (!ready) return;
    if (action === 'deleteOriginals') {
      setRemove(true);
      return;
    }
    if (action === 'copy') {
      if (selection.length)
        perform(async () => {
          await window.lattice.command({
            type: 'copyForms',
            guids: selection.map((o) => o.guid),
            expectedRevision: state.revision,
          });
          setCopied(true);
        });
      return;
    }
    if (['reshapeWarp', 'expandWarp', 'updateOriginal', 'revert'].includes(action)) {
      const objects =
        action === 'reshapeWarp' || action === 'expandWarp'
          ? warps
          : action === 'updateOriginal'
            ? deformers
            : geometry.filter((o) => o.kind !== 'artpath');
      if (objects.length)
        command({
          type: 'editForms',
          expectedRevision: state.revision,
          value: {
            action: action as 'reshapeWarp' | 'expandWarp' | 'revert' | 'updateOriginal',
            guids: objects.map((o) => o.guid),
            editLevel: state.view.editLevel,
          },
        });
      return;
    }
    const guids = (action === 'paste' || action === 'blend' ? selection : geometry).map(
      (o) => o.guid,
    );
    if (!guids.length) return;
    setLoading(true);
    perform(async () => {
      try {
        const initial = state;
        const [response, clipboard] = await Promise.all([
          fetch(initial.preview!.sceneUrl),
          window.lattice.formClipboard(),
        ]);
        if (!response.ok) throw new Error(t('formChanged'));
        const scene: SourceScene & { revision: number } = await response.json();
        if (
          scene.revision !== initial.preview!.revision ||
          current.current.documentRevision !== initial.documentRevision ||
          JSON.stringify(initial.parameterValues) !==
            JSON.stringify(current.current.parameterValues)
        )
          throw new Error(t('formChanged'));
        let edit: FormEdit;
        if (action === 'paste' || action === 'blend') {
          if (!clipboard.items.length) return;
          const targets = suggestedPasteTargets(clipboard, scene, initial.document!.objects, guids);
          edit = {
            action: 'paste',
            clipboardSerial: clipboard.serial,
            targets,
            weight: action === 'blend' ? 0.5 : 1,
            settings: special ? settings : undefined,
          };
          if (
            action === 'paste' &&
            targets.length === guids.length &&
            (!confirm || (targets.length === 1 && clipboard.items.length === 1))
          ) {
            await window.lattice.command({
              type: 'editForms',
              value: edit,
              expectedRevision: current.current.revision,
            });
            return;
          }
        } else if (action === 'scale')
          edit = { action: 'scale', guids, factor: 1, currentOnly: false };
        else
          edit = {
            action: 'flip',
            guids,
            horizontal: true,
            vertical: false,
            parameterIds: [],
            flipRotationPosition: true,
            keepCulling: false,
          };
        setDialog({
          initial,
          scene,
          clipboard,
          edit,
          blend: action === 'blend',
          targetGuids: guids,
        });
      } finally {
        setLoading(false);
      }
    });
  };
  const actionRef = useRef(act);
  actionRef.current = act;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.repeat ||
        !['c', 'v', 'b'].includes(event.key.toLowerCase())
      )
        return;
      if (
        (event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]') ||
        document.querySelector('[aria-modal=true],[data-form-edit-dialog]') ||
        getManualMeshSession() ||
        getMeshPreview()
      )
        return;
      event.preventDefault();
      actionRef.current(
        ({ c: 'copy', v: 'paste', b: 'blend' } as const)[
          event.key.toLowerCase() as 'c' | 'v' | 'b'
        ],
      );
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const items: ({
    label: MessageKey;
    action: Action;
    disabled?: boolean;
    shortcut?: string;
  } | null)[] = [
    { label: 'copyForm', action: 'copy', disabled: !selection.length, shortcut: 'Ctrl Shift C' },
    {
      label: 'pasteForm',
      action: 'paste',
      disabled: !selection.length || !state.formClipboard.items.length,
      shortcut: 'Ctrl Shift V',
    },
    {
      label: 'blendForm',
      action: 'blend',
      disabled: !selection.length || !state.formClipboard.items.length,
      shortcut: 'Ctrl Shift B',
    },
  ];
  const rest: typeof items = [
    { label: 'flipForm', action: 'flip', disabled: !geometry.length },
    { label: 'scaleForm', action: 'scale', disabled: !geometry.length },
    {
      label: 'reshapeWarp',
      action: 'reshapeWarp',
      disabled: !warps.length || state.view.editLevel === 1,
    },
    null,
    { label: 'expandWarp', action: 'expandWarp', disabled: !warps.length },
    null,
    {
      label: 'revertForm',
      action: 'revert',
      disabled: !geometry.some((o) => o.kind !== 'artpath'),
    },
    { label: 'updateOriginal', action: 'updateOriginal', disabled: !deformers.length },
    {
      label: 'deleteOriginals',
      action: 'deleteOriginals',
      disabled: !state.document?.objects.some((o) => o.kind === 'warp' || o.kind === 'rotation'),
    },
  ];
  const renderItem = (item: (typeof items)[number], i: number) =>
    item ? (
      <button
        role="menuitem"
        key={item.action}
        disabled={!ready || item.disabled}
        onClick={() => act(item.action)}
      >
        <span>{t(item.label)}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>
    ) : (
      <div key={`separator-${i}`} role="separator" className="menu-separator" />
    );
  return (
    <>
      {open && (
        <div className="menu-popover" role="menu">
          <div className="form-submenu-anchor" onPointerEnter={() => setSubmenu(true)}>
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={submenu}
              onClick={() => setSubmenu((s) => !s)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setSubmenu(true);
                }
              }}
            >
              <span>{t('editForm')}</span>
              <ChevronRight size={14} />
            </button>
            {submenu && (
              <div
                className="menu-popover form-submenu"
                role="menu"
                aria-label={t('editForm')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    setSubmenu(false);
                  }
                }}
              >
                {items.map(renderItem)}
                <button
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    setSpecial(true);
                  }}
                >
                  <span>{t('pasteSpecial')}</span>
                  {special && <Check size={14} />}
                </button>
                <button
                  role="menuitemcheckbox"
                  aria-checked={confirm}
                  onClick={() => {
                    const next = !confirm;
                    setConfirm(next);
                    localStorage.setItem('lattice.confirmMultiPaste', String(next));
                    closeMenu();
                  }}
                >
                  <span>{t('confirmMultiPaste')}</span>
                  {confirm && <Check size={14} />}
                </button>
                <div role="separator" className="menu-separator" />
                {rest.map(renderItem)}
              </div>
            )}
          </div>
          <div role="separator" className="menu-separator" />
          <button
            role="menuitem"
            disabled={!ready}
            onPointerEnter={() => setSubmenu(false)}
            onClick={() => {
              closeMenu();
              setPhysics(true);
            }}
          >
            {t('physicsSettings')}
          </button>
        </div>
      )}
      {physics && state.document && state.preview && (
        <PhysicsSettings key={state.preview.id} close={() => setPhysics(false)} />
      )}
      {createPortal(
        <>
          {special && (
            <PasteSpecial
              settings={settings}
              change={setSettings}
              close={() => setSpecial(false)}
            />
          )}
          {dialog && (
            <FormDialog
              data={dialog}
              settings={special ? settings : undefined}
              close={() => setDialog(null)}
            />
          )}
          {remove && (
            <div className="modal-backdrop">
              <section
                className="modeling-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={t('deleteOriginals')}
              >
                <h2>{t('deleteOriginals')}</h2>
                <p>{t('deleteOriginalsHint')}</p>
                <footer>
                  <button onClick={() => setRemove(false)}>{t('cancel')}</button>
                  <button
                    className="primary"
                    onClick={() => {
                      setRemove(false);
                      command({
                        type: 'editForms',
                        expectedRevision: state.revision,
                        value: { action: 'deleteOriginals' },
                      });
                    }}
                  >
                    {t('formApply')}
                  </button>
                </footer>
              </section>
            </div>
          )}
          {(loading || copied) && (
            <div className="form-notice" role="status">
              {t(loading ? 'formLoading' : 'formCopied')}
            </div>
          )}
        </>,
        document.body,
      )}
    </>
  );
}
