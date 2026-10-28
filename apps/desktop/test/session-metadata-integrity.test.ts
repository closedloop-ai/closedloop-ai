/**
 * @file session-metadata-integrity.test.ts
 * @description ISS-8259 — the store-integrity check that makes a malformed
 * `sessions.metadata` blob REPORTABLE.
 *
 * Every reader of that column degrades on it rather than throwing:
 * `deriveSessionTurnBuckets` returns `[]`, `recomputeLegacyMessageAgentTurnBuckets`
 * filters the row out in SQL, and the `json_valid` guards in the aggregate,
 * dashboard and branch-activity reads all skip it. Correct behavior, every one of
 * them — but before this check the condition reached the monitored path from
 * none of them, so a corrupted session stayed stale with no signal that anything
 * had skipped it.
 *
 * Pinned here: the count is right, a VALID neighbouring row is never counted,
 * `NULL` is absence rather than corruption, and the classifier turns a positive
 * count into exactly one content-free table issue.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  classifySessionMetadataIntegrity,
  runSessionMetadataIntegrityCheck,
} from "../src/main/database/session-metadata-integrity.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import type { StoreIntegrityIssue } from "../src/main/telemetry/telemetry-protocol.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-06-21T12:00:00.000Z";
const TS = "2026-06-20T08:00:00.000Z";

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss8259-metadata-integrity-")
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

async function insertSession(
  db: SqliteDb,
  id: string,
  metadata: string | null
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
     VALUES ($1, 'completed', 'claude_code', $2, $2, $3)`,
    id,
    TS,
    metadata
  );
}

test("ISS-8259: a malformed metadata blob is counted, its valid neighbour is not", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-valid", '{"entrypoint":"cli","messages":[]}');
    await insertSession(db, "sess-corrupt", "{not valid json");
    await insertSession(db, "sess-absent", null);

    const result = await runSessionMetadataIntegrityCheck(db.prisma);

    // Exactly the one corrupt row. The valid neighbour proves the predicate is
    // not simply counting every session, and the NULL row proves absence is not
    // being reported as corruption — a check that fired on either would be noise
    // on every healthy install and would be muted within a week.
    assert.deepEqual(result, { malformedRows: 1 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: a store with no corrupt metadata reports nothing", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-a", '{"entrypoint":"cli"}');
    await insertSession(db, "sess-b", null);

    assert.deepEqual(await runSessionMetadataIntegrityCheck(db.prisma), {
      malformedRows: 0,
    });

    const issues: StoreIntegrityIssue[] = [];
    classifySessionMetadataIntegrity({ malformedRows: 0 }, issues);
    assert.deepEqual(issues, [], "a healthy store raises no issue");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: a positive count becomes one content-free table issue", () => {
  const issues: StoreIntegrityIssue[] = [];
  classifySessionMetadataIntegrity({ malformedRows: 7 }, issues);

  // ONE issue however many rows are corrupt, and it names the TABLE only. The
  // blob is the largest column in the store and can hold prompt text, so neither
  // a session id nor a fragment of the value may ride the monitored event.
  assert.deepEqual(issues, [
    {
      check: "session_metadata",
      category: "malformed_session_metadata",
      object: "sessions",
      objectType: "table",
    },
  ]);
});
