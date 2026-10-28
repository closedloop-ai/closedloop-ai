import type { BranchMetricId } from "@repo/api/src/types/branch-metrics";
import type { TableToggleOption } from "@repo/design-system/components/ui/table-toolbar-model";
import { CANONICAL_BRANCH_SUMMARY_CARD_IDS } from "./branches-summary-card-ids";

/**
 * ISS-12664: the Branches strip's per-card show/hide, on the contract Sessions
 * ships (`sessions-summary-card-visibility.ts`): the persisted set is the HIDDEN
 * ids, so a card added in a later build is visible for a reader whose stored view
 * predates it.
 *
 * Card identity is the metric id the strip already keys on, in the strip's own
 * order, so a card added to the strip cannot arrive without a way to hide it.
 */
export const BRANCHES_SUMMARY_CARD_IDS: readonly BranchMetricId[] =
  CANONICAL_BRANCH_SUMMARY_CARD_IDS;

/**
 * The Options-menu rows. Every row takes `labelFor`'s answer for its id, so the
 * LOC-per-$ row keeps the LOC label even when the strip titles that card by the
 * Pensero points arm — the stable-row choice Sessions documents for the same card.
 */
export function branchesSummaryCardOptions(
  labelFor: (id: BranchMetricId) => string
): TableToggleOption[] {
  return BRANCHES_SUMMARY_CARD_IDS.map((id) => ({
    key: id,
    label: labelFor(id),
  }));
}

export function isBranchesSummaryCardVisible(
  id: BranchMetricId,
  hiddenCardIds: ReadonlySet<string> | undefined
): boolean {
  return !hiddenCardIds?.has(id);
}

/** The menu speaks VISIBLE keys while the view persists HIDDEN ones. */
export function resolveBranchesSummaryCardVisibility(
  hiddenCardIds: ReadonlySet<string> | undefined
): { allHidden: boolean; visibleCardKeys: ReadonlySet<string> } {
  const visibleCardKeys = new Set<string>(
    BRANCHES_SUMMARY_CARD_IDS.filter((id) =>
      isBranchesSummaryCardVisible(id, hiddenCardIds)
    )
  );
  return { allHidden: visibleCardKeys.size === 0, visibleCardKeys };
}
