import { useEffect, useState } from "react";
import { exponentialBackoffMs } from "../../shared/exponential-backoff";
import type { TranscriptSyncStatusRead } from "../components/import-splash/sync-footnote-state";

/** Normal poll cadence, and the base delay of the failure ladder. */
export const TRANSCRIPT_SYNC_POLL_MS = 5000;

/** Ceiling of the failure ladder: 5s → 10s → 20s → 40s → 60s → 60s … */
export const TRANSCRIPT_SYNC_BACKOFF_MAX_MS = 60_000;

/**
 * ISS-4716: poll the transcript archive lane's status for the import-splash
 * footnote.
 *
 * `active` is not optional bookkeeping — it is what keeps this cheap.
 * `FirstLaunchImportBanner` never unmounts (it only collapses to `max-h-0` /
 * `inert`), so an ungated poller would run a `findMany` against the db-host
 * worker every 5s for the entire app session, on every launch, including
 * through the first-boot DATA_REVISION rebuild. The caller passes
 * `honestCopy && visible`, so the flag-off path costs exactly zero IPC and the
 * poll lives only as long as the footer is observable. (The underlying read
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
 *   "Upload status unavailable" for the rest of the session, because the banner
 *   never unmounts to reset it.
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
