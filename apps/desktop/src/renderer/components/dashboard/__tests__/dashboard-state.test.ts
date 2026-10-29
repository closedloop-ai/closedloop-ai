import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type DashboardStateInput,
  DesktopDashboardContent,
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
  sessionImportActive: false,
  sessionsCountFresh: true,
  sessionsTotal: 1014,
  dateRange: "7d",
  windowSessionCount: 12,
  viewerHasSessions: true,
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
      sessionImportPending: false,
      content: DesktopDashboardContent.Ready,
    });
  });

  /**
   * ISS-9728: `content` is the fact the guided tour arms on. The canonical run
   * is measured against the `[data-tour]` anchors, and every one of them lives
   * on a row — so a page that returned early for loading, the whole-page error
   * or the empty treatment has none, and a run resolved there is Desktop's
   * intro card alone. Asserted as the FULL branch set rather than one case,
   * because the failure it guards is a state that reports rows it never drew.
   */
  it("reports ready only on the branch that actually lays out rows", () => {
    const byBranch = {
      ready: READY_WITH_DATA,
      loading: input({ sessionsCountFresh: false, sessionsTotal: 0 }),
      error: input({ analyticsError: true }),
      empty: input({ sessionsTotal: 0 }),
      // A failed session read still draws rows: the insights tiles are valid
      // and only the Recent Sessions card is degraded.
      sessionsFailed: input({ sessionsError: true, sessionsTotal: 0 }),
      // ISS-11927: every session predates the selected range.
      rangeHidden: input({ windowSessionCount: 0 }),
    };

    const contentByBranch = Object.fromEntries(
      Object.entries(byBranch).map(([name, given]) => [
        name,
        resolveDashboardState(given).content,
      ])
    );

    expect(contentByBranch).toEqual({
      ready: DesktopDashboardContent.Ready,
      loading: DesktopDashboardContent.Loading,
      error: DesktopDashboardContent.Error,
      empty: DesktopDashboardContent.Empty,
      sessionsFailed: DesktopDashboardContent.Ready,
      rangeHidden: DesktopDashboardContent.RangeHidden,
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

  it("stops the import wait when the session read fails", () => {
    // Terminal session failure outranks the live import signal. Otherwise a
    // terminal read failure would leave a degraded window pinned on skeletons.
    const state = resolveDashboardState(
      input({
        sessionImportActive: true,
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
      input({ analyticsError: true, sessionImportActive: true })
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

  it("uses parsed sessions while insights sections are still resolving", () => {
    const state = resolveDashboardState(input({ analyticsLoaded: false }));

    expect(state.loading).toBe(false);
    expect(state.empty).toBe(false);
  });

  /**
   * ISS-10651 — this replaces the case that asserted the opposite.
   *
   * That case ("holds loading while live local import status is active", 12
   * rows in hand) encoded a deliberate product choice: hide the dashboard for
   * the whole import. The operator superseded it — onboarding is
   * non-dismissible and already controls access, so the reader is meant to
   * watch the real heatmap fill in behind the modal. Rewritten here as a
   * counterfactual for the new behavior rather than deleted, so the state it
   * used to forbid is the state that is now pinned.
   */
  it("draws the partial dashboard over a running import once rows are in hand", () => {
    const state = resolveDashboardState(
      input({ sessionImportActive: true, sessionsTotal: 12 })
    );

    expect(state.loading).toBe(false);
    // The import is still reported, truthfully, above the page it no longer
    // hides: the progress bar and the "Parsing…" caption read these two.
    expect(state.sessionImportPending).toBe(true);
    expect(state.analyzing).toBe(true);
  });

  /**
   * The state a "just stop showing loading" change destroys: an import running
   * with nothing parsed yet has no partial page to reveal, so the skeleton is
   * the truthful screen and the settled-empty verdict must stay out of reach.
   */
  it("still holds loading over a running import that has produced no rows", () => {
    const state = resolveDashboardState(
      input({ sessionImportActive: true, sessionsTotal: 0 })
    );

    expect(state.loading).toBe(true);
    expect(state.empty).toBe(false);
  });

  it("names the genuine empty install once an empty import settles", () => {
    const state = resolveDashboardState(
      input({ sessionImportActive: false, sessionsTotal: 0 })
    );

    expect(state.loading).toBe(false);
    expect(state.empty).toBe(true);
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

/**
 * ISS-9992: the same verdict, named. `useTourArming` branches on this member
 * over a `Record`, so each one below is a real arm decision — `Empty` is the
 * one that now holds the first-launch tour shut.
 */
describe("resolveDashboardState content", () => {
  it("names a settled all-time zero on a proven-up store Empty", () => {
    // The member the tour gate acts on: the page drew `DashboardEmptySurface`, which
    // replaces the body before any row renders, so it emits no tour anchor at
    // all and every anchored beat would ring nothing.
    const state = resolveDashboardState(input({ sessionsTotal: 0 }));

    expect(state.content).toBe(DesktopDashboardContent.Empty);
  });

  it("names a populated dashboard Ready", () => {
    // Desktop's session read carries no date window, so this total is all-time
    // and the selected period is not an input here at all. That is why a
    // dormant install — zeroed tiles for the window, rows in the store — is
    // `Ready` and not the `Quiet` member web needs.
    const state = resolveDashboardState(READY_WITH_DATA);

    expect(state.content).toBe(DesktopDashboardContent.Ready);
  });

  it("names a still-resolving page without sessions Loading", () => {
    const state = resolveDashboardState(
      input({ analyticsLoaded: false, sessionsTotal: 0 })
    );

    expect(state.content).toBe(DesktopDashboardContent.Loading);
  });

  it("names a terminal insights failure Error", () => {
    const state = resolveDashboardState(input({ analyticsError: true }));

    expect(state.content).toBe(DesktopDashboardContent.Error);
  });

  it("names a failed session read Ready, not Empty", () => {
    // The rows are missing but the page is not the empty branch: reaching this
    // verdict at all requires `analyticsLoaded`, so the tiles hold real figures,
    // the body still renders its anchors, and the Recent Sessions card owns a
    // localized failure. ISS-10567 re-examined this fold and kept it: naming it
    // `Empty` would have drawn a static skeleton over those figures.
    const state = resolveDashboardState(
      input({ sessionsError: true, sessionsTotal: 0 })
    );

    expect(state.empty).toBe(false);
    expect(state.content).toBe(DesktopDashboardContent.Ready);
  });

  /**
   * ISS-11927. The shipped defect: `sessionsTotal` is all-time, so a reader
   * whose sessions all predate the default 7d range got `Ready` with every tile
   * zeroed and no hint that the range was hiding their data.
   */
  describe("when the selected range hides sessions (ISS-11927)", () => {
    it("names the page RangeHidden, not Ready with zeroed tiles", () => {
      const state = resolveDashboardState(input({ windowSessionCount: 0 }));

      expect(state.content).toBe(DesktopDashboardContent.RangeHidden);
      expect(state.empty).toBe(false);
    });

    it("never offers it on All time, where nothing is hidden", () => {
      const state = resolveDashboardState(
        input({ dateRange: "all", windowSessionCount: 0 })
      );

      expect(state.content).toBe(DesktopDashboardContent.Ready);
    });

    it("is the never-synced Empty, not RangeHidden, with no sessions at all", () => {
      const state = resolveDashboardState(
        input({ sessionsTotal: 0, windowSessionCount: 0 })
      );

      expect(state.content).toBe(DesktopDashboardContent.Empty);
    });

    it("waits for the window's own count rather than guessing", () => {
      // `null`: unread, carried over from the previous range, or no KPI.
      const state = resolveDashboardState(input({ windowSessionCount: null }));

      expect(state.content).toBe(DesktopDashboardContent.Ready);
    });

    // ISS-10651: rows outrank a running import, and a window zero read while
    // the import is still landing rows is not the settled zero the rule needs.
    it("does not claim the range hides sessions while the import is running", () => {
      const state = resolveDashboardState(
        input({ windowSessionCount: 0, sessionImportActive: true })
      );

      expect(state.content).toBe(DesktopDashboardContent.Ready);
    });

    it("lets loading and the whole-page error outrank it", () => {
      expect(
        resolveDashboardState(input({ windowSessionCount: 0, retrying: true }))
          .content
      ).toBe(DesktopDashboardContent.Loading);
      expect(
        resolveDashboardState(
          input({ windowSessionCount: 0, analyticsError: true })
        ).content
      ).toBe(DesktopDashboardContent.Error);
    });

    /**
     * whitlockk, review of #8982: in cloud mode `sessionsTotal` counts the whole
     * org while the KPIs follow Me, so a reader whose only history is a
     * teammate's was offered a widen that could reveal nothing of theirs.
     */
    it("is not offered when only someone outside the viewer scope has sessions", () => {
      const state = resolveDashboardState(
        input({ windowSessionCount: 0, viewerHasSessions: false })
      );

      expect(state.content).toBe(DesktopDashboardContent.Ready);
    });

    it("holds loading while the viewer-scoped history has not answered", () => {
      expect(
        resolveDashboardState(
          input({ windowSessionCount: 0, viewerHasSessions: null })
        ).content
      ).toBe(DesktopDashboardContent.Loading);
      // Only when the verdict needs it: a range with sessions draws its rows.
      expect(
        resolveDashboardState(
          input({ windowSessionCount: 3, viewerHasSessions: null })
        ).content
      ).toBe(DesktopDashboardContent.Ready);
    });
  });
});
