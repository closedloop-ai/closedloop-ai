/**
 * @file watchdog.ts
 * @description API error watchdog for the SQLite store. Polls active sessions
 * periodically and detects API errors that hooks may have missed (rate limits,
 * overloaded, quota exceeded). On finding an error event older than the stale
 * threshold, flips the session and main agent to `error` status.
 *
 * Activated by the CollectorManager or lifecycle hook on boot.
 *
 * Reads run on the raw escape hatch (`prisma.client.$queryRawUnsafe`, which is
 * clone-safe across the db-host method proxy). The status flip is a
 * `prisma.write` transaction that cannot cross that proxy from the main process,
 * so it runs in the db host via the clone-safe `agentDatabase.markSessionErrored`
 * method (FEA-2252); it still serializes on the shared write queue there.
 */

import type { DbHostAgentDatabase } from "./sqlite.js";

// The watchdog runs in the MAIN process, so it takes the proxied agentDatabase
// (NOT the raw `prisma`): clone-safe `prisma.client` reads plus the clone-safe
// `markSessionErrored` write, both of which forward to the db host. Typing it
// against DbHostAgentDatabase means `prisma.read`/`prisma.write` are not even
// callable here (a compile error), not just a runtime DataCloneError.
type WatchdogDb = Pick<DbHostAgentDatabase, "prisma" | "markSessionErrored">;

export const WATCHDOG_POLL_MS_DEFAULT = 15_000;
export const WATCHDOG_STALE_EVENT_MS_DEFAULT = 10_000;

const ERROR_SUMMARY_RE = /error|fail|timeout|rate|quota|overload/i;

export type WatchdogOptions = {
  pollMs?: number;
  staleEventMs?: number;
  log?: (message: string) => void;
};

export type Watchdog = {
  start(): void;
  stop(): void;
};

export function createApiErrorWatchdog(
  db: WatchdogDb,
  options?: WatchdogOptions
): Watchdog {
  const pollMs = options?.pollMs ?? WATCHDOG_POLL_MS_DEFAULT;
  const staleEventMs = options?.staleEventMs ?? WATCHDOG_STALE_EVENT_MS_DEFAULT;
  const log = options?.log ?? (() => {});
  let interval: ReturnType<typeof setInterval> | null = null;

  async function check(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - staleEventMs).toISOString();
      const active = await db.prisma.client.$queryRawUnsafe<
        { session_id: string; status: string }[]
      >(
        `SELECT s.id AS session_id, s.status
           FROM sessions s
           WHERE s.status NOT IN ('completed', 'abandoned', 'error')
             AND s.updated_at < $1`,
        cutoff
      );

      for (const row of active) {
        await checkSessionRow(db, row, cutoff, log);
      }
    } catch (error) {
      log(
        `watchdog check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    start(): void {
      if (interval) {
        return;
      }
      interval = setInterval(check, pollMs);
      if (typeof interval === "object" && "unref" in interval) {
        interval.unref();
      }
    },
    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}

async function checkSessionRow(
  db: WatchdogDb,
  row: { session_id: string; status: string },
  cutoff: string,
  log: (message: string) => void
): Promise<void> {
  const hasRecentError = await db.prisma.client.$queryRawUnsafe<
    { one: number }[]
  >(
    `SELECT 1 AS one FROM events
     WHERE session_id = $1
       AND event_type = 'APIError'
       AND created_at >= $2
     LIMIT 1`,
    row.session_id,
    cutoff
  );
  if (hasRecentError.length > 0) {
    return;
  }
  const lastStop = await db.prisma.client.$queryRawUnsafe<
    { created_at: string; summary: string | null }[]
  >(
    `SELECT created_at, summary FROM events
     WHERE session_id = $1 AND event_type = 'Stop'
     ORDER BY created_at DESC LIMIT 1`,
    row.session_id
  );
  if (lastStop.length === 0) {
    return;
  }
  const stopRow = lastStop[0];
  if (!stopRow.created_at || stopRow.created_at >= cutoff) {
    return;
  }
  if (stopRow.summary && ERROR_SUMMARY_RE.test(stopRow.summary)) {
    // The session + main-agent flip is a transaction that runs in the db host
    // (a `prisma.write` callback can't cross the method proxy from the main
    // process). markSessionErrored applies both UPDATEs atomically there.
    await db.markSessionErrored(row.session_id);
    log(
      `watchdog: session ${row.session_id} set to error (stale Stop with error summary)`
    );
  }
}
