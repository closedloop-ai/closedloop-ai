/**
 * @file watchdog.ts
 * @description API error watchdog for the SQLite store. Polls active sessions
 * periodically and detects API errors that hooks may have missed (rate limits,
 * overloaded, quota exceeded). On finding an error event older than the stale
 * threshold, flips the session and main agent to `error` status.
 *
 * Activated by the CollectorManager or lifecycle hook on boot.
 *
 * FEA-1791: reads run on the single `DesktopPrisma` client's raw escape hatch
 * (`prisma.client.$queryRawUnsafe`) and the status flips go through
 * `prisma.write`, so they serialize with every other store write at the shared
 * write queue (the old `queue` option is gone — `prisma.write` is the queue).
 */

import type { DesktopPrisma } from "./prisma-client.js";

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
  prisma: DesktopPrisma,
  options?: WatchdogOptions
): Watchdog {
  const pollMs = options?.pollMs ?? WATCHDOG_POLL_MS_DEFAULT;
  const staleEventMs = options?.staleEventMs ?? WATCHDOG_STALE_EVENT_MS_DEFAULT;
  const log = options?.log ?? (() => {});
  let interval: ReturnType<typeof setInterval> | null = null;

  async function check(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - staleEventMs).toISOString();
      const active = await prisma.client.$queryRawUnsafe<
        { session_id: string; status: string }[]
      >(
        `SELECT s.id AS session_id, s.status
           FROM sessions s
           WHERE s.status NOT IN ('completed', 'abandoned', 'error')
             AND s.updated_at < $1`,
        cutoff
      );

      for (const row of active) {
        await checkSessionRow(prisma, row, cutoff, log);
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
  prisma: DesktopPrisma,
  row: { session_id: string; status: string },
  cutoff: string,
  log: (message: string) => void
): Promise<void> {
  const hasRecentError = await prisma.client.$queryRawUnsafe<{ one: number }[]>(
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
  const lastStop = await prisma.client.$queryRawUnsafe<
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
    const now = new Date().toISOString();
    // Flip session + main agent together so the dashboard never shows a session
    // in `error` with a still-running agent (or vice versa) between two writes.
    await prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE sessions SET status = 'error', updated_at = $1 WHERE id = $2 AND status NOT IN ('completed', 'error', 'abandoned')`,
          now,
          row.session_id
        );
        await tx.$executeRawUnsafe(
          `UPDATE agents SET status = 'error', ended_at = $1, updated_at = $1 WHERE session_id = $2 AND status NOT IN ('completed', 'error')`,
          now,
          row.session_id
        );
      })
    );
    log(
      `watchdog: session ${row.session_id} set to error (stale Stop with error summary)`
    );
  }
}
