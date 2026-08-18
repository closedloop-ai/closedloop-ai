/**
 * ISS-6241: give a launch profile a REAL stale data-revision population.
 *
 * The boot rebuild is cursored on `sessions.data_revision`, so the only honest
 * way to make it work a population in an E2E is to leave rows behind that carry
 * an older revision — exactly what a user's machine looks like after a
 * DATA_REVISION bump ships. Resetting the stamp on sessions a PREVIOUS launch
 * imported (rather than inserting synthetic rows) keeps their transcripts on
 * disk, so the next launch's rebuild genuinely re-parses and re-derives them and
 * its progress numerator advances against work that really happened.
 *
 * Call this between launches, with the app CLOSED: it is a plain second
 * connection to the same libSQL file and takes no lock the running app would
 * have to yield.
 */

import { createClient } from "@libsql/client";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForMigrationsApplied,
} from "./desktop-seed-core";

/**
 * The statuses `groupTerminalStaleByHarness` treats as terminal
 * (`data-revision-rebuild.ts`). A non-terminal row is skipped into
 * `skippedActive` and never counted in the rebuild's denominator, so staling one
 * would make the population this helper reports disagree with the one the splash
 * renders.
 */
const TERMINAL_STATUSES = ["inactive", "error"];

/** A revision no build has ever stamped, so every touched row reads as stale. */
const STALE_REVISION = 0;

/** How often {@link waitForTerminalSessions} re-counts while it waits. */
const POLL_INTERVAL_MS = 500;

/**
 * Wait until the running launch has committed at least `minCount` TERMINAL
 * sessions, and report how many there are.
 *
 * This is the honest precondition for staling: the rows have to exist before
 * they can be given an old revision. Waiting on the DB rather than on the import
 * splash disappearing matters — the splash is held up by the whole post-boot
 * maintenance chain and its settle/stall timers, none of which this spec is
 * testing, so keying the handoff to it made a launch that had long since
 * imported everything read as an unfinished one.
 *
 * A plain second connection, same as {@link staleTerminalSessionRevisions}, so
 * it is safe to call while the app is still running.
 */
export async function waitForTerminalSessions(
  userDataDir: string,
  minCount: number,
  timeoutMs: number
): Promise<number> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(client, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    let seen = 0;
    while (Date.now() < deadline) {
      const result = await client.execute({
        sql: `SELECT COUNT(*) AS n FROM sessions WHERE status IN (${placeholders})`,
        args: TERMINAL_STATUSES,
      });
      seen = Number(result.rows[0]?.n ?? 0);
      if (seen >= minCount) {
        return seen;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${minCount} terminal sessions (saw ${seen})`
    );
  } finally {
    client.close();
  }
}

/**
 * Stale every terminal session in `userDataDir`'s store.
 *
 * Returns how many rows were staled — the exact population the next launch's
 * rebuild will report as its total, which is what lets a caller assert the
 * rendered denominator against a number the test itself established.
 */
export async function staleTerminalSessionRevisions(
  userDataDir: string,
  timeoutMs: number = SEED_SCHEMA_TIMEOUT_MS
): Promise<number> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(client, timeoutMs);
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    const result = await client.execute({
      sql: `UPDATE sessions SET data_revision = ?
            WHERE status IN (${placeholders})`,
      args: [STALE_REVISION, ...TERMINAL_STATUSES],
    });
    return Number(result.rowsAffected);
  } finally {
    client.close();
  }
}
