import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type DashboardStateInput,
  resolveDashboardState,
  useSessionsCountFresh,
} from "../dashboard-state";

/**
 * ISS-6002. The shipped defect: `empty` was derived from the session COUNT
 * alone, and the count falls back to `0` for a pending read, a failed read, and
 * a read taken before the local store opened. The dashboard therefore rendered
 * "No agent sessions yet" on a machine holding 1,014 sessions.
 *
 * Every case below is written so it FAILS against that derivation
 * (`loading = insights only`, `empty = !(loading || analyticsError || total > 0)`).
 */
const READY_WITH_DATA: DashboardStateInput = {
  analyticsLoaded: true,
  analyticsError: false,
  sessionsError: false,
  sessionSourceUnavailable: false,
  retrying: false,
  grew: false,
  settled: true,
  sessionsCountFresh: true,
  sessionsTotal: 1014,
};

function input(overrides: Partial<DashboardStateInput>): DashboardStateInput {
  return { ...READY_WITH_DATA, ...overrides };
}

describe("resolveDashboardState", () => {
  it("renders the dashboard when the analytics and the session read are both good", () => {
    const state = resolveDashboardState(READY_WITH_DATA);

    expect(state).toEqual({
      loading: false,
      showError: false,
      empty: false,
      hasData: true,
      sessionsFailed: false,
      sessionsCountKnown: true,
      analyzing: false,
    });
  });

  it("holds loading — never empty — until a zero comes from a fresh read", () => {
    // Every way the total was a `?? 0` fallback rather than a measured zero:
    // the read is still in flight, it succeeded before the local SQLite store
    // opened (measured: 0 until ~+10.6s, 1018 after), or it is that same stale
    // result sitting there on the render where readiness flips. `sessionsCountFresh`
    // is the one question that separates all three from a real empty install.
    const state = resolveDashboardState(
      input({ sessionsCountFresh: false, sessionsTotal: 0 })
    );

    expect(state.loading).toBe(true);
    expect(state.empty).toBe(false);
    expect(state.sessionsCountKnown).toBe(false);
  });

  it("reports the empty state only once the read settled AND the store is up", () => {
    const state = resolveDashboardState(input({ sessionsTotal: 0 }));

    expect(state.empty).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.hasData).toBe(false);
  });

  it("treats rows in hand as proof the store is up", () => {
    // A latched-"starting" source (ISS-4772) must not bury rows we already hold.
    const state = resolveDashboardState(input({ sessionsCountFresh: false }));

    expect(state.loading).toBe(false);
    expect(state.empty).toBe(false);
    expect(state.hasData).toBe(true);
    expect(state.sessionsCountKnown).toBe(true);
    // The header, the progress bar and the Recent Sessions caption read this —
    // a stuck probe must not leave all three saying "analyzing" over the rows.
    expect(state.analyzing).toBe(false);
  });

  it("routes an unavailable local source to the localized failure, not a skeleton", () => {
    // The disabled/unavailable responder answers `{ total: 0 }` SUCCESSFULLY, so
    // there is no error to settle on and no readiness coming: without this the
    // count stays unknowable and the skeleton holds for the life of the window.
    const state = resolveDashboardState(
      input({
        sessionSourceUnavailable: true,
        sessionsCountFresh: false,
        sessionsTotal: 0,
      })
    );

    expect(state.loading).toBe(false);
    expect(state.empty).toBe(false);
    expect(state.showError).toBe(false);
    expect(state.sessionsFailed).toBe(true);
  });

  it("stops the import wait when the session read fails after the total grew", () => {
    // `settled` is latched off the poll's `dataUpdatedAt`, which stops advancing
    // on a failed read — so `grew && !settled` would hold the skeleton forever.
    const state = resolveDashboardState(
      input({
        grew: true,
        settled: false,
        sessionsError: true,
        sessionsCountFresh: false,
        sessionsTotal: 0,
      })
    );

    expect(state.loading).toBe(false);
    expect(state.analyzing).toBe(false);
    expect(state.sessionsFailed).toBe(true);
    expect(state.empty).toBe(false);
  });

  it("shows the whole-page error state when an insights section fails", () => {
    const state = resolveDashboardState(
      input({ analyticsError: true, sessionsTotal: 0 })
    );

    expect(state.showError).toBe(true);
    expect(state.empty).toBe(false);
    expect(state.loading).toBe(false);
  });

  it("keeps a failed session read out of the empty state without blanking the page", () => {
    // Pre-fix this fell through to `empty`: the query's absent total read as a
    // confirmed zero. It must not become a whole-page error either — the Recent
    // Sessions card owns a localized treatment and the tiles are still valid.
    const state = resolveDashboardState(
      input({ sessionsError: true, sessionsTotal: 0 })
    );

    expect(state.empty).toBe(false);
    expect(state.showError).toBe(false);
    expect(state.loading).toBe(false);
  });

  it("does not hold the skeleton waiting on a session read that already failed", () => {
    const state = resolveDashboardState(
      input({
        sessionsError: true,
        sessionsCountFresh: false,
        sessionsTotal: 0,
      })
    );

    expect(state.loading).toBe(false);
  });

  it("keeps a terminal insights error ranked above an in-progress import", () => {
    // FEA-3240: a large import must not bury the Retry button.
    const state = resolveDashboardState(
      input({ analyticsError: true, grew: true, settled: false })
    );

    expect(state.showError).toBe(true);
    expect(state.loading).toBe(false);
  });

  it("holds loading while a retry is in flight", () => {
    const state = resolveDashboardState(
      input({ retrying: true, analyticsError: true })
    );

    expect(state.loading).toBe(true);
    expect(state.showError).toBe(false);
  });

  it("holds loading while the insights sections are still resolving", () => {
    const state = resolveDashboardState(input({ analyticsLoaded: false }));

    expect(state.loading).toBe(true);
    expect(state.empty).toBe(false);
  });

  it("holds loading while the local import is still growing the total", () => {
    const state = resolveDashboardState(
      input({ grew: true, settled: false, sessionsTotal: 12 })
    );

    expect(state.loading).toBe(true);
  });
});

/**
 * ISS-6002 (review cid 3761648058): the render where readiness flips. The read
 * has "settled" (it succeeded seconds ago, before the store opened) and the
 * source is now proven up — so a `settled && ready` test authorizes the stale
 * pre-store zero as a real empty install, for the whole poll interval before a
 * post-readiness result lands. The count is unknown until a NEWER successful
 * result arrives.
 */
describe("useSessionsCountFresh", () => {
  it("does not trust the pre-readiness result on the render where readiness flips", () => {
    const { result, rerender } = renderHook(
      (props: {
        sessionSourceReady: boolean;
        sessionsDataLoaded: boolean;
        dataUpdatedAt: number | undefined;
      }) => useSessionsCountFresh(props),
      {
        initialProps: {
          sessionSourceReady: false,
          sessionsDataLoaded: true,
          // A successful read landed at t=1000 — before the store opened.
          dataUpdatedAt: 1000,
        },
      }
    );

    expect(result.current).toBe(false);

    // Readiness flips. Nothing new has been read yet.
    rerender({
      sessionSourceReady: true,
      sessionsDataLoaded: true,
      dataUpdatedAt: 1000,
    });

    expect(result.current).toBe(false);

    // The next poll lands.
    rerender({
      sessionSourceReady: true,
      sessionsDataLoaded: true,
      dataUpdatedAt: 3500,
    });

    expect(result.current).toBe(true);
  });

  it("trusts the first read when the store was already up before it landed", () => {
    const { result, rerender } = renderHook(
      (props: {
        sessionSourceReady: boolean;
        sessionsDataLoaded: boolean;
        dataUpdatedAt: number | undefined;
      }) => useSessionsCountFresh(props),
      {
        initialProps: {
          sessionSourceReady: true,
          sessionsDataLoaded: false,
          dataUpdatedAt: 0,
        },
      }
    );

    expect(result.current).toBe(false);

    rerender({
      sessionSourceReady: true,
      sessionsDataLoaded: true,
      dataUpdatedAt: 1200,
    });

    expect(result.current).toBe(true);
  });

  it("stays unknown while the query holds no result at all", () => {
    const { result } = renderHook(() =>
      useSessionsCountFresh({
        sessionSourceReady: true,
        sessionsDataLoaded: false,
        dataUpdatedAt: undefined,
      })
    );

    expect(result.current).toBe(false);
  });
});
