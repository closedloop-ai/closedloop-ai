import type { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { recomputeSessionLastActivityAt } from "../src/main/database/write-core.js";
import {
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../src/main/enrichment/identity-key.js";

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

export async function insertSqliteAgent(
  db: SqliteAgentDatabaseHandle,
  sessionId: string,
  id: string
): Promise<void> {
  await db.run(
    `INSERT INTO agents (id, session_id, name, type, status, started_at, updated_at)
     VALUES ($1, $2, $3, 'main', 'completed', $4, $4)`,
    id,
    sessionId,
    `Agent ${id}`,
    "2026-09-21T11:05:00.000Z"
  );
}

/**
 * FEA-1899: PRs surface from artifact links (relation 'created'/'workspace')
 * joined to the canonical artifacts table — no longer from the pull_requests
 * detail store. Mirrors persistNormalizedPullRequests' identity_key/id scheme:
 * the ids come from `computeIdentityKey`/`artifactIdFromIdentityKey` rather
 * than being hand-built, so a change to the identity rule reaches these rows.
 */
export async function insertSqlitePrArtifact(
  db: SqliteAgentDatabaseHandle,
  sessionId: string,
  pr: {
    repoFullName: string;
    prNumber: number;
    title?: string | null;
    relation?: "created" | "workspace";
    observedAt?: string;
  }
): Promise<void> {
  const relation = pr.relation ?? "created";
  const observedAt = pr.observedAt ?? "2026-06-16T10:35:00.000Z";
  const identityKey = computeIdentityKey({
    kind: "pull_request",
    repoFullName: pr.repoFullName,
    prNumber: pr.prNumber,
  });
  const artifactId = artifactIdFromIdentityKey(identityKey);
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, title,
        harness, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, 'codex', $6, $6, $6)
     ON CONFLICT(identity_key) DO UPDATE SET
       title = COALESCE(artifacts.title, EXCLUDED.title),
       last_seen_at = EXCLUDED.last_seen_at`,
    artifactId,
    identityKey,
    pr.repoFullName,
    pr.prNumber,
    pr.title ?? null,
    observedAt
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, 'test_fixture', '{}', 0, 'candidate', 1, $5, $5)
     ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
    `${sessionId}:${artifactId}:${relation}`,
    sessionId,
    artifactId,
    relation,
    observedAt
  );
}
