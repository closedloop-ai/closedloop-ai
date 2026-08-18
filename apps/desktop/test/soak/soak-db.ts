/**
 * @file soak-db.ts
 * @description Read-only SQLite probes of the profile under test. The harness
 * observes the outbox to measure the drain; it must never WRITE the database
 * the app owns, so every query here goes through a `query_only` connection.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OutboxDepths } from "./soak-types";

const execFileAsync = promisify(execFile);

async function sqliteQuery(dbPath: string, sql: string): Promise<string> {
  // `query_only` (not `-readonly`): the harness must never WRITE the DB under
  // test, but a WAL database with no -shm/-wal sidecars cannot be opened by a
  // readonly connection at all (SQLITE_CANTOPEN 14 — the reader may need to
  // create them). query_only keeps the connection write-proof at the SQL layer
  // while allowing the shm mapping.
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-cmd", ".timeout 15000", "-cmd", "PRAGMA query_only=ON;", dbPath, sql],
    { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }
  );
  return stdout.trim();
}

export async function outboxDepths(dbPath: string): Promise<OutboxDepths> {
  const out = await sqliteQuery(
    dbPath,
    "SELECT (SELECT count(*) FROM agent_session_sync_outbox WHERE status='pending'), (SELECT count(*) FROM agent_session_sync_outbox WHERE status='dead_lettered'), (SELECT count(*) FROM agent_component_invocation_sync_outbox WHERE status='pending');"
  );
  const [pending, deadLettered, invocationPending] = out
    .split("|")
    .map((value) => Number(value));
  return { pending, deadLettered, invocationPending };
}

/**
 * The pending session ids at cycle start — the NO-LOSS oracle's population.
 *
 * ISS-6098: this stays the pending-outbox subset, because "must drain" is
 * exactly what the outbox means and it is the only correct population for a
 * loss assertion. What it is NOT is the population of everything that may
 * legitimately reach the cloud: backfill enumerates sessions independently of
 * the outbox BY DESIGN (operator ruling, 2026-08-12), so on the 2,962-session
 * snapshot the 24 sessions outside the 2,938 pending rows arrived every cycle
 * and were scored `extra_synced:24` — a constant, structural false positive.
 * {@link localSessionIds} supplies the wider population that separates those
 * from a genuinely unknown id; the split is applied in `summarizeCloudDelivery`.
 */
export async function baselineOutboxIds(dbPath: string): Promise<string[]> {
  const out = await sqliteQuery(
    dbPath,
    "SELECT external_session_id FROM agent_session_sync_outbox WHERE status='pending' ORDER BY external_session_id;"
  );
  return splitIdRows(out);
}

/** Every session id in the local corpus — the population backfill may enumerate. */
export async function localSessionIds(dbPath: string): Promise<string[]> {
  const out = await sqliteQuery(dbPath, "SELECT id FROM sessions ORDER BY id;");
  return splitIdRows(out);
}

/**
 * Sessions the local DB says have at least one event row (ISS-6099).
 *
 * Used ONE-DIRECTIONALLY — local-has-events implies the delivered payload must
 * carry events. Never as an equality: the sync payload builder applies
 * documented caps (`eventRowCap`, the trace-source limits, the activity-segment
 * ceiling), and a cap shrinks a relation but never zeroes it, so this direction
 * cannot fire on a legitimate cap while still catching a whole-relation drop.
 *
 * `EXISTS` rather than `DISTINCT`/`GROUP BY` so this is an index probe per
 * session instead of a full scan of a multi-million-row events table.
 */
export async function sessionIdsWithEvents(dbPath: string): Promise<string[]> {
  const out = await sqliteQuery(
    dbPath,
    "SELECT s.id FROM sessions s WHERE EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id) ORDER BY s.id;"
  );
  return splitIdRows(out);
}

function splitIdRows(out: string): string[] {
  return out.length === 0 ? [] : out.split("\n");
}
