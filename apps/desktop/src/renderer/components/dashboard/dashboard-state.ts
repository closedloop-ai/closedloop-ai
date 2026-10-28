import type { DashboardDateRange } from "@repo/app/insights/lib/dashboard-range";
import { dashboardRangeHidesSessions } from "@repo/app/insights/lib/dashboard-range-hides-sessions";
import { useEffect, useRef, useState } from "react";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../shared/local-session-source-status";
import { isBootImportSettled } from "../../hooks/ingest-progress-terminal";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import {
  isLocalImportInProgress,
  useSessionsImportProgress,
} from "../sessions/sessions-summary-cards-state";
import {
  useLocalSessionSourceStatus,
  useSessionsReadGate,
} from "../sessions/sessions-view-source-status";

/**
 * ISS-6002 — the first-launch dashboard's loading / error / empty decision,
 * extracted from `first-launch-dashboard.tsx` so it can be exercised directly
 * (and so that already-long view stops growing).
 *
 * The defect this module exists to close: the dashboard used to derive `empty`
 * from the session COUNT alone —
 *
 * ```
 * const hasData = sessionsTotal > 0;                          // data?.total ?? 0
 * const empty = !(loading || analyticsError || hasData);      // loading: insights only
 * ```
 *
 * — where `loading` was computed from the three insights queries and never
 * consulted the session read at all. A session read that was still in flight,
 * had failed, or had merely landed BEFORE the local SQLite store opened all
 * collapse to `0`, so the dashboard rendered a confident "No agent sessions yet"
 * on a machine holding 1,014 of them. Two conditions have to hold before a zero
 * is allowed to mean "this Mac has no sessions": the read must have SETTLED, and
 * the local store must have PROVEN it is up.
 */
export type DashboardStateInput = {
  /** All three insights sections resolved successfully. */
  analyticsLoaded: boolean;
  /** An insights section reached a terminal error — the whole-page error state. */
  analyticsError: boolean;
  /**
   * The session read reached a terminal error. Deliberately NOT folded into
   * `analyticsError`: the Recent Sessions card owns a localized "temporarily
   * unavailable" treatment and the insights tiles are still valid, so a failed
   * session read must not blank the page. It only has to stop the count being
   * reported as a real zero.
   */
  sessionsError: boolean;
  /**
   * The local session source is terminally `unavailable` (ISS-6002 review): the
   * agent-monitor probe reports the store cannot serve this render session and
   * the read gate never opened. Its disabled responder still answers `{ total: 0
   * }` SUCCESSFULLY, so without this the count is unknowable forever and the
   * skeleton never clears. Routed to the Recent Sessions failure, not the
   * whole-page error, for the same reason `sessionsError` is.
   */
  sessionSourceUnavailable: boolean;
  /** A user-driven retry is in flight. */
  retrying: boolean;
  /** The live local import is actively preparing or has sources left to import. */
  sessionImportActive: boolean;
  /**
   * A successful session read landed AFTER the local store proved it can serve
   * rows (see {@link useSessionsCountFresh}). Deliberately not "the read has
   * settled AND the store is now up": those two can both hold on the render
   * where readiness flips, while the only result in hand is still the pre-store
   * zero the fix exists to distrust.
   */
  sessionsCountFresh: boolean;
  sessionsTotal: number;
  /** ISS-11927: the selected Dashboard range. */
  dateRange: DashboardDateRange;
  /**
   * ISS-11927: the selected range's own sessions KPI
   * (`utilizationWindowSessionCount`), or `null` when the payload cannot answer
   * for this range yet.
   */
  windowSessionCount: number | null;
  /**
   * ISS-11927: the reader has sessions of their own over all time, in the SAME
   * viewer scope the KPIs read (Me or Org), or `null` while that read has not
   * answered. `sessionsTotal` cannot answer it in cloud mode: that read carries
   * no viewer scope, so it counts the whole org while the KPIs follow Me, and a
   * reader with only a teammate's history was offered "Show all time" that
   * could reveal nothing of theirs (whitlockk, review of #8982). A failed read is
   * `false`, never `null`, so it cannot hold the page in loading.
   */
  viewerHasSessions: boolean | null;
};

export type DashboardState = {
  loading: boolean;
  showError: boolean;
  empty: boolean;
  hasData: boolean;
  /**
   * The session read is not serviceable — it errored, or its source is
   * unavailable. Drives the Recent Sessions card's localized "temporarily
   * unavailable" treatment; never the whole-page error.
   */
  sessionsFailed: boolean;
  /** The count may be shown to the user (a fresh read, or rows in hand). */
  sessionsCountKnown: boolean;
  /**
   * The page is still working toward a trustworthy picture — the header's
   * "Analyzing locally", the progress bar, and the Recent Sessions "Parsing…"
   * caption. Built from the same two facts `loading` is, so a stuck readiness
   * probe cannot leave those three saying "analyzing" over a page that has no
   * import running.
   *
   * ISS-10651 made it a SUPERSET of `loading` rather than an equal: a running
   * import over rows already parsed now draws the real page, and these three
   * keep reporting that import truthfully above it.
   */
  analyzing: boolean;
  /**
   * Active import evidence, with terminal session failure outranking it so a
   * wedged import snapshot cannot pin the page. Still the exact fact the
   * progress bar and the "Parsing…" caption report; since ISS-10651 it only
   * ALSO holds the skeleton while no row has been parsed yet.
   */
  sessionImportPending: boolean;
  /**
   * WHICH of the four branches the page drew, as one closed value — folded from
   * the booleans above so a consumer asking "what is on screen" reads the one
   * answer instead of recombining them into a fifth. See
   * {@link DesktopDashboardContent}.
   */
  content: DesktopDashboardContent;
};

/**
 * Loading vs error vs empty vs ready.
 *
 * A terminal error still outranks import loading (FEA-3240), so a large import
 * cannot bury the Retry button. What changed for ISS-6002 is that the session
 * read now participates: it must have settled, and the store must be proven up,
 * before an absent row count is reported to the user as an empty install.
 *
 * ISS-9992 names that verdict as {@link DashboardState.content} too. Derived
 * from the booleans this function already computed — never a second reading of
 * the inputs — so the name and the branch the page takes cannot disagree.
 */
export function resolveDashboardState(
  input: DashboardStateInput
): DashboardState {
  const hasData = input.sessionsTotal > 0;
  // A read that cannot be serviced is not evidence of an empty Mac, but it is
  // terminal: waiting on it would hold the skeleton forever over insights that
  // already resolved, so it stops loading and routes to the localized failure.
  const sessionsFailed = input.sessionsError || input.sessionSourceUnavailable;
  const sessionImportPending = input.sessionImportActive && !sessionsFailed;
  // ISS-11927: the range verdict's two settled facts, read before `loading`
  // because an unanswered viewer read is the one thing still missing. A window
  // zero read while the import is still landing rows is not settled.
  const rangeMayHide =
    hasData &&
    !sessionImportPending &&
    dashboardRangeHidesSessions({
      dateRange: input.dateRange,
      windowSessionCount: input.windowSessionCount,
      hasSessionsOutsideWindow: true,
    });
  const viewerHistoryPending = rangeMayHide && input.viewerHasSessions === null;
  // Rows in hand are themselves proof the store is up — the same reasoning as
  // `collapseStartingWhenDataHeld`'s `hasHeldListData` on the Sessions view.
  const sessionsCountKnown = hasData || input.sessionsCountFresh;
  const analyticsPending = !(input.analyticsLoaded || input.analyticsError);
  // Not yet entitled to an opinion about the count.
  const sessionsUnknown = !(sessionsFailed || sessionsCountKnown);
  const analyzing = sessionsUnknown || sessionImportPending;
  // ISS-10651: real rows outrank a running import. Onboarding is
  // non-dismissible and already controls access, so there is nothing left for
  // the skeleton to withhold — the reader watches the heatmap fill from what
  // has actually been parsed. With no rows yet the import still holds loading,
  // which is what keeps the settled-empty verdict below out of reach until it
  // finishes, and keeps a true zero from being drawn over a live import.
  //
  // Deliberately UNGATED. A PostHog key cannot serve this change's subject: the
  // guest walking first-launch onboarding is signed out, and
  // `useDesktopPostHogFlagAssignment` closes a session with no account to
  // `flags: {}`, then adopts only the ISS-11945 anonymous keys
  // (`desktop-posthog-flag-assignment.ts`, the `!authedUserId`
  // branch), so every other key reads false for exactly the reader the operator asked
  // to reach. A gate here would be permanently shut where it matters.
  const importHoldsLoading = sessionImportPending && !hasData;
  const loading =
    input.retrying ||
    (!input.analyticsError && viewerHistoryPending) ||
    (analyticsPending && !hasData) ||
    (!input.analyticsError && (sessionsUnknown || importHoldsLoading));
  const showError = !loading && input.analyticsError;
  const empty = !(loading || input.analyticsError || sessionsFailed || hasData);
  // ISS-11927: the established "sessions exist outside the window" the shared
  // rule asks for is the VIEWER's all-time history, in the KPIs' scope. A
  // dormant install used to draw "Ready" with every tile zeroed for the
  // selected range.
  const rangeHidden =
    !(loading || showError) && rangeMayHide && input.viewerHasSessions === true;
  return {
    loading,
    showError,
    empty,
    hasData,
    sessionsFailed,
    sessionsCountKnown,
    analyzing,
    sessionImportPending,
    content: resolveDashboardContent({
      loading,
      showError,
      empty,
      rangeHidden,
    }),
  };
}

export type DashboardSessionSource = {
  /** The local session store has proven it can serve rows this render session. */
  ready: boolean;
  /** Live local import progress reports preparation or unprocessed sources. */
  importInProgress: boolean;
  /**
   * The local monitor reports the source is `unavailable` and the gate never
   * opened — terminal for this render session, not a slow start. Never set in
   * Cloud mode, whose rows come from the HTTP source over the D-G bridge and
   * never touch the local monitor.
   */
  unavailable: boolean;
};

/**
 * Whether the local session store has proven it can serve rows.
 *
 * This is the SAME gate the Sessions view already runs (FEA-2108 → ISS-4772 →
 * ISS-4840), reused rather than re-derived so the two surfaces cannot disagree
 * about whether the local source is up: `useSessionsReadGate` latches open once
 * the source has EVER reported ready or the boot import has been observed
 * complete, and Cloud mode bypasses the local monitor entirely because its rows
 * come from the HTTP source over the D-G bridge.
 *
 * The import-progress poll is enabled while the source is still `starting` for
 * the ISS-4772 reason: gating it behind readiness makes the boot-import-complete
 * heal unreachable in exactly the latched-`starting` state it exists to fix. It
 * self-terminates once the import settles.
 *
 * ISS-6002 (review): the STATUS is carried out alongside the gate rather than
 * collapsed into one boolean. `unavailable` and "still starting" are both
 * not-ready, but only one of them is ever going to resolve: the local
 * agent-dashboard responder answers a disabled/unavailable source with a
 * SUCCESSFUL `{ total: 0 }`, so a lost `unavailable` leaves nothing to error on,
 * nothing to settle, and a skeleton that holds for the life of the window.
 */
export function useDashboardSessionSource(): DashboardSessionSource {
  const { status } = useLocalSessionSourceStatus();
  const canReadLocalSessions = status === LOCAL_SESSION_SOURCE_STATUSES.ready;
  const isCloudMode = useDesktopAppCoreMode() === DesktopAppCoreMode.Cloud;
  const ingestProgress = useSessionsImportProgress(
    isCloudMode ||
      canReadLocalSessions ||
      status === LOCAL_SESSION_SOURCE_STATUSES.starting
  );
  // ISS-6207: any terminal boot-import state, not completion specifically. Not
  // behind the Labs gate — see `isBootImportSettled`: `complete` alone no longer
  // goes true on a degraded terminal, so gating this would leave the read
  // disabled for the whole session rather than restore the old behaviour.
  const ready = useSessionsReadGate({
    isCloudMode,
    canReadLocalSessions,
    ingestSettled: isBootImportSettled(ingestProgress),
  });
  return {
    ready,
    importInProgress: !isCloudMode && isLocalImportInProgress(ingestProgress),
    // Scoped to a gate that never opened. A source that goes `unavailable` AFTER
    // proving itself leaves the read to report its own failure (or to keep
    // serving cached rows), which is the more specific signal of the two.
    unavailable:
      !(isCloudMode || ready) &&
      status === LOCAL_SESSION_SOURCE_STATUSES.unavailable,
  };
}

/**
 * ISS-6002 (review): has a successful session read landed SINCE the local store
 * proved it can serve rows?
 *
 * `settled && ready` is not that question. Both hold on the render where
 * readiness flips — `isSuccess` is still true from the pre-store read — so the
 * stale zero that read returned would be authorized as a real empty install for
 * the whole poll interval before a post-readiness result lands. Baselining on
 * `dataUpdatedAt` (which advances only on a SUCCESSFUL fetch) closes that
 * window: the count counts only once a newer result has replaced it.
 *
 * `sessionsDataLoaded` is the query holding a result rather than `isSuccess`, so
 * a refetch error does not discard a count already proven fresh — react-query
 * keeps `data` and freezes `dataUpdatedAt`, which is exactly "the last thing we
 * actually measured".
 */
export function useSessionsCountFresh({
  sessionSourceReady,
  sessionsDataLoaded,
  dataUpdatedAt,
}: {
  sessionSourceReady: boolean;
  sessionsDataLoaded: boolean;
  dataUpdatedAt: number | undefined;
}): boolean {
  const [readyBaseline, setReadyBaseline] = useState<number | null>(null);
  useEffect(() => {
    if (sessionSourceReady && readyBaseline === null) {
      setReadyBaseline(dataUpdatedAt ?? 0);
    }
  }, [sessionSourceReady, dataUpdatedAt, readyBaseline]);
  return (
    sessionsDataLoaded &&
    readyBaseline !== null &&
    (dataUpdatedAt ?? 0) > readyBaseline
  );
}

/**
 * Backfill settle detection: while the local DB is still importing, the session
 * total keeps growing. Poll the cheap session list and treat the data as
 * "appropriately backfilled" once the total stops growing across consecutive
 * polls, at which point the caller stops polling.
 *
 * ISS-6002: a total read before the store proves it is up is NOT evidence that
 * the import stopped growing — it is what an unopened store reports. Counting
 * those reads as stable latched `settled` at zero within ~5-7.5s of mount (three
 * polls, 2.5s apart) on a machine whose store did not begin serving until
 * ~10.6s, which permanently stopped the poll at `0`. Stability is now only
 * counted once the source is proven up or rows are already in hand.
 */
export function useBackfillSettleDetection({
  sessionsTotal,
  isLoading,
  dataUpdatedAt,
  sessionSourceReady,
  settled,
  setSettled,
}: {
  sessionsTotal: number;
  isLoading: boolean;
  dataUpdatedAt: number | undefined;
  sessionSourceReady: boolean;
  settled: boolean;
  setSettled: (v: boolean) => void;
}) {
  const lastTotalRef = useRef<number | null>(null);
  const stableHitsRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataUpdatedAt is the intended trigger — it advances on every poll even when the total is unchanged, which is how we count consecutive no-growth polls.
  useEffect(() => {
    if (isLoading || settled) {
      return;
    }
    if (!(sessionSourceReady || sessionsTotal > 0)) {
      return;
    }
    if (lastTotalRef.current === sessionsTotal) {
      stableHitsRef.current += 1;
    } else {
      stableHitsRef.current = 0;
      lastTotalRef.current = sessionsTotal;
    }
    if (stableHitsRef.current >= 2) {
      setSettled(true);
    }
  }, [
    sessionsTotal,
    isLoading,
    dataUpdatedAt,
    sessionSourceReady,
    settled,
    setSettled,
  ]);
}

/**
 * ISS-9992 — what the dashboard DREW, as one closed value.
 *
 * Deliberately a DESKTOP-LOCAL vocabulary. ISS-9397 makes `DashboardSurfaceV2`
 * the single owner of Dashboard presentation across both hosts and replaces
 * this with the shared `DashboardContentState` at that cutover; promoting it
 * here would move the same code twice, so this is the seam, not the answer.
 *
 * There is no `Quiet` member because Desktop has no quiet population to name.
 * Its session read carries no date window, so `sessionsTotal` is an ALL-TIME
 * count for the active scope and a dormant install has a non-zero one — it
 * draws the full dashboard with zeroed tiles for the selected period and never
 * reaches the empty branch. Web needs that member because its Recent Sessions
 * card is pinned to a fixed seven-day window, where a zero cannot tell a
 * brand-new org from a dormant one.
 */
export const DesktopDashboardContent = {
  Loading: "loading",
  Error: "error",
  Empty: "empty",
  /**
   * ISS-11927: sessions exist, and the selected range hides all of them. The
   * body is the shared date-range empty with "Show all time"
   * (`DashboardRangeEmptyBody`), the same one web draws. Desktop's quiet
   * population, named: no rows are drawn, so nothing anchors a tour beat.
   */
  RangeHidden: "range-hidden",
  Ready: "ready",
} as const;
export type DesktopDashboardContent =
  (typeof DesktopDashboardContent)[keyof typeof DesktopDashboardContent];

/**
 * The same precedence {@link resolveDashboardState} already resolved, named.
 *
 * Takes the computed booleans rather than the raw input so there is exactly one
 * derivation: a second reading of `sessionsTotal` here is how the name and the
 * branch `DashboardBody` actually takes would come to disagree.
 *
 *
 * ISS-10567 considered folding a terminal session failure holding no rows in
 * here too, and did not: reaching this function at all requires `analyticsLoaded`,
 * so on that branch the insights queries have already SUCCEEDED and their tiles
 * carry real figures. Naming it `Empty` would have replaced them with a static
 * skeleton asserting a zero none of them reported. `Ready` with the Recent
 * Sessions card's localized failure is the honest screen, and is what ISS-9992
 * already chose.
 */
function resolveDashboardContent({
  loading,
  showError,
  empty,
  rangeHidden,
}: Pick<DashboardState, "loading" | "showError" | "empty"> & {
  rangeHidden: boolean;
}): DesktopDashboardContent {
  if (loading) {
    return DesktopDashboardContent.Loading;
  }
  if (showError) {
    return DesktopDashboardContent.Error;
  }
  if (empty) {
    return DesktopDashboardContent.Empty;
  }
  if (rangeHidden) {
    return DesktopDashboardContent.RangeHidden;
  }
  return DesktopDashboardContent.Ready;
}
