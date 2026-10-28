"use client";

import { resolveStatusLabel } from "@repo/api/src/types/artifact-status-display";
import { DocumentType } from "@repo/api/src/types/document";
import { useArtifactStatusDisplay } from "@repo/app/shared/hooks/use-artifact-status-display";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "@repo/app/shared/lib/artifact-status-labels";

/**
 * What a My Tasks kanban card's status chip reads (ISS-9560).
 *
 * The board passed `artifact.status` straight into a visible `Chip`, so a card
 * read `CHANGES_REQUESTED` where every other surface in the product says
 * "Changes Requested". A status the card's own vocabulary does not cover takes
 * the shared unknown word instead of keeping a private `?? status` here.
 *
 * THE VOCABULARY IS THE CARD'S TYPE, not the board's union, and that is the
 * whole reason this takes `artifactType`. The card already picks its status
 * ICON per type (`IssueStatusIcon` for a Feature, `DocumentStatusIcon`
 * otherwise), and `DISPLAY_GROUPS` deliberately mixes both vocabularies into
 * one column — so resolving the chip through the COMBINED map put a resolved
 * word beside an icon announcing "Unknown, <sentence>" for the same status on
 * the same card (review of this chunk). `packages/app/AGENTS.md` -> Cross-
 * surface parity: resolve a display label ONCE.
 *
 * A hook, and its own module, because the gate has to be read ONCE per module:
 * both `MyTasksCard` and the `DragOverlay`'s `KanbanCardPreview` need the same
 * answer, and `no-threaded-feature-flag` rejects reading it twice in
 * `my-tasks-kanban.tsx` as surely as it rejects passing the boolean down.
 *
 * STATUS ONLY. The priority chip beside it still renders its raw value; that is
 * ISS-9094's to fix (PR #6804), which performs this same move for priority in
 * this same file.
 */
export function useKanbanStatusLabel(
  status: string,
  artifactType: DocumentType
): string {
  const unknownStatus = useArtifactStatusDisplay();
  if (!unknownStatus) {
    return status;
  }
  const labels =
    artifactType === DocumentType.Feature
      ? ISSUE_STATUS_LABELS
      : DOCUMENT_STATUS_LABELS;
  return resolveStatusLabel(labels, status, unknownStatus);
}
