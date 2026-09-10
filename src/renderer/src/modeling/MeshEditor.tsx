import { useEffect, useRef } from 'react';
import { useEditor } from '../store';
import type { SourceScene } from '../../../shared/scene';
import type { MeshGenerationWorkspace } from '../../../shared/automatic-mesh';
import { modelImageScene } from '../../../core/model/model-image-scene';
import { locked } from '../../../core/model/selection';
import { ManualMeshSession, setManualMeshSession } from './manual-mesh-session';
import { setMeshPreview } from './mesh-preview';

/** Own the mode lifetime; the existing SourceCanvas owns all drawing and pointer input. */
export function MeshEditor({ close, guid }: { close: () => void; guid: string }) {
  const { state, t } = useEditor(),
    initial = useRef(state).current;
  const closeRef = useRef(close),
    sessionRef = useRef<ManualMeshSession | null>(null);
  closeRef.current = close;
  useEffect(() => {
    const abort = new AbortController();
    const object = initial.document!.objects.find((o) => o.guid === guid);
    const session = new ManualMeshSession(
      guid,
      object?.name || object?.id || guid,
      initial.preview!.id,
      initial.documentRevision,
      () => {
        if (!session.snapshot.ready || session.snapshot.busy) return;
        session.pointerUp();
        if (!session.snapshot.valid) return;
        if (!session.changed) {
          closeRef.current();
          return;
        }
        session.setBusy(true);
        void (async () => {
          try {
            const current = await window.lattice.state();
            if (
              current.preview?.id !== session.documentId ||
              current.documentRevision !== session.documentRevision
            )
              throw new Error(t('meshEditChanged'));
            await window.lattice.command({
              type: 'editTopology',
              guid,
              vertices: session.draft.vertices,
              indices: session.draft.indices,
              edges: session.draft.edges,
              textureMode: 'modelImage',
              expectedRevision: current.revision,
            });
            if (!abort.signal.aborted) closeRef.current();
          } catch (error) {
            if (!abort.signal.aborted) {
              session.setError(
                (error as Error).message.replace(
                  /^Error invoking remote method '[^']+': Error: /,
                  '',
                ),
              );
              session.setBusy(false);
            }
          }
        })();
      },
      () => {
        if (!session.snapshot.busy) closeRef.current();
      },
    );
    sessionRef.current = session;
    setManualMeshSession(session);
    void (async () => {
      try {
        if (locked(new Map(initial.document!.objects.map((o) => [o.guid, o])), guid))
          throw new Error(t('lockedSelection'));
        const responses = await Promise.all(
          [initial.preview!.sceneUrl, initial.preview!.meshGenerationUrl!].map((url) =>
            fetch(url, { signal: abort.signal }),
          ),
        );
        if (responses.some((r) => !r.ok)) throw new Error(t('meshEditFailed'));
        const [scene, workspace]: [SourceScene & { revision: number }, MeshGenerationWorkspace] =
          await Promise.all([responses[0].json(), responses[1].json()]);
        if (abort.signal.aborted) return;
        if (scene.revision !== initial.preview!.revision || workspace.revision !== scene.revision)
          throw new Error(t('meshEditChanged'));
        if (!workspace.inputs.some((input) => input.guid === guid))
          throw new Error(workspace.errors[guid] || t('meshEditFailed'));
        session.load(modelImageScene(scene, workspace.inputs));
      } catch (error) {
        if (!abort.signal.aborted) session.setError((error as Error).message);
      }
    })();
    return () => {
      abort.abort();
      sessionRef.current = null;
      setManualMeshSession(null);
      setMeshPreview(null);
    };
  }, []);
  useEffect(() => {
    if (
      !sessionRef.current?.snapshot.busy &&
      (state.preview?.id !== initial.preview?.id ||
        state.documentRevision !== initial.documentRevision ||
        !state.selectedGuids.includes(guid))
    )
      closeRef.current();
  }, [state.documentRevision, state.preview?.id, state.selectedGuids]);
  return null;
}
