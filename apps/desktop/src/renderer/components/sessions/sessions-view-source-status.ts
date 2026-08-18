import { useCallback, useEffect, useRef, useState } from "react";
import {
  LOCAL_SESSION_SOURCE_STATUSES,
  type LocalSessionSourceStatus,
  normalizeAgentMonitorLocalSessionSourceStatus,
} from "../../../shared/local-session-source-status";
import type { SessionsDisplayState } from "./sessions-summary-cards-state";

/**
 * ISS-4840: how many consecutive probe rejections a currently-`ready` source
 * absorbs before it is downgraded to `unavailable`. One — enough to ride out the
 * single transient rejection the ISS-4772 focus re-probe can provoke, small
 * enough that a genuine outage still surfaces on the very next attempt.
 */
const TRANSIENT_PROBE_REJECTION_TOLERANCE = 1;
/**
 * ISS-4840: delay before the bounded re-probe that adjudicates a tolerated
 * rejection. Long enough to clear a momentary IPC hiccup, short enough that a
 * real failure reaches the user promptly.
 */
const TRANSIENT_PROBE_RETRY_DELAY_MS = 750;

/**
 * Subscribes to the local agent-monitor source status for the desktop Sessions
 * view. Polls every 500ms while `starting`, refreshes on DB-change pushes, and
 * (ISS-4772) re-probes on tab visibility / window focus so a dropped
 * `getAgentMonitorUrl` transition after long uptime self-heals without a reload.
 * ISS-4840: a rejection while the source is `ready` is treated as transient
 * first — the last-known-good status holds through one bounded re-probe rather
 * than flipping the healthy view to `unavailable` on a focus-time blip — and a
 * persistent failure still lands on `unavailable`. That tolerance is counted per
 * INCIDENT, not per rejection, so the several probes a single return-to-window
 * fires (focus + visibilitychange, plus any DB-change push in the same tick)
 * cannot spend it all at once. The probes themselves are deliberately NOT
 * suppressed while one is in flight: the ISS-4772 latch this re-probe exists to
 * heal is a mount probe that never settles, so an in-flight guard would wedge
 * the view permanently. `recheck` forces an immediate re-poll (the list-recovery
 * Retry). Extracted from `SessionsView` so that grandfathered view stays under
 * the line ceiling.
 */
export function useLocalSessionSourceStatus(): {
  status: LocalSessionSourceStatus;
  recheck: () => void;
} {
  const [status, setStatus] = useState<LocalSessionSourceStatus>(
    LOCAL_SESSION_SOURCE_STATUSES.starting
  );
  // FEA-3639: holds the live effect's `refreshStatus` so a Retry can force an
  // immediate re-poll of the local source rather than waiting on the 500ms
  // starting-state interval. Reset to a no-op on teardown so a retry fired after
  // unmount never runs against a disposed effect.
  const refreshStatusRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    // ISS-4840: rejections observed since the last SUCCESSFUL probe, scoped to
    // this effect run (i.e. to the current `status`). Reset on every resolved
    // probe so an isolated blip hours apart can never accumulate into a
    // downgrade. See the catch handler below.
    let consecutiveProbeRejections = 0;
    let transientRetryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearTransientRetry = () => {
      if (transientRetryTimeoutId !== null) {
        globalThis.clearTimeout(transientRetryTimeoutId);
        transientRetryTimeoutId = null;
      }
    };

    const refreshStatus = () => {
      // Guard the synchronous entry point. A queued `setInterval` tick or an
      // `onDbChanged` callback can still fire after this effect is torn down
      // (component unmount, or a status-driven effect re-run). Bailing when
      // disposed and reading `window.desktopApi` defensively prevents
      // dereferencing a global that may have been removed post-unmount, which
      // would otherwise throw inside a React passive effect. This closes a real
      // async-cleanup leak (and the recurring `getAgentMonitorUrl` test flake).
      if (disposed) {
        return;
      }
      const desktopApi = window.desktopApi;
      if (!desktopApi) {
        return;
      }
      // ISS-6002: guard the METHOD, not just the object. The check above only
      // proves the preload bridge exists; a bridge without `getAgentMonitorUrl`
      // — version skew against an older preload, or a partial stub — then threw
      // "is not a function" from inside a React passive effect. An absent probe
      // is no evidence either way, so hold the current status rather than crash.
      if (typeof desktopApi.getAgentMonitorUrl !== "function") {
        return;
      }
      desktopApi
        .getAgentMonitorUrl()
        .then((payload) => {
          if (disposed) {
            return;
          }
          // A landed read is the authority: drop any armed transient retry and
          // clear the rejection tally so the tolerance below is per-incident,
          // not cumulative over the life of the mount.
          consecutiveProbeRejections = 0;
          clearTransientRetry();
          setStatus(normalizeAgentMonitorLocalSessionSourceStatus(payload));
        })
        .catch(() => {
          if (disposed) {
            return;
          }
          // ISS-4840 (codex review on PR #4266): an armed bounded retry means
          // this incident is ALREADY being adjudicated, so a rejection arriving
          // from an overlapping probe is the same incident, not a new one.
          // Restoring a minimized window fires `focus` AND `visibilitychange`
          // (and can land an `onDbChanged` push in the same tick), so one shared
          // IPC hiccup used to reject two or three parallel probes: the tally
          // reached 2 on the second, spending a tolerance meant for two SEPARATE
          // incidents and setting `unavailable` immediately — which re-ran this
          // effect and cleared the retry the first rejection had just armed, so
          // the view blanked anyway. Counting per INCIDENT rather than per
          // rejection fixes that WITHOUT suppressing the probe itself: a
          // re-probe must always be issued, because the ISS-4772 latch it heals
          // is a mount probe that never settles at all.
          if (transientRetryTimeoutId !== null) {
            return;
          }
          consecutiveProbeRejections += 1;
          // ISS-4840 (logical-QA cid 3696042498): the ISS-4772 focus/visibility
          // re-probe fires `refreshStatus` every time the window is returned to,
          // and this catch used to set `unavailable` unconditionally. So ONE
          // transient `getAgentMonitorUrl` rejection at focus time flipped a
          // healthy `ready` view to `unavailable` — zeroing rows/total and
          // dashing the summary cards while the cached rows sat right there.
          //
          // Mirror the list read's transient-vs-persistent classification: while
          // the source is currently `ready` — positive evidence it was up a
          // moment ago — hold that last-known-good status and re-probe once
          // after a short bounded delay instead of downgrading on the first
          // rejection. The failure is NOT swallowed: if the bounded retry also
          // rejects, the tolerance is spent and the next line reports
          // `unavailable`, so a genuine breakage still surfaces (one extra round
          // trip later) with its error chrome and Retry intact.
          //
          // Scoped deliberately to `ready`. A `starting` source has never proven
          // itself, so a cold-start failure still downgrades immediately — the
          // fix must not mask a source that never came up.
          if (
            status === LOCAL_SESSION_SOURCE_STATUSES.ready &&
            consecutiveProbeRejections <= TRANSIENT_PROBE_REJECTION_TOLERANCE
          ) {
            clearTransientRetry();
            transientRetryTimeoutId = globalThis.setTimeout(() => {
              transientRetryTimeoutId = null;
              refreshStatus();
            }, TRANSIENT_PROBE_RETRY_DELAY_MS);
            return;
          }
          setStatus(LOCAL_SESSION_SOURCE_STATUSES.unavailable);
        });
    };
    refreshStatusRef.current = refreshStatus;

    refreshStatus();

    // Read `window.desktopApi` defensively (same guard as `refreshStatus`): the
    // preload global can be absent when this effect runs — during a renderer
    // test whose global was torn down by a sibling suite, or a preload race —
    // and `window.desktopApi.onDbChanged?.(…)` optional-chains only the METHOD,
    // so a missing `desktopApi` would throw `reading 'onDbChanged'` inside a
    // React passive effect. Subscribe only when the API is present.
    const unsubscribe = window.desktopApi?.onDbChanged?.(() => {
      refreshStatus();
    });
    const intervalId =
      status === LOCAL_SESSION_SOURCE_STATUSES.starting
        ? globalThis.setInterval(refreshStatus, 500)
        : null;

    // ISS-4772 (logical-QA cid 3696042498): self-heal a dropped status transition.
    // The 500ms self-poll is armed while `starting`, so it is still firing in the
    // wedged state — but in a hidden or occluded renderer Chromium throttles that
    // timer to a crawl (the same background-throttling `sessions-list-poll-defaults`
    // documents for `refetchIntervalInBackground`), so a status update that never
    // lands (a `getAgentMonitorUrl` transition dropped after long uptime) can sit
    // un-rechecked until the user returns. Re-probe on tab visibility / window
    // focus — a bounded, event-driven re-fire (NOT a permanent high-frequency
    // poll) — so returning to the window forces an immediate fresh status read and
    // the latch heals without a reload. `refreshStatus` is disposal-guarded, so a
    // late event after unmount is a no-op. Listeners are removed in cleanup below.
    const reprobeOnVisible = () => {
      if (
        globalThis.document !== undefined &&
        globalThis.document.visibilityState === "hidden"
      ) {
        return;
      }
      refreshStatus();
    };
    globalThis.window?.addEventListener("focus", reprobeOnVisible);
    globalThis.document?.addEventListener("visibilitychange", reprobeOnVisible);

    return () => {
      disposed = true;
      refreshStatusRef.current = () => undefined;
      // ISS-4840: an armed transient retry must not outlive this effect —
      // otherwise a status change (or unmount) leaves a timer that re-probes
      // against a disposed effect and, worse, suppresses nothing while holding a
      // reference to the torn-down closure.
      clearTransientRetry();
      unsubscribe?.();
      globalThis.window?.removeEventListener("focus", reprobeOnVisible);
      globalThis.document?.removeEventListener(
        "visibilitychange",
        reprobeOnVisible
      );
      if (intervalId !== null) {
        globalThis.clearInterval(intervalId);
      }
    };
  }, [status]);

  const recheck = useCallback(() => {
    refreshStatusRef.current();
  }, []);

  return { status, recheck };
}

/**
 * ISS-4772 (wongk/codex/logical-QA review): the mode-aware Sessions read gate.
 * The gate must not flap off when a healthy local source latches back to
 * "starting" after a dropped `getAgentMonitorUrl` transition. Once we have
 * positive evidence the local source is up this render session — it has EVER
 * reported ready (`canReadLocalSessions`), or the boot import has been observed
 * complete (`ingestComplete`) — the gate latches open so the page-data query and
 * the import-progress poll keep running rather than freezing cached rows behind a
 * disabled query or promoting the display to "ready" over a scope the disabled
 * query never read. This latches the read gate to the SAME two signals that
 * collapse the display state below, so the two halves of the view can never
 * disagree about whether the source is up. A genuine cold start with no completed
 * import keeps reads gated. Cloud mode reads the HTTP source over the D-G bridge,
 * so it is never gated on the local monitor.
 */
export function useSessionsReadGate({
  isCloudMode,
  canReadLocalSessions,
  ingestComplete,
}: {
  isCloudMode: boolean;
  canReadLocalSessions: boolean;
  ingestComplete: boolean;
}): boolean {
  const [localSourceProvenUp, setLocalSourceProvenUp] = useState(false);
  useEffect(() => {
    if ((canReadLocalSessions || ingestComplete) && !localSourceProvenUp) {
      setLocalSourceProvenUp(true);
    }
  }, [canReadLocalSessions, ingestComplete, localSourceProvenUp]);
  return isCloudMode || canReadLocalSessions || localSourceProvenUp;
}

/**
 * Maps the raw local-source status to the coarse Sessions display state. A
 * `starting` source shows the syncing surface, `ready` shows the table, and any
 * other status is treated as `unavailable`.
 */
export function getSessionsDisplayState(
  status: LocalSessionSourceStatus
): SessionsDisplayState {
  if (status === LOCAL_SESSION_SOURCE_STATUSES.starting) {
    return "starting";
  }
  if (status === LOCAL_SESSION_SOURCE_STATUSES.ready) {
    return "ready";
  }
  return "unavailable";
}

/**
 * ISS-4772: collapse a latched "starting" display state to "ready" once the
 * evidence says the source is actually up — the page-data read already holds
 * rows, or the boot import has been observed complete. After long uptime a
 * dropped `getAgentMonitorUrl` transition can strand `localSessionSourceStatus`
 * on "starting" while the query and backend are healthy, blanking the list to an
 * infinite "Loading". Held data (or a settled import) always outranks the stale
 * "starting" label. The "unavailable"/errored state is a genuine breakage and is
 * returned untouched — never promoted to "ready". The read gate is promoted by
 * the same two signals in `SessionsView`, so the display and the read can never
 * disagree about whether the source is up.
 */
export function collapseStartingWhenDataHeld({
  rawDisplayState,
  hasHeldListData,
  ingestComplete,
}: {
  rawDisplayState: SessionsDisplayState;
  hasHeldListData: boolean;
  ingestComplete: boolean;
}): SessionsDisplayState {
  if (rawDisplayState !== "starting") {
    return rawDisplayState;
  }
  return hasHeldListData || ingestComplete ? "ready" : "starting";
}
