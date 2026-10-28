"use client";

import type { TableSavedView } from "@repo/design-system/components/ui/table-toolbar-model";
import { useFeatureFlagEnabledOptional } from "../../../shared/feature-flags/use-feature-flag-enabled";
import { SESSIONS_SAVED_VIEW_HIDDEN_CARDS_AXIS_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import type { SessionsListViewState } from "./sessions-list-view-state";
import { resolveSessionsSearchTerm } from "./sessions-list-view-state";

export type SessionsSavedView = TableSavedView & {
  value: SessionsListViewState;
};

export type SessionsSavedViewsController = {
  activeViewId: string | null;
  views: readonly SessionsSavedView[];
  onApply?: (viewId: string) => void;
  onSave: (name: string, value: SessionsListViewState) => Promise<void> | void;
};

export function sessionsSavedViewOptions(
  controller: SessionsSavedViewsController
): TableSavedView[] {
  return controller.views.map(({ id, name, scope }) => ({ id, name, scope }));
}

/**
 * ISS-8722: the corrected shape — an ABSENT `hiddenSummaryCardIds` restores
 * ABSENT.
 *
 * Absent is a third answer, not a spelling of empty: `resolveHiddenSummaryCardIds`
 * lets an absent axis defer to the HOST's own hidden set, while an empty one
 * overrides it with "nothing hidden". Materializing absent into empty therefore
 * un-hides cards the host hides whenever a view written before this axis existed
 * is applied. The key is still WRITTEN into the patch — as `undefined` — because
 * a saved view is applied as a patch and an omitted key would instead leave the
 * reader's live selection standing, which is none of the three answers
 * (whitlockk, #6380).
 */
export function sessionsSavedViewValue(
  controller: SessionsSavedViewsController,
  viewId: string
): SessionsListViewState | undefined {
  const value = savedViewState(controller, viewId);
  if (!value) {
    return;
  }
  const stored = value.hiddenSummaryCardIds;
  return savedViewPatch(
    value,
    stored === undefined ? undefined : new Set(stored)
  );
}

/**
 * The pre-ISS-8722 shape, kept whole so the rollout gate picks between two
 * complete shapes at its one read site rather than steering a derivation with a
 * threaded boolean (root `AGENTS.md`, "One read site per feature flag"). Delete
 * this and its selection when the flag graduates.
 */
export function legacySessionsSavedViewValue(
  controller: SessionsSavedViewsController,
  viewId: string
): SessionsListViewState | undefined {
  const value = savedViewState(controller, viewId);
  if (!value) {
    return;
  }
  return savedViewPatch(value, new Set(value.hiddenSummaryCardIds));
}

export function useSessionsSavedViewApplyHandler(
  controller: SessionsSavedViewsController | undefined,
  onApplyValue: (value: SessionsListViewState) => void
): (viewId: string) => void {
  const hiddenCardsAxisEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_SAVED_VIEW_HIDDEN_CARDS_AXIS_FEATURE_FLAG_KEY
  );
  const savedViewValue = hiddenCardsAxisEnabled
    ? sessionsSavedViewValue
    : legacySessionsSavedViewValue;
  return (viewId) => {
    if (!controller) {
      return;
    }
    const value = savedViewValue(controller, viewId);
    if (!value) {
      return;
    }
    onApplyValue(value);
    controller.onApply?.(viewId);
  };
}

function savedViewState(
  controller: SessionsSavedViewsController,
  viewId: string
): SessionsListViewState | undefined {
  return controller.views.find((view) => view.id === viewId)?.value;
}

function savedViewPatch(
  value: SessionsListViewState,
  hiddenSummaryCardIds: ReadonlySet<string> | undefined
): SessionsListViewState {
  return {
    ...value,
    // ISS-8216: MATERIALIZED, never passed through. This value is applied as a
    // PATCH, so an absent key — a view stored before the axis existed — would
    // leave the reader's live custom-field filter in force and the list still
    // narrowed by something the applied view does not represent (whitlockk, #6074).
    // `hiddenSummaryCardIds` reads its absent case differently — see
    // {@link sessionsSavedViewValue} — so the two axes cannot share one rule.
    customFieldFilters: new Map(value.customFieldFilters),
    hiddenSummaryCardIds,
    page: 0,
    // ISS-8966: MATERIALIZED for the identical reason, and it is the identical
    // axis shape — optional, with absent and `""` meaning the same nothing.
    // Passed through, a view stored without the key would leave the reader's
    // live TERM in force: the list stays narrowed by a search the applied view
    // does not represent, and the chip row goes on naming it.
    search: resolveSessionsSearchTerm(value.search),
    visibleColumnIds: new Set(value.visibleColumnIds),
  };
}
