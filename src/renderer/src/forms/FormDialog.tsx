import { useEffect, useRef, useState } from 'react';
import type { FormClipboard, FormEdit, PasteSettings } from '../../../shared/form-edit';
import { formEditSchema } from '../../../shared/form-edit';
import type { SourceScene } from '../../../shared/scene';
import type { EditorState } from '../../../shared/types';
import { descendant, editFormScene, formKind, formNodes } from '../../../core/model/form-edit';
import { useEditor } from '../store';
import { setMeshPreview } from '../modeling/mesh-preview';
import { FormWindow } from './FormWindow';

export interface FormDialogData {
  initial: EditorState;
  scene: SourceScene;
  clipboard: FormClipboard;
  edit: FormEdit;
  blend?: boolean;
  targetGuids: string[];
}
export function FormDialog({
  data,
  settings,
  close,
}: {
  data: FormDialogData;
  settings?: PasteSettings;
  close: () => void;
}) {
  const { state, t } = useEditor(),
    { initial, scene, clipboard, blend } = data;
  const [edit, setEdit] = useState(data.edit),
    [preview, setPreview] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [valid, setValid] = useState(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  const current = useRef(state);
  current.current = state;
  const value = edit.action === 'paste' ? { ...edit, settings } : edit;
  const signature = JSON.stringify(value);
  useEffect(() => {
    setValid(false);
    const frame = requestAnimationFrame(() => {
      try {
        const next = editFormScene(
          scene,
          formEditSchema.parse(value),
          initial.parameterValues,
          clipboard,
        );
        setMeshPreview({
          documentId: initial.preview!.id,
          documentRevision: initial.documentRevision,
          enabled: preview,
          scene: next,
          geometry: null,
        });
        setError('');
        setValid(true);
      } catch (error) {
        setMeshPreview({
          documentId: initial.preview!.id,
          documentRevision: initial.documentRevision,
          enabled: false,
          scene: null,
          geometry: null,
        });
        setError((error as Error).message);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [signature, preview]);
  useEffect(() => () => setMeshPreview(null), []);
  useEffect(() => {
    if (
      state.preview?.id !== initial.preview?.id ||
      state.documentRevision !== initial.documentRevision ||
      JSON.stringify(state.parameterValues) !== JSON.stringify(initial.parameterValues) ||
      (edit.action === 'paste' && state.formClipboard.serial !== clipboard.serial)
    )
      closeRef.current();
  }, [
    state.documentRevision,
    state.preview?.id,
    state.parameterValues,
    state.formClipboard.serial,
  ]);
  const title = t(
    edit.action === 'paste'
      ? blend
        ? 'blendForm'
        : 'pasteForm'
      : edit.action === 'flip'
        ? 'flipForm'
        : 'scaleForm',
  );
  const all = formNodes(scene),
    nodes = new Map(all.map((n) => [n.guid, n]));
  const parameters =
    edit.action === 'flip'
      ? initial.document!.parameters.filter((p) =>
          all.some(
            (n) =>
              edit.guids.some((id) => descendant(n, id, nodes)) &&
              n.bindings.some((b) => b.parameterId === p.id && b.keys.length > 1),
          ),
        )
      : [];
  return (
    <FormWindow title={title} close={close} busy={busy}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !valid) return;
          setBusy(true);
          try {
            await window.lattice.command({
              type: 'editForms',
              expectedRevision: current.current.revision,
              value: formEditSchema.parse(value),
            });
            closeRef.current();
          } catch (error) {
            setError(
              (error as Error).message.replace(
                /^Error invoking remote method '[^']+': Error: /,
                '',
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="form-window-body" disabled={busy}>
          {edit.action === 'paste' && (
            <>
              <div className="form-target-heading">
                <span>{t('formTarget')}</span>
                <span>{t('formSource')}</span>
              </div>
              <div className="form-targets">
                {data.targetGuids.map((guid) => {
                  const target = nodes.get(guid)!;
                  return (
                    <label className="form-target" key={guid}>
                      <span title={target.id}>
                        {initial.document!.objects.find((o) => o.guid === guid)?.name || target.id}
                      </span>
                      <select
                        aria-label={`${t('formSource')} · ${target.id}`}
                        value={edit.targets.find((p) => p.targetGuid === guid)?.sourceGuid || ''}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            targets: [
                              ...edit.targets.filter((p) => p.targetGuid !== guid),
                              ...(e.target.value
                                ? [{ targetGuid: guid, sourceGuid: e.target.value }]
                                : []),
                            ],
                          })
                        }
                      >
                        <option value="">{t('formSkip')}</option>
                        {clipboard.items
                          .filter((item) => item.kind === formKind(target))
                          .map((item) => (
                            <option key={item.guid} value={item.guid}>
                              {item.name} ({item.id})
                            </option>
                          ))}
                      </select>
                    </label>
                  );
                })}
              </div>
              {blend && (
                <label className="form-blend">
                  <span>{t('blendWeight')}</span>
                  <div>
                    <input
                      aria-label={t('blendWeight')}
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={edit.weight * 100}
                      onChange={(e) => setEdit({ ...edit, weight: e.target.valueAsNumber / 100 })}
                    />
                    <input
                      aria-label={`${t('blendWeight')} %`}
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(edit.weight * 100)}
                      onChange={(e) => setEdit({ ...edit, weight: e.target.valueAsNumber / 100 })}
                    />
                    <span>%</span>
                  </div>
                </label>
              )}
              <p className="form-hint">{t('formCurrentKey')}</p>
            </>
          )}
          {edit.action === 'scale' && (
            <>
              <label className="property">
                <span>{t('magnification')}</span>
                <div className="form-number">
                  <input
                    autoFocus
                    aria-label={t('magnification')}
                    type="number"
                    min={0.01}
                    max={10000}
                    step="any"
                    required
                    value={
                      Number.isFinite(edit.factor) ? Number((edit.factor * 100).toFixed(4)) : ''
                    }
                    onChange={(e) => setEdit({ ...edit, factor: e.target.valueAsNumber / 100 })}
                  />
                  <span>%</span>
                </div>
              </label>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={edit.currentOnly}
                  onChange={(e) => setEdit({ ...edit, currentOnly: e.target.checked })}
                />
                {t('currentFormOnly')}
              </label>
              <p className="form-hint">{t(edit.currentOnly ? 'formCurrentKey' : 'formAllKeys')}</p>
            </>
          )}
          {edit.action === 'flip' && (
            <>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={edit.horizontal}
                  onChange={(e) => setEdit({ ...edit, horizontal: e.target.checked })}
                />
                {t('flipHorizontal')}
              </label>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={edit.vertical}
                  onChange={(e) => setEdit({ ...edit, vertical: e.target.checked })}
                />
                {t('flipVertical')}
              </label>
              <div className="form-parameter-heading">{t('flipParameters')}</div>
              <div className="form-parameters">
                {parameters.length ? (
                  parameters.map((p) => (
                    <label key={p.id} className="radio-row">
                      <input
                        type="checkbox"
                        checked={edit.parameterIds.includes(p.id)}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            parameterIds: e.target.checked
                              ? [...edit.parameterIds, p.id]
                              : edit.parameterIds.filter((id) => id !== p.id),
                          })
                        }
                      />
                      <span title={p.id}>{p.name}</span>
                    </label>
                  ))
                ) : (
                  <p className="form-muted">{t('none')}</p>
                )}
              </div>
              <p className="form-hint">{t('flipParametersHint')}</p>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={edit.flipRotationPosition}
                  onChange={(e) => setEdit({ ...edit, flipRotationPosition: e.target.checked })}
                />
                {t('flipRotationPosition')}
              </label>
              <label className="radio-row">
                <input
                  type="checkbox"
                  checked={edit.keepCulling}
                  onChange={(e) => setEdit({ ...edit, keepCulling: e.target.checked })}
                />
                {t('keepCulling')}
              </label>
              <p className="form-hint">{t('formAllKeys')}</p>
            </>
          )}
          <label className="radio-row">
            <input
              type="checkbox"
              checked={preview}
              onChange={(e) => setPreview(e.target.checked)}
            />
            {t('formPreview')}
          </label>
          {error && (
            <p className="form-error" role="alert">
              {edit.action === 'paste' && !edit.targets.length ? t('formNoMatch') : error}
            </p>
          )}
        </fieldset>
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            {t('cancel')}
          </button>
          <button type="submit" className="primary" disabled={busy || !valid}>
            {t('formApply')}
          </button>
        </footer>
      </form>
    </FormWindow>
  );
}
