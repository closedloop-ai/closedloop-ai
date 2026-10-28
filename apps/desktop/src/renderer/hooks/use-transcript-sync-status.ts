import { useEffect, useState } from "react";
import { exponentialBackoffMs } from "../../shared/exponential-backoff";
import type { TranscriptSyncStatusSnapshot } from "../../shared/transcript-sync-status-contract";

/**
 * The renderer's view of the status read. A discriminated union rather than a
 * nullable snapshot, so "not read yet" and "read failed" can never collapse
 * into each other or into a real all-zero `statusCounts`.
 *
 * ISS-10492: owned here, beside its only producer. It used to live in the
 * import splash's `sync-footnote-state.ts`, which was retired with that surface.
 */
export type TranscriptSyncStatusRead =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; snapshot: TranscriptSyncStatusSnapshot };

/** Normal poll cadence, and the base delay of the failure ladder. */
export const TRANSCRIPT_SYNC_POLL_MS = 5000;

/** Ceiling of the failure ladder: 5s → 10s → 20s → 40s → 60s → 60s … */
export const TRANSCRIPT_SYNC_BACKOFF_MAX_MS = 60_000;

/**
 * ISS-4716: poll the transcript archive lane's status for a session's
 * transcript availability.
 *
 * `active` is not optional bookkeeping — it is what keeps this cheap. An
 * ungated poller would run a `findMany` against the db-host worker every 5s for
 * the entire app session, on every launch, including through the first-boot
 * DATA_REVISION rebuild. The caller gates on whether the read is observable, so
 * an inactive caller costs exactly zero IPC. (The underlying read
 * runs on the reader pool for the same rebuild-contention reason — see
 * `listRecent` in `main/database/transcript-sync-store.ts`.)
 *
 * Failure handling distinguishes the two ways this can go wrong:
 * - **No bridge** (`window.desktopApi` absent — a bare test mount, or a
 *   non-Electron host): there is nothing to retry toward, so it settles on
 *   `unavailable` and stops.
 * - **A rejected read**: the call awaits a real Prisma query, so transient
 *   db-host hiccups are expected rather than exceptional. It reports
 *   `unavailable` and keeps retrying on the shared backoff ladder, resetting to
 *   the base cadence on the next success. Stopping here instead would pin
 *   "Upload status unavailable" for as long as the caller stays mounted.
 */
export function useTranscriptSyncStatus(
  active: boolean
): TranscriptSyncStatusRead {
  const [read, setRead] = useState<TranscriptSyncStatusRead>({
    state: "loading",
  });

  useEffect(() => {
    if (!active) {
      // Drop back to `loading` rather than holding the last value: when the
      // banner is shown again the footer must not flash a settled state read
      // minutes ago before the first fresh poll lands.
      setRead({ state: "loading" });
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let consecutiveFailures = 0;
    let timer: number | undefined;

    // Function declarations (not consts) so the mutual reference between
    // `schedule`, `kick` and `run` needs no forward declaration.
    function schedule(delayMs: number): void {
      timer = window.setTimeout(kick, delayMs);
    }

    /**
     * Start a poll without returning its promise. `run` already handles its own
     * rejections, so this handler only guards an unexpected throw — a status
     * footnote must never surface as an unhandled rejection.
     */
    function kick(): void {
      run().catch(() => {
        // Intentionally inert; `run`'s own catch owns the retry ladder.
      });
    }

    async function run(): Promise<void> {
      if (cancelled || inFlight) {
        return;
      }
      const getStatus = window.desktopApi?.getTranscriptSyncStatus;
      if (!getStatus) {
        setRead({ state: "unavailable" });
        return;
      }
      inFlight = true;
      try {
        const snapshot = await getStatus();
        if (cancelled) {
          return;
        }
        consecutiveFailures = 0;
        setRead({ state: "ready", snapshot });
        schedule(TRANSCRIPT_SYNC_POLL_MS);
      } catch {
        if (cancelled) {
          return;
        }
        consecutiveFailures += 1;
        setRead({ state: "unavailable" });
        schedule(
          exponentialBackoffMs(
            consecutiveFailures,
            TRANSCRIPT_SYNC_POLL_MS,
            TRANSCRIPT_SYNC_BACKOFF_MAX_MS
          )
        );
      } finally {
        inFlight = false;
      }
    }

    // Read immediately on the inactive→active edge; waiting a full period would
    // leave the footer on its skeleton for 5s every time the banner appears.
    setRead({ state: "loading" });
    kick();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [active]);

  return read;
}
