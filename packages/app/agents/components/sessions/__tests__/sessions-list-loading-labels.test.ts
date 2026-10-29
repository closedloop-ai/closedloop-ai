import { describe, expect, it } from "vitest";
import {
  getSessionsTableLoadingLabel,
  isSessionsReadInitiallyLoading,
  SESSIONS_LIST_LOADING_LABEL,
  SESSIONS_LIST_SEARCHING_LABEL,
} from "../sessions-list-loading-labels";

/**
 * ISS-6382 (tamsinb review): the two states this flag must tell apart, because
 * conflating them is a defect this PR shipped once and a sibling suite caught.
 *
 * `desktop-sessions-live-update.test.tsx` covers the same ground through the
 * real tree, but it lives in `src/renderer/__tests__/` — outside the sessions
 * selection anyone iterating on this view actually runs. This is the fast
 * detector in the directory that owns the code.
 */
describe("isSessionsReadInitiallyLoading (ISS-6382)", () => {
  it("reports loading while the restore gate holds, whatever the query says", () => {
    // The gate cannot be inferred from query state: a held-closed read on a warm
    // cache reports a settled success.
    expect(
      isSessionsReadInitiallyLoading({
        isViewReady: false,
        isListLoading: false,
      })
    ).toBe(true);
  });

  it("reports loading for a first fetch in flight on a ready view", () => {
    expect(
      isSessionsReadInitiallyLoading({ isViewReady: true, isListLoading: true })
    ).toBe(true);
  });

  it("does NOT report loading for a read disabled by an unavailable source", () => {
    // The regression this exists for. TanStack reports `isPending` for any query
    // holding no data, including one disabled indefinitely because
    // `canReadSessions` is false — so passing `isPending` in here pinned the
    // table spinner over the "Getting your sessions ready" holding surface that
    // state owns, permanently. `isLoading` is `isPending && isFetching`, which
    // is false there.
    expect(
      isSessionsReadInitiallyLoading({
        isViewReady: true,
        isListLoading: false,
      })
    ).toBe(false);
  });
});

/**
 * ISS-9106 — the helper that decides WHICH of the three states the table body is
 * in. It had no direct coverage on either side of the move, and this change gave
 * it a new `isSourceStarting` boundary in place of the desktop-only display
 * state, so the branches are pinned here rather than inferred from an
 * integration suite that only ever matched one literal.
 */
describe("getSessionsTableLoadingLabel (ISS-9106)", () => {
  const SETTLED = {
    hasData: false,
    isInitialLoading: false,
    isRefreshingWithPreviousData: false,
    isSourceStarting: false,
    search: undefined,
  };

  it("has no label for a settled read", () => {
    expect(getSessionsTableLoadingLabel(SETTLED)).toBeUndefined();
  });

  it("labels a first fetch that has nothing to fall back on", () => {
    expect(
      getSessionsTableLoadingLabel({ ...SETTLED, isInitialLoading: true })
    ).toBe(SESSIONS_LIST_LOADING_LABEL);
  });

  // The `isSourceStarting` half, in isolation from `isInitialLoading` — a local
  // source still coming up reports no fetch in flight, so only this term can
  // speak for it.
  it("labels a source that is still coming up, with no fetch running", () => {
    expect(
      getSessionsTableLoadingLabel({ ...SETTLED, isSourceStarting: true })
    ).toBe(SESSIONS_LIST_LOADING_LABEL);
  });

  it("says SEARCHING when a term is narrowing that read", () => {
    expect(
      getSessionsTableLoadingLabel({
        ...SETTLED,
        isInitialLoading: true,
        search: "fix/parity",
      })
    ).toBe(SESSIONS_LIST_SEARCHING_LABEL);
  });

  // Held rows short-circuit the blocking branch, which is why the refetch branch
  // below has to be checked WITH data rather than without.
  it("stays silent once there are rows, however the read got there", () => {
    expect(
      getSessionsTableLoadingLabel({
        ...SETTLED,
        hasData: true,
        isInitialLoading: true,
        isSourceStarting: true,
      })
    ).toBeUndefined();
  });

  it("labels a keep-previous refetch even though the rows are still up", () => {
    expect(
      getSessionsTableLoadingLabel({
        ...SETTLED,
        hasData: true,
        isRefreshingWithPreviousData: true,
      })
    ).toBe(SESSIONS_LIST_LOADING_LABEL);
  });
});
