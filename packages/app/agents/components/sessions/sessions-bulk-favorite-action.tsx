"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { toast } from "@repo/design-system/components/ui/sonner";
import type {
  TableBulkActionDescriptor,
  TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { StarIcon } from "lucide-react";
import type {
  SessionsBulkFavoriteOutcome,
  SessionsFavoriteController,
} from "./sessions-list-interactions";

/**
 * Favouriting as ONE bulk-action descriptor rather than a case the rail
 * hardcodes (ISS-8942). The Sessions surface forwards its favourites controller
 * and gets back either this descriptor or nothing at all.
 *
 * Nothing, when the host has no batch seam or cannot read the favourite list:
 * an action a client cannot perform is ABSENT, never a dead control (PRD-695
 * principle 6).
 */
export function sessionsFavoriteBulkActions({
  favorites,
  rows,
}: {
  favorites?: SessionsFavoriteController;
  rows: readonly SessionTableRow[];
}): readonly TableBulkActionDescriptor[] {
  if (!favorites?.onBulkChange || favorites.isUnavailable) {
    return [];
  }
  const controller = favorites;
  const allFavorited = rows.every((row) => controller.favoriteIds.has(row.id));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return [
    {
      icon: <StarIcon fill={allFavorited ? "currentColor" : "none"} />,
      id: SESSIONS_FAVORITE_BULK_ACTION_ID,
      kind: "command",
      // ISS-10161: this action already hands back an Undo on its applied
      // toast; the field declares what it was already doing.
      undo: TableBulkActionUndo.Supported,
      label: allFavorited
        ? "Remove sessions from favorites"
        : "Favorite sessions",
      onSelect: async (rowIds, selection) => {
        const submittedSelectionGeneration = selection.getGeneration?.();
        await applySelectedRows({
          allFavorited,
          controller,
          rowIds,
          rowsById,
          selection,
          submittedSelectionGeneration,
        });
      },
      pressed: allFavorited,
    },
  ];
}

export const SESSIONS_FAVORITE_BULK_ACTION_ID = "favorite";

async function applySelectedRows({
  allFavorited,
  controller,
  rowIds,
  rowsById,
  selection,
  submittedSelectionGeneration,
}: {
  allFavorited: boolean;
  controller: SessionsFavoriteController;
  rowIds: readonly string[];
  rowsById: ReadonlyMap<string, SessionTableRow>;
  selection: TableBulkSelectionControls;
  submittedSelectionGeneration: number | undefined;
}) {
  const outcome = await applyBulkFavoriteChange({
    controller,
    favorited: !allFavorited,
    rows: rowIds
      .map((rowId) => rowsById.get(rowId))
      .filter((row): row is SessionTableRow => row !== undefined),
  });
  // `null` is "the host could not say what landed", so the selection is left
  // exactly as it was. Otherwise the selection becomes what did NOT change —
  // empty on a clean run, which is the clear this used to do unconditionally.
  //
  // A single remaining failure drops the selection below the bar's own two-row
  // floor and unmounts it, which is fine and deliberate: that is this table's
  // ordinary one-row selected state, and the toast promises no retry to
  // contradict it (Pascoe review). What must not happen is the selection
  // claiming rows the server already changed.
  if (!outcome) {
    return;
  }
  if (
    submittedSelectionGeneration !== undefined &&
    selection.getGeneration?.() !== submittedSelectionGeneration
  ) {
    return;
  }
  if (outcome.failedIds.length === 0) {
    selection.clear();
    return;
  }
  selection.retain(outcome.failedIds);
}

/**
 * Run a bulk favorite change and REPORT WHAT ACTUALLY HAPPENED (whitlockk review
 * cid 3880964961).
 *
 * Returns the outcome, or `null` when the controller rejected — the one case
 * where nothing is known to have landed. The old shape was a boolean, which
 * could not express "four of six", so a batch whose last mutation failed
 * reported a total failure over a server that had already taken the other
 * three.
 */
async function applyBulkFavoriteChange({
  controller,
  favorited,
  rows,
}: {
  controller: SessionsFavoriteController;
  favorited: boolean;
  rows: readonly SessionTableRow[];
}): Promise<SessionsBulkFavoriteOutcome | null> {
  // Snapshotted BEFORE the mutation, because undo has to restore the state the
  // reader had rather than the one the failed batch left behind.
  const wasFavorited = new Set(
    rows
      .filter((row) => controller.favoriteIds.has(row.id))
      .map((row) => row.id)
  );
  try {
    const outcome = await updateFavoriteRows(controller, rows, favorited);
    reportBulkFavoriteOutcome({
      controller,
      favorited,
      outcome,
      rows,
      wasFavorited,
    });
    return outcome;
  } catch {
    toast.error("Couldn't update favorite sessions");
    return null;
  }
}

function reportBulkFavoriteOutcome({
  controller,
  favorited,
  outcome,
  rows,
  wasFavorited,
}: {
  controller: SessionsFavoriteController;
  favorited: boolean;
  outcome: SessionsBulkFavoriteOutcome;
  rows: readonly SessionTableRow[];
  wasFavorited: ReadonlySet<string>;
}) {
  const succeededIds = new Set(outcome.succeededIds);
  const succeeded = rows.filter((row) => succeededIds.has(row.id));
  if (succeeded.length === 0) {
    toast.error("Couldn't update favorite sessions");
    return;
  }
  const verb = favorited ? "Added to" : "Removed from";
  // Scoped to the rows that CHANGED, so undoing a partial run cannot write over
  // the rows the server never took.
  const action = {
    label: "Undo",
    onClick: () => {
      restoreFavoriteRows(
        controller,
        succeeded.filter((row) => wasFavorited.has(row.id)),
        succeeded.filter((row) => !wasFavorited.has(row.id))
      ).catch(() => toast.error("Couldn't undo favorite changes"));
    },
  };
  if (outcome.failedIds.length === 0) {
    toast.success(`${verb} favorites for ${succeeded.length} sessions`, {
      action,
    });
    return;
  }
  // Says what happened, and nothing else (Pascoe review). "N still selected"
  // narrates the bulk bar sitting directly above this toast, and a "try again"
  // would compete with the Undo button in the same toast for the one control it
  // has — two opposite jobs, one button. Same shape as `move-entity-dialog`'s
  // "Moved 4 of 6 items. 2 failed."
  toast.warning(
    `${verb} favorites for ${succeeded.length} of ${rows.length} sessions. ${outcome.failedIds.length} failed.`,
    { action }
  );
}

async function restoreFavoriteRows(
  controller: SessionsFavoriteController,
  previouslyFavorited: readonly SessionTableRow[],
  previouslyUnfavorited: readonly SessionTableRow[]
) {
  await updateFavoriteRows(controller, previouslyFavorited, true);
  await updateFavoriteRows(controller, previouslyUnfavorited, false);
}

async function updateFavoriteRows(
  controller: SessionsFavoriteController,
  rows: readonly SessionTableRow[],
  favorited: boolean
): Promise<SessionsBulkFavoriteOutcome> {
  if (rows.length === 0 || !controller.onBulkChange) {
    return EMPTY_BULK_FAVORITE_OUTCOME;
  }
  const outcome = await controller.onBulkChange(rows, favorited);
  // A host that reports nothing keeps the all-or-nothing contract: it resolved,
  // so every row landed. Only a host that CAN tell the difference says so.
  return outcome ?? { failedIds: [], succeededIds: rows.map((row) => row.id) };
}

const EMPTY_BULK_FAVORITE_OUTCOME: SessionsBulkFavoriteOutcome = {
  failedIds: [],
  succeededIds: [],
};
