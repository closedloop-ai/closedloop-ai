"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { GridTableV2Group } from "@repo/design-system/components/ui/grid-table-v2";
import { toast } from "@repo/design-system/components/ui/sonner";
import type {
  TableGroupingState,
  TableSortRule,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { SessionsGroupDropController } from "./sessions-list-interactions";
import { toggleSetMember } from "./sessions-list-surface-model";
import { toSessionsListSortField } from "./sessions-list-surface-rows";
import type {
  SessionsListSortRule,
  SessionsListViewPatch,
} from "./sessions-list-view-state";
import {
  resolveHiddenSummaryCardIds,
  type SessionsSummaryCardId,
  sessionsSummaryCardOptions,
} from "./sessions-summary-card-visibility";

export function summaryCardMetricOptions(
  hiddenCardIds: ReadonlySet<string> | undefined,
  onToggleSummaryCard: ((cardId: string) => void) | undefined,
  labels?: Readonly<Record<SessionsSummaryCardId, string>>
) {
  if (!onToggleSummaryCard || hiddenCardIds === undefined) {
    return;
  }
  return sessionsSummaryCardOptions(labels);
}

export function resolveSummaryCardToggle(
  updateView: (patch: SessionsListViewPatch) => void,
  hostHiddenCardIds: ReadonlySet<string> | undefined,
  onToggleSummaryCard: ((cardId: string) => void) | undefined
) {
  return (cardId: string) => {
    updateView((current) => ({
      hiddenSummaryCardIds: toggleSetMember(
        resolveHiddenSummaryCardIds(
          current.hiddenSummaryCardIds,
          hostHiddenCardIds
        ),
        cardId
      ),
    }));
    onToggleSummaryCard?.(cardId);
  };
}

export function resolveGroupDropHandler(
  controller: SessionsGroupDropController | undefined,
  grouping: TableGroupingState
):
  | ((
      row: SessionTableRow,
      group: GridTableV2Group<SessionTableRow>,
      subgroup?: GridTableV2Group<SessionTableRow>
    ) => void)
  | undefined {
  const primaryFieldId = grouping.primary.fieldId;
  const secondaryFieldId = grouping.secondary.fieldId;
  const movable = (fieldId: string | null) =>
    Boolean(fieldId && controller?.canMove(fieldId));
  // EITHER configured level, not the primary alone (davetho review). Gating
  // the handler's existence on the primary while `applyGroupDropWiring` derives
  // each level's `droppable` from ITS OWN field made the two disagree: a host
  // with `canMove("status")` true and `canMove("owner")` false rendered every
  // Status subgroup as an enabled target and then supplied `GridTableV2` no
  // `onGroupDrop` at all, so the drop had nowhere to land. The per-destination
  // check below is what still refuses the level the host did not admit.
  if (!(controller && (movable(primaryFieldId) || movable(secondaryFieldId)))) {
    return;
  }
  return (row, group, subgroup) => {
    // ONE band supplies both the field and the value. Reading them from
    // different bands is the shape this ticket exists to prevent: `fieldId`
    // already comes from the subgroup level, so a `subgroup?.value ?? group.value`
    // would pair the SECONDARY field with the PRIMARY field's value. `key` gets
    // away with that only because it is required and never falls through.
    const destination = subgroup ?? group;
    const fieldId = subgroup ? grouping.secondary.fieldId : primaryFieldId;
    if (!(fieldId && controller.canMove(fieldId))) {
      return;
    }
    // The renderer already refuses such a band, but this is the layer about to
    // call a mutation and it should not take the renderer's word for it.
    if (destination.value === undefined) {
      return;
    }
    Promise.resolve(
      controller.onMove(row, fieldId, destination.key, destination.value)
    ).catch(() => toast.error("Couldn't move session"));
  };
}

export function toSessionsSortRules(
  sorts: readonly TableSortRule[]
): SessionsListSortRule[] {
  const resolved: SessionsListSortRule[] = [];
  for (const sort of sorts) {
    const fieldId = toSessionsListSortField(sort.fieldId);
    if (fieldId) {
      resolved.push({ direction: sort.direction, fieldId });
    }
  }
  return resolved;
}

/**
 * ISS-9225 — the two answers the shared footer cannot derive for Sessions:
 * whether the range is merely unsettled, and whether a rows-per-page control is
 * offered at all.
 *
 * Server-driven with no host handler, a size change cannot reach the read, so
 * the footer is handed NO handler and offers no control — the shipped
 * behaviour, stated as the absent capability it is rather than as an absent
 * page size.
 */
export function resolveSessionsFooterPagination({
  changePageSize,
  isAwaitingClampedPage,
  isPending,
  isServerDriven,
  onPageSizeChange,
}: {
  changePageSize: (pageSize: number) => void;
  isAwaitingClampedPage: boolean;
  isPending: boolean;
  isServerDriven: boolean;
  onPageSizeChange: ((pageSize: number) => void) | undefined;
}): {
  isRangeUnsettled: boolean;
  onPageSizeChange?: (pageSize: number) => void;
} {
  const isRangeUnsettled = isPending || isAwaitingClampedPage;
  if (isServerDriven && !onPageSizeChange) {
    return { isRangeUnsettled };
  }
  return { isRangeUnsettled, onPageSizeChange: changePageSize };
}
