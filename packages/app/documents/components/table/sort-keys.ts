/**
 * Sort keys and rank-interaction state for the project artifact table
 * (PRD-421 / PLN-755).
 *
 * `StackRank` is a sentinel sort key: the server-side `getProjectTree` query
 * already orders root artifacts by `(sortOrder ASC NULLS LAST, createdAt DESC)`
 * after PLN-755 Phase A landed, so when the active sort is `StackRank` the
 * client preserves the server-supplied order rather than running a client-side
 * comparator. The other keys are existing column sorts.
 */

import { GroupByMode } from "@repo/app/documents/lib/group-by";

export const SortKey = {
  StackRank: "stackRank",
  Title: "title",
  Type: "type",
  DueDate: "dueDate",
  Assignee: "assignee",
  Priority: "priority",
  Score: "score",
  Status: "status",
  Slug: "slug",
} as const;
export type SortKey = (typeof SortKey)[keyof typeof SortKey];

/** Canonical column list backing `useSortParams.validColumns`. */
export const SORT_KEYS: readonly SortKey[] = Object.values(SortKey);

/**
 * Whether the row-level rank-interaction UI (drag handle, Move-to-top /
 * Move-to-bottom row menu items) should be shown and, if so, in what state.
 *
 * Derived purely from `(sortBy, groupBy)` so the same rule applies to every
 * surface that needs to reflect rank availability. The PRD's matrix:
 *
 *  - `enabled`         — `sortBy === StackRank` AND `groupBy === None`. The
 *                        canonical state where stack-rank is meaningful and
 *                        changeable.
 *  - `disabledGrouped` — `groupBy !== None`. Items render in stack-rank order
 *                        within each group, but a rank change is ambiguous
 *                        because the group buckets are not themselves ranked.
 *                        Surfaces render the affordance disabled with a
 *                        tooltip ("Disable grouping to reorder").
 *  - `hidden`          — column sort is active (any `sortBy` other than
 *                        StackRank). The list is showing a derived order, so
 *                        the rank handle would be misleading.
 */
export const RankInteractionMode = {
  Enabled: "enabled",
  Hidden: "hidden",
  DisabledGrouped: "disabledGrouped",
} as const;
export type RankInteractionMode =
  (typeof RankInteractionMode)[keyof typeof RankInteractionMode];

export function getRankInteractionMode(
  sortBy: SortKey | null,
  groupBy: GroupByMode
): RankInteractionMode {
  if (groupBy !== GroupByMode.None) {
    return RankInteractionMode.DisabledGrouped;
  }
  if (sortBy !== null && sortBy !== SortKey.StackRank) {
    return RankInteractionMode.Hidden;
  }
  return RankInteractionMode.Enabled;
}

/**
 * Whether a leading rank slot (the 28px grip column) should be reserved for the
 * given mode. Single source of truth shared by both the table header and the
 * body rows so their grids stay aligned. `Hidden` reserves nothing; only
 * `Enabled` and `DisabledGrouped` render a slot.
 */
export function shouldShowRankSlot(
  mode: RankInteractionMode | undefined
): boolean {
  return (
    mode === RankInteractionMode.Enabled ||
    mode === RankInteractionMode.DisabledGrouped
  );
}
