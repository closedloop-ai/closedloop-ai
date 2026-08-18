import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { useEffect, useRef, useState } from "react";
import {
  type IngestProgress,
  useIngestProgress,
} from "../../hooks/use-ingest-progress";
import {
  describeQuarantinedSources,
  resolveQuarantinedStageCounts,
} from "../import-progress-display";

/**
 * The Sessions view's coarse display state, derived from the local session
 * source status (or collapsed to "ready" in Cloud mode). Shared with the summary
 * bar's error/loading resolvers below and the render model in `SessionsView`.
 */
export type SessionsDisplayState = "starting" | "ready" | "unavailable";

/**
 * The summary bar's error state: fold the usage read's own failure into it, but
 * only when there is no data to show. An initial metric-read failure (no
 * `summaryUsage`) must dash the delivery cards rather than render them as real
 * zeroes, while a refetch failure that still has last-good `summaryUsage` keeps
 * rendering it. An unavailable local source is always an error.
 */
export function resolveSummaryCardsErrored({
  displayState,
  metricReadErrored,
  hasSummaryUsage,
}: {
  displayState: SessionsDisplayState;
  metricReadErrored: boolean;
  hasSummaryUsage: boolean;
}): boolean {
  if (displayState === "unavailable") {
    return true;
  }
  return metricReadErrored && !hasSummaryUsage;
}

/**
 * The always-available cards' local-source props, passed to the shared card as a
 * FAILURE FALLBACK (ISS-4429). In Cloud mode the delivery `usage` reads the cloud
 * HTTP source, and the table beneath aggregates that same cloud population — so the
 * Sessions/Tokens/Cost cards now read that cloud `usage` too and reconcile with the
 * visible rows. These separately-read LOCAL SQLite totals (`localUsage`) back the
 * cards ONLY when the cloud delivery read has FAILED with no cloud totals in hand
 * (FEA-3574's original intent: a transient cloud read failure never blanks a metric
 * SQLite can compute), and a failed local fallback with no data dashes them
 * (`isLocalError`). In Local mode the delivery `usage` already IS the local source,
 * so both are omitted and the shared card falls back to `usage`/`isError`
 * byte-for-byte.
 *
 * FEA-4128 (scoped to the fallback path by ISS-4429): `alwaysAvailableLoading`
 * signals that the local fallback source is still hydrating — a first-launch import
 * is in flight OR the local read is pending. The shared card now only skeletons on
 * it when the cloud read has ALSO failed (otherwise a healthy cloud read paints its
 * real values immediately and never skeletons behind a background local import).
 * When it does apply, the import signal OUTRANKS a resolved-but-still-zero read
 * (the local IPC read resolves to a zero summary mid-import, so a "data present"
 * gate would mask it); a terminal error settles first (dash, never spin). The
 * import signal is self-terminating, so the fallback skeleton clears to the real
 * value — or an honest `0` for a genuinely empty store — once ingestion finishes.
 * Local mode gates the whole view on the local source being `ready`, so it never
 * loads.
 */
export function resolveLocalSummaryCardsProps({
  isCloudMode,
  canFetchAuxiliaryData,
  localUsageData,
  localUsageIsError,
  ingestProgress,
}: {
  isCloudMode: boolean;
  canFetchAuxiliaryData: boolean;
  localUsageData: AgentSessionUsageSummary | undefined;
  localUsageIsError: boolean;
  ingestProgress: IngestProgress | null;
}): {
  localUsage: AgentSessionUsageSummary | undefined;
  isLocalError: boolean;
  alwaysAvailableLoading: boolean;
  importInProgress: boolean;
  couldNotImportLabel: string | null;
} {
  if (!isCloudMode) {
    // ISS-4444 (codex P2): the skeleton/loading signals stay OFF in Local mode
    // (the view is gated on the local source being `ready`, so its cards never
    // race the import), but the quarantine count is a LOCAL boot-import concern
    // that is just as real for a signed-out/offline user — indeed those are
    // precisely the users whose local totals silently omit the quarantined
    // transcripts. Surface it here independently of the cloud fallback-loading
    // logic instead of forcing it to 0.
    return {
      localUsage: undefined,
      isLocalError: false,
      alwaysAvailableLoading: false,
      importInProgress: false,
      couldNotImportLabel: describeQuarantinedSources(
        resolveQuarantinedStageCounts(ingestProgress),
        "transcript"
      ),
    };
  }
  const isLocalError = localUsageIsError && localUsageData === undefined;
  // A terminal error settles first — dash the cards, never spin forever — and
  // outranks every loading signal. Otherwise an in-flight first-launch import
  // outranks a resolved-but-still-zero intermediate read: the local IPC usage
  // read RESOLVES to a still-zero summary while the db-host import is mid-flight
  // (so `localUsageData !== undefined` even though the store isn't populated),
  // and rendering that zero as a confirmed `0` is exactly the lie FEA-4128 hides.
  // `isLocalImportInProgress` is self-terminating (it goes false when the import
  // completes), so the skeleton clears to the real value — or an honest `0` for a
  // genuinely empty dataset — as soon as ingestion finishes. Absent an import, a
  // still-pending read (no data yet) also skeletons.
  const importInProgress = isLocalImportInProgress(ingestProgress);
  const localReadPending =
    canFetchAuxiliaryData && localUsageData === undefined;
  return {
    localUsage: localUsageData,
    isLocalError,
    alwaysAvailableLoading:
      !isLocalError && (importInProgress || localReadPending),
    // ISS-4429 (design-bot review): distinguish a GENUINE first-launch import
    // from a plain still-pending fallback read, so the card's wait caption tells
    // the truth. "Importing your history" must not caption a card that is merely
    // waiting on the local IPC read with no import running. Threaded to the card
    // as `importInProgress`; the plain pending case gets a neutral "Loading…".
    importInProgress: !isLocalError && importInProgress,
    // ISS-4444: transcripts the local boot import had to QUARANTINE (their parse
    // wedged repeatedly). Surfaced so the summary honestly says "N transcripts
    // couldn't be read" instead of silently under-counting. Degrades to 0 when
    // the field is absent (older main process → version-skew safe).
    couldNotImportLabel: describeQuarantinedSources(
      resolveQuarantinedStageCounts(ingestProgress),
      "transcript"
    ),
  };
}

/**
 * FEA-4128: is a first-launch local import actively populating the store? A
 * positive total with `processed < total`, or the pre-scan `preparing` phase
 * before a total is known. Matches `deriveImportState`'s `importing` in
 * `first-launch-import-banner.tsx` (the "Importing your agent history N/M"
 * banner). `null` (runtime not up / not yet polled) is treated as not importing.
 *
 * FEA-4156 (wongk): the boot-import watchdog `timedOut` state is TERMINAL — the
 * import gave up without settling, so `processed < total` stays true forever on
 * the wedged harness. Treat a timed-out import as no-longer-in-progress so the
 * summary cards resolve to their real (partial) values instead of skeletoning
 * indefinitely after the splash has already surfaced its graceful degraded state.
 */
export function isLocalImportInProgress(
  ingest: IngestProgress | null
): boolean {
  if (ingest === null || ingest.timedOut === true) {
    return false;
  }
  const importing = ingest.total > 0 && ingest.processed < ingest.total;
  return importing || (ingest.preparing && ingest.total === 0);
}

/**
 * FEA-4128 review (wongk): a BOUNDED wrapper over `useIngestProgress` for the
 * Sessions bar. `useIngestProgress` polls `getRuntimeStatus` every second for as
 * long as its `active` flag holds, so subscribing for the whole lifetime of the
 * open Cloud Sessions route would keep polling forever — long after the import
 * that the skeleton was waiting on has finished. The first-launch banner bounds
 * the same subscription to its visible import lifecycle; this hook does the
 * equivalent: it polls only while `enabled` AND the import has not yet been
 * observed complete, latching a stop once `ingest.complete` (or a settled
 * processed==total with a real total) is seen so the interval tears down. After
 * that latch the last snapshot is returned unchanged — the import is done, so the
 * skeleton has already cleared to real values and there is nothing left to drive.
 */
export function useSessionsImportProgress(
  enabled: boolean
): IngestProgress | null {
  // Latches true once we observe the boot import finish this session, so the
  // poll stops rather than running behind an already-cleared skeleton. Resets
  // when polling is disabled (e.g. leaving Cloud mode) so a later re-entry can
  // observe a fresh import.
  const [importComplete, setImportComplete] = useState(false);
  const lastProgressRef = useRef<IngestProgress | null>(null);
  const pollEnabled = enabled && !importComplete;
  const polled = useIngestProgress(pollEnabled);

  useEffect(() => {
    if (!enabled) {
      setImportComplete(false);
      lastProgressRef.current = null;
      return;
    }
    if (polled === null) {
      return;
    }
    lastProgressRef.current = polled;
    if (isImportSettled(polled)) {
      setImportComplete(true);
    }
  }, [enabled, polled]);

  // While polling, the live snapshot; after the latch, the last one observed.
  return pollEnabled ? polled : lastProgressRef.current;
}

/**
 * FEA-4181 (review cid 3653690775): the Sessions table body's unavailable /
 * syncing / loading trio, derived from the coarse display state and the list
 * query's error/loading flags in one named place instead of inline in the
 * `SessionsView` JSX.
 *
 * - `isUnavailable` — an errored read OR a not-yet-hydrated local source; never a
 *   false "no sessions" all-clear.
 * - `isSyncing` — the read is not a genuine breakage: either the local source
 *   hasn't come up yet (still initializing), OR the list read failed TRANSIENTLY
 *   (ISS-4483: the db-host child restarting mid-backfill, `isListErrorTransient`).
 *   Both route to the quiet "reconnecting / still importing" holding message with
 *   no error chrome or Retry — the read auto-retries and recovers on its own. Only
 *   a PERSISTENT read error gets the destructive alert + Retry, so syncing is
 *   flagged when the source is unavailable-without-error OR the error was transient.
 * - `isTableLoading` — the source is starting or the list read is on its first
 *   load.
 */
/**
 * ISS-4444 (wongk): is the boot import at a genuinely terminal state the poll may
 * latch off on? ONLY the two authoritative main-process signals qualify —
 * `complete` (every harness's boot import finished) or `timedOut` (the watchdog
 * gave up). Aggregate `processed >= total` is deliberately NOT terminal: it is
 * briefly true between the staggered per-harness passes, and — critically —
 * `recordFailure` increments `quarantinedCount` AFTER a poison source's
 * `processed` has already reached `total`. Latching on the aggregate count would
 * stop the poll ~90s before the quarantine count lands and freeze
 * `couldNotImportCount` at 0. Both terminal signals are self-terminating, so the
 * interval still tears down once one is observed.
 */
export function isImportSettled(ingest: IngestProgress): boolean {
  return ingest.complete || ingest.timedOut === true;
}

export function deriveSessionsAvailability({
  displayState,
  isListError,
  isListErrorTransient,
  isListLoading,
}: {
  displayState: SessionsDisplayState;
  isListError: boolean;
  /**
   * ISS-4483: was the settled list read error a TRANSIENT db-host-restart failure
   * (vs a genuine persistent one)? A transient error is not a breakage — it routes
   * to the syncing/reconnecting surface, never the hard error card. Defaults to
   * `false` (a plain errored read is fatal) so callers that can't classify keep the
   * pre-ISS-4483 behavior.
   */
  isListErrorTransient?: boolean;
  isListLoading: boolean;
}): { isUnavailable: boolean; isSyncing: boolean; isTableLoading: boolean } {
  const sourceUnavailable = displayState === "unavailable";
  return {
    isUnavailable: sourceUnavailable || isListError,
    isSyncing:
      (sourceUnavailable && !isListError) ||
      (isListError && isListErrorTransient === true),
    isTableLoading: displayState === "starting" || isListLoading,
  };
}
