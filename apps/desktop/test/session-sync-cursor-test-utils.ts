/**
 * @file session-sync-cursor-test-utils.ts
 * @description Shared reads for suites that assert on the FEA-1962 incremental
 * sync cursor: the stored `sessions.updated_at` watermark, and the ids the
 * production scan would hand the sync lane on resume. Both go through
 * `db.syncSource`, so a suite proves selection against the REAL query rather than
 * a re-derived predicate.
 */
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * The row's stored sync watermark. Returns the literal `"<absent: id>"` rather
 * than asserting, so a missing row fails the CALLER's timestamp comparison with
 * the session id in the message.
 */
export async function updatedAtOf(
  db: SqliteAgentDatabase,
  sessionId: string
): Promise<string> {
  const rows = await db.syncSource.listAllSessionCursorRows();
  const row = rows.find((candidate) => candidate.id === sessionId);
  return row?.updated_at ?? `<absent: ${sessionId}>`;
}

/**
 * The ids the production incremental scan would hand the sync lane when it
 * resumes from `watermark` having already delivered `observed`.
 */
export async function selectedSince(
  db: SqliteAgentDatabase,
  watermark: string,
  observed: readonly string[]
): Promise<string[]> {
  const rows = await db.syncSource.listUpdatedSessionCursorRows(watermark, [
    ...observed,
  ]);
  return rows.map((row) => row.id);
}
