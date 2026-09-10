import { useEffect, useState, type DragEvent } from 'react';
import { useEditor } from '../store';
import { deformerDescendants, isDeformer, topDeformerSelection } from '../../../shared/tree';
import { partDescendants, topPartSelection } from '../../../shared/parts';

type Destination = {
  parent: string | null;
  before?: string;
  row: string;
  position: 'before' | 'after' | 'inside';
};

export function useTreeMovement(
  deformers: boolean,
  dragLocked: boolean,
  locked: ReadonlySet<string>,
  expand: (guid: string) => void,
) {
  const { state, perform } = useEditor(),
    doc = state.document,
    all = doc?.objects || [];
  const byGuid = new Map(all.map((o) => [o.guid, o]));
  const [moving, setMoving] = useState<string[]>([]),
    [dragging, setDragging] = useState<string[]>([]),
    [destination, setDestination] = useState<Destination | null>(null);
  const dragType = deformers ? 'application/x-lattice-deformer' : 'application/x-lattice-part';
  useEffect(() => {
    setMoving([]);
    setDragging([]);
    setDestination(null);
  }, [doc?.path]);
  useEffect(() => {
    setMoving((ids) => ids.filter((id) => byGuid.has(id)));
  }, [doc?.objects]);
  const canMove = (ids: string[], target: string | null) => {
    if (
      !state.previewReady ||
      !ids.length ||
      ids.some(
        (id) =>
          !byGuid.has(id) ||
          id === doc?.rootPartGuid ||
          locked.has(id) ||
          (deformers && ['part', 'glue'].includes(byGuid.get(id)!.kind)),
      )
    )
      return false;
    if (!target) return true;
    const object = byGuid.get(target);
    return (
      !!object &&
      (deformers ? isDeformer(object) : object.kind === 'part') &&
      !locked.has(target) &&
      !(
        deformers
          ? deformerDescendants(all, topDeformerSelection(all, ids))
          : partDescendants(all, topPartSelection(all, ids))
      ).includes(target)
    );
  };
  const move = (guids: string[], target: string | null, beforeGuid?: string) => {
    if (!canMove(guids, target)) return;
    const revision = state.revision;
    perform(async () => {
      await window.lattice.command(
        deformers
          ? { type: 'moveDeformerObjects', guids, deformerGuid: target, expectedRevision: revision }
          : {
              type: 'movePartObjects',
              guids,
              parentGuid: target,
              beforeGuid,
              expectedRevision: revision,
            },
      );
      if (target) expand(target);
      setMoving([]);
    });
  };
  const destinationAt = (event: DragEvent, id: string): Destination | null => {
    const object = byGuid.get(id)!;
    if (deformers) return isDeformer(object) ? { parent: id, row: id, position: 'inside' } : null;
    const box = event.currentTarget.getBoundingClientRect(),
      fraction = (event.clientY - box.top) / box.height;
    if (object.kind === 'part' && fraction >= 0.25 && fraction <= 0.75)
      return { parent: id, row: id, position: 'inside' };
    const before = fraction < 0.5;
    const siblings = all.filter((o) => o.parentGuid === object.parentGuid);
    return {
      parent: object.parentGuid === doc?.rootPartGuid ? null : object.parentGuid,
      before: before ? id : siblings[siblings.indexOf(object) + 1]?.guid,
      row: id,
      position: before ? 'before' : 'after',
    };
  };
  const rowProps = (guid: string, guids: string[], select: () => void, disabled: boolean) => ({
    draggable: !dragLocked && !disabled && canMove(guids, null),
    onDragStart: (event: DragEvent) => {
      select();
      event.dataTransfer.setData(dragType, JSON.stringify({ path: doc!.path, guids }));
      event.dataTransfer.effectAllowed = 'move';
      setDragging(guids);
    },
    onDragEnd: () => {
      setDragging([]);
      setDestination(null);
    },
    onDragOver: (event: DragEvent) => {
      event.stopPropagation();
      const target = destinationAt(event, guid);
      if (dragLocked || !target || !canMove(dragging, target.parent)) {
        setDestination(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDestination(target);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setDestination(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const target = destinationAt(event, guid);
      setDestination(null);
      setDragging([]);
      if (dragLocked || !target) return;
      try {
        const data = JSON.parse(event.dataTransfer.getData(dragType));
        if (
          data.path === doc?.path &&
          Array.isArray(data.guids) &&
          data.guids.every((id: unknown) => typeof id === 'string')
        )
          move(data.guids, target.parent, target.before);
      } catch {
        /* Ignore transfers from outside this tree. */
      }
    },
  });
  const className = (id: string) =>
    `${moving.includes(id) ? ' pending-move' : ''}${destination?.row === id ? ` drop-${destination.position === 'inside' ? 'target' : destination.position}` : ''}`;
  return { moving, setMoving, canMove, move, rowProps, className };
}
