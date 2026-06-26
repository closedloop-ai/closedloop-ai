/**
 * Pure helpers backing the stack-rank drag-and-drop wiring on the project
 * page (PRD-421 / PLN-755 Phase E).
 *
 * Kept in their own module — separate from `documents-view.tsx` — so the
 * algorithm can be unit-tested without spinning up a TanStack/DnDKit
 * provider tree, and so the same logic stays reachable from any future
 * page (e.g. My Tasks) that wants to grow a rank surface.
 */

import type { DragEndEvent } from "@dnd-kit/core";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";

type IdHolder = { data: { id: string } };

export type ResolvedDragMove = {
  artifactId: string;
  position: typeof MovePosition.Before | typeof MovePosition.After;
  referenceArtifactId: string;
};

/**
 * Translate a `@dnd-kit` drag end into the wire shape `POST
 * /projects/:id/artifacts/move` expects. Returns `null` when the drop is a
 * no-op (same row, dropped outside any row, or either id missing from the
 * visible list) so callers skip the mutation entirely.
 *
 * The `before`/`after` decision mirrors how Linear and the existing
 * custom-field enum reorder behave: dragging up anchors `before` the
 * reference, dragging down anchors `after`.
 */
export function resolveDragMove(
  event: DragEndEvent,
  items: readonly IdHolder[]
): ResolvedDragMove | null {
  const { active, over } = event;
  if (!over || active.id === over.id) {
    return null;
  }
  const activeId = String(active.id);
  const overId = String(over.id);
  const ids = items.map((item) => item.data.id);
  const activeIndex = ids.indexOf(activeId);
  const overIndex = ids.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0) {
    return null;
  }
  return {
    artifactId: activeId,
    position:
      activeIndex < overIndex ? MovePosition.After : MovePosition.Before,
    referenceArtifactId: overId,
  };
}
