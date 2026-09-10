import { useEffect, useRef } from 'react';
import { useEditor } from '../store';
import { FrameCommand } from '../frame-command';

// Preview every update, but commit one history entry when the interaction ends.
export function useParameterGesture(ids: string[]) {
  const { command, state, perform } = useEditor();
  const currentCommand = useRef(command),
    currentPerform = useRef(perform),
    values = useRef<Record<string, number>>({}),
    editId = useRef<string | null>(null);
  currentCommand.current = command;
  currentPerform.current = perform;
  const queued = useRef<FrameCommand<{ editId: string; values: Record<string, number> }> | null>(
    null,
  );
  if (!queued.current)
    queued.current = new FrameCommand(
      (value) => window.lattice.command({ type: 'setParameters', ...value }),
      (error) => currentPerform.current(() => Promise.reject(error)),
    );
  const finish = (cancel = false) => {
    const id = editId.current;
    editId.current = null;
    if (cancel) queued.current!.cancel();
    else queued.current!.flush();
    values.current = {};
    if (id) currentCommand.current({ type: 'endParameterEdit', editId: id, cancel });
    return !!id;
  };
  useEffect(() => {
    const cancel = () => finish(true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, [ids.join('\0'), state.document?.rootPartGuid]);
  return {
    begin: () => {
      if (editId.current) return;
      editId.current = crypto.randomUUID();
      values.current = {};
      command({ type: 'beginParameterEdit', editId: editId.current, ids });
    },
    update: (next: Record<string, number>) => {
      if (!editId.current) return;
      values.current = { ...values.current, ...next };
      queued.current!.queue({ editId: editId.current, values: values.current });
    },
    value: (id: string, fallback: number) => values.current[id] ?? fallback,
    finish,
  };
}
