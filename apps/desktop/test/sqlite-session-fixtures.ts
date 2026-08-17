import type { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { recomputeSessionLastActivityAt } from "../src/main/database/write-core.js";

/**
 * Row fixtures shared by the SQLite store suites.
 *
 * Extracted from `sqlite-agent-dashboard-database.test.ts` (shrink-only
 * grandfathered) when the session cursor-page cases moved to their own suite —
 * both suites seed rows the same way, and a second copy of these inserts is
 * exactly how two suites start disagreeing about what a seeded row looks like.
 */

type SqliteAgentDatabaseHandle = Awaited<
  ReturnType<typeof openSqliteAgentDatabase>
>;

export async function insertSqliteSession(
  db: SqliteAgentDatabaseHandle,
  id: string,
  overrides: {
    name?: string;
    status?: string;
    cwd?: string;
    model?: string;
    startedAt?: string;
    updatedAt?: string;
    endedAt?: string | null;
    awaitingInputSince?: string | null;
    metadata?: string | null;
  } = {}
): Promise<void> {
  const startedAt = overrides.startedAt ?? "2024-03-09T16:00:00.000Z";
  const updatedAt = overrides.updatedAt ?? startedAt;
  await db.run(
    `INSERT INTO sessions (
       id, name, status, cwd, model, started_at, updated_at, ended_at,
       awaiting_input_since, metadata, harness, billing_mode
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'codex', 'api')`,
    id,
    overrides.name ?? `Session ${id}`,
    overrides.status ?? "inactive",
    overrides.cwd ?? `/work/${id}`,
    overrides.model ?? "gpt-5",
    startedAt,
    updatedAt,
    overrides.endedAt ?? null,
    overrides.awaitingInputSince ?? null,
    overrides.metadata ?? null
  );
  // Seed the denormalized cursor sort key to the started-at floor, mirroring
  // what ingest (recomputeSessionLastActivityAt) writes for an event-less
  // session. insertSqliteEvent refreshes it from MAX(events) afterwards.
  await db.run(
    `UPDATE sessions
       SET last_activity_at = CASE
         WHEN started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
           THEN started_at
         ELSE '1970-01-01T00:00:00.000Z'
       END
     WHERE id = $1`,
    id
  );
}

export async function insertSqliteEvent(
  db: SqliteAgentDatabaseHandle,
  sessionId: string,
  createdAt: string
): Promise<void> {
  await db.run(
    `INSERT INTO events (id, session_id, event_type, created_at)
     VALUES ($1, $2, 'tool_use', $3)`,
    `${sessionId}-${createdAt}`,
    sessionId,
    createdAt
  );
  // Maintain the denormalized cursor sort key the same way ingest does: this
  // fixture writes an event directly, bypassing the importer/hook paths that
  // normally refresh last_activity_at. Call the production function rather than
  // re-implementing its SQL, so the test can never drift from ingest.
  await db.prisma.write((client) =>
    client.$transaction((tx) => recomputeSessionLastActivityAt(tx, sessionId))
  );
}
