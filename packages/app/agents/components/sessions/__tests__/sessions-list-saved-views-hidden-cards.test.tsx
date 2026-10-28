import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import {
  EMPTY_TABLE_GROUPING,
  TableSavedViewScope,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  legacySessionsSavedViewValue,
  type SessionsSavedView,
  type SessionsSavedViewsController,
  sessionsSavedViewValue,
  useSessionsSavedViewApplyHandler,
} from "../sessions-list-saved-views";
import type { SessionsListViewState } from "../sessions-list-view-state";
import { resolveHiddenSummaryCardIds } from "../sessions-summary-card-visibility";

/**
 * ISS-8722 — a saved view written WITHOUT `hiddenSummaryCardIds` must restore
 * with that axis ABSENT.
 *
 * Every case reads through `resolveHiddenSummaryCardIds`, the consumer that
 * gives the three answers their different meanings: absent defers to the HOST's
 * hidden set, empty overrides it with "nothing hidden", applied overrides it
 * with the stored set. Inspecting the restored field instead would pass just as
 * happily on a value nothing downstream distinguishes.
 *
 * The flag key and every card id below are independent literals, not imports of
 * the modules under test, so an expectation cannot be satisfied by the same
 * mistake it is policing.
 */

const HIDDEN_CARDS_AXIS_FLAG_KEY = "sessions-saved-view-hidden-cards-axis";

/** What the HOST hides. An absent axis is the only answer that leaves it standing. */
const HOST_HIDDEN_CARD_IDS: ReadonlySet<string> = new Set(["prs-shipped"]);

const APPLIED_HIDDEN_CARD_IDS: ReadonlySet<string> = new Set([
  "cost",
  "tokens",
]);

const ABSENT_VIEW_ID = "absent";
const EMPTY_VIEW_ID = "empty";
const APPLIED_VIEW_ID = "applied";

function baseViewState(): SessionsListViewState {
  return {
    dateRange: DEFAULT_DATE_RANGE,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    grouping: EMPTY_TABLE_GROUPING,
    page: 3,
    scopeUserId: null,
    sortBy: null,
    sortDir: "asc",
    visibleColumnIds: new Set(["status"]),
  };
}

function savedView(
  id: string,
  hiddenSummaryCardIds: ReadonlySet<string> | undefined
): SessionsSavedView {
  const value: SessionsListViewState = { ...baseViewState() };
  if (hiddenSummaryCardIds !== undefined) {
    value.hiddenSummaryCardIds = hiddenSummaryCardIds;
  }
  return { id, name: id, scope: TableSavedViewScope.Personal, value };
}

function controller(): SessionsSavedViewsController {
  return {
    activeViewId: null,
    onSave: () => undefined,
    views: [
      savedView(ABSENT_VIEW_ID, undefined),
      savedView(EMPTY_VIEW_ID, new Set()),
      savedView(APPLIED_VIEW_ID, APPLIED_HIDDEN_CARD_IDS),
    ],
  };
}

/**
 * What the strip would paint for a restored view, given what the host hides.
 *
 * The two shapes are named directly rather than steered by a boolean: the gate
 * picks between them at its ONE read site inside the hook (root `AGENTS.md`,
 * "One read site per feature flag"), and the last case here is what proves that
 * selection is wired.
 */
function restoredHiddenCardIds(
  viewId: string,
  savedViewValue: typeof sessionsSavedViewValue
): ReadonlySet<string> {
  const restored = savedViewValue(controller(), viewId);
  return resolveHiddenSummaryCardIds(
    restored?.hiddenSummaryCardIds,
    HOST_HIDDEN_CARD_IDS
  );
}

function flagWrapper(enabledFlags: readonly string[]) {
  const adapter = createStaticFeatureFlagAdapter({ enabledFlags });
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider adapter={adapter}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}

describe("sessions saved views, hidden summary card axis", () => {
  it("restores an absent axis as absent, distinct from empty and applied", () => {
    expect(restoredHiddenCardIds(ABSENT_VIEW_ID, sessionsSavedViewValue)).toBe(
      HOST_HIDDEN_CARD_IDS
    );
    expect(
      restoredHiddenCardIds(EMPTY_VIEW_ID, sessionsSavedViewValue)
    ).toStrictEqual(new Set());
    expect(
      restoredHiddenCardIds(APPLIED_VIEW_ID, sessionsSavedViewValue)
    ).toStrictEqual(new Set(["cost", "tokens"]));
  });

  it("keeps the absent axis out of the applied patch as an explicit undefined", () => {
    const restored = sessionsSavedViewValue(controller(), ABSENT_VIEW_ID);

    // Written, not omitted: the value is applied as a patch, so an omitted key
    // would leave the reader's LIVE hidden set standing rather than restoring
    // the view's own absence.
    expect(Object.hasOwn(restored ?? {}, "hiddenSummaryCardIds")).toBe(true);
    expect(restored?.hiddenSummaryCardIds).toBeUndefined();
  });

  it("copies an applied axis rather than aliasing the stored view's set", () => {
    const source = controller();
    const restored = sessionsSavedViewValue(source, APPLIED_VIEW_ID);

    expect(restored?.hiddenSummaryCardIds).not.toBe(
      source.views[2]?.value.hiddenSummaryCardIds
    );
    expect(restored?.hiddenSummaryCardIds).toStrictEqual(
      new Set(["cost", "tokens"])
    );
  });

  it("collapses absent into empty in the legacy shape the closed gate selects", () => {
    expect(
      restoredHiddenCardIds(ABSENT_VIEW_ID, legacySessionsSavedViewValue)
    ).toStrictEqual(new Set());
    expect(
      restoredHiddenCardIds(ABSENT_VIEW_ID, legacySessionsSavedViewValue)
    ).not.toBe(HOST_HIDDEN_CARD_IDS);
    // The legacy shape differs ONLY on the absent axis — a "legacy" that also
    // dropped an applied selection would pass the assertion above.
    expect(
      restoredHiddenCardIds(APPLIED_VIEW_ID, legacySessionsSavedViewValue)
    ).toStrictEqual(new Set(["cost", "tokens"]));
  });

  it("reads the gate from the flag adapter, closed by default", () => {
    const openApplied: SessionsListViewState[] = [];
    const open = renderHook(
      () =>
        useSessionsSavedViewApplyHandler(controller(), (value) => {
          openApplied.push(value);
        }),
      { wrapper: flagWrapper([HIDDEN_CARDS_AXIS_FLAG_KEY]) }
    );
    open.result.current(ABSENT_VIEW_ID);

    const closedApplied: SessionsListViewState[] = [];
    const closed = renderHook(
      () =>
        useSessionsSavedViewApplyHandler(controller(), (value) => {
          closedApplied.push(value);
        }),
      { wrapper: flagWrapper([]) }
    );
    closed.result.current(ABSENT_VIEW_ID);

    // A handler that never applied anything would leave both arrays empty, and
    // `undefined` reads as the ABSENT axis — so the gate-open case below would
    // pass on a handler that does nothing at all.
    expect(openApplied).toHaveLength(1);
    expect(closedApplied).toHaveLength(1);
    expect(
      resolveHiddenSummaryCardIds(
        openApplied[0]?.hiddenSummaryCardIds,
        HOST_HIDDEN_CARD_IDS
      )
    ).toBe(HOST_HIDDEN_CARD_IDS);
    expect(
      resolveHiddenSummaryCardIds(
        closedApplied[0]?.hiddenSummaryCardIds,
        HOST_HIDDEN_CARD_IDS
      )
    ).toStrictEqual(new Set());
  });
});
