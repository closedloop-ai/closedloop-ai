"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  ChecklistItemId,
  type OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";

import { useOnboardingStatus } from "@repo/app/onboarding/hooks/use-onboarding";

/**
 * The attribute every checklist row carries, stamped with its item id.
 *
 * Declared here rather than inline in the checklist because it is a runtime
 * contract between two components: the checklist produces it, the invite
 * spotlight queries it to find its anchor. Split across two files as bare
 * strings, renaming it on one side compiles fine and the spotlight silently
 * stops firing.
 */
export const CHECKLIST_ITEM_ATTRIBUTE = "data-checklist-item";

/**
 * The element that holds the rows.
 *
 * Separate from the row attribute because the two answer different questions:
 * a row says WHERE to point, the list says WHEN the pointing goes stale. A row
 * is wrapped in a `Link` only while it has an href and is incomplete, so
 * walking up from the row lands on an anchor or on the list depending on state
 * — and an anchor's box does not change when a sibling row is inserted above
 * it, which is exactly the move that invalidates a measurement.
 */
export const CHECKLIST_LIST_ATTRIBUTE = "data-checklist-items";

/** Selector for the rows container. */
export const CHECKLIST_LIST_SELECTOR = `[${CHECKLIST_LIST_ATTRIBUTE}]`;

/** Selector for one checklist row, by the contract value the API returns. */
export function checklistItemSelector(itemId: ChecklistItemId): string {
  return `[${CHECKLIST_ITEM_ATTRIBUTE}="${itemId}"]`;
}

export type OnboardingChecklistView = {
  /** Whether the checklist card is on screen right now. */
  readonly visible: boolean;
  readonly items: readonly OnboardingChecklistItem[];
  readonly completedCount: number;
  readonly totalCount: number;
};

/**
 * One answer to "is the setup checklist showing, and what is in it".
 *
 * Three components need this and they need to agree: the checklist renders from
 * it, the invite spotlight anchors to a row inside it, and the agent-onboarding
 * card stands down while it is up. Recomputing those conditions in each of them
 * is how two setup cards end up disagreeing about the same fact on the same
 * screen — which is exactly what visual QA caught.
 */
export function useOnboardingChecklist(): OnboardingChecklistView {
  // Refetch when the tab regains focus — `"always"`, not `true`. Unlike every
  // sibling row, the desktop row completes through an action that happens
  // OUTSIDE the browser: the user follows an external download link, installs an
  // app, and that app registers a compute target from a different client. No
  // in-tab mutation ever invalidates this query, and `true` only refetches a
  // STALE query — which, against this query's five-minute `staleTime`, is
  // precisely not the window in which someone downloads, installs and comes
  // back. `"always"` re-checks on the return itself.
  const { data: status } = useOnboardingStatus({
    refetchOnWindowFocus: "always",
  });
  const gdriveFlag = useFeatureFlag("google-drive");
  const gdriveEnabled = Boolean((gdriveFlag as { enabled?: boolean })?.enabled);

  const hiddenItemIds = new Set<ChecklistItemId>();
  if (!gdriveEnabled) {
    hiddenItemIds.add(ChecklistItemId.ConnectGoogle);
  }

  const items = (status?.checklist ?? []).filter(
    (item) => !hiddenItemIds.has(item.id)
  );
  const completedCount = items.filter((item) => item.completed).length;
  const totalCount = items.length;

  const visible =
    status?.wizardCompleted === true &&
    !status.checklistDismissed &&
    totalCount > 0 &&
    completedCount !== totalCount;

  return {
    visible,
    items,
    completedCount,
    totalCount,
  };
}
