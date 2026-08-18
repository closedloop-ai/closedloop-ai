/**
 * @file import-failed-run-status.test.ts
 * @description FEA-4187 / ISS-4586: the historical import path (`importSession`)
 * must classify a run that ended on an unrecovered API error as `error`, and a
 * finished non-failed run as `inactive` (the terminal-not-failed state that
 * supersedes `completed`). It also persists the durable `ends_with_error` flag
 * at import so the orphan reaper can later declare a still-active row terminal
 * without re-parsing. These DB-backed tests import real fixtures through the
 * production ingest path and assert the persisted session + main-agent status
 * and the flag.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-10T12:00:00.000Z";
// Well before NOW so `recentlyActive` (fileModifiedAt within 10 min of now) is
// false and the run is treated as a finished import, not a live session.
const OLD_FILE_MTIME_MS = Date.parse("2026-07-01T12:00:00.000Z");
const STARTED_AT = "2026-07-01T12:00:00.000Z";
const ASSISTANT_TS = "2026-07-01T12:03:00.000Z";
const ERROR_TS = "2026-07-01T12:05:00.000Z";
const ENDED_AT = "2026-07-01T12:05:30.000Z";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function openDb(dir: string): Promise<Db> {
  return await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

function baseFixture(sessionId: string): NormalizedSession {
  return baseSession({
    sessionId,
    cwd: "/sandbox/project",
    model: "claude-opus-4-5",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    fileModifiedAt: OLD_FILE_MTIME_MS,
    userMessages: 1,
    assistantMessages: 1,
    messages: [{ role: "assistant", timestamp: ASSISTANT_TS, text: "before" }],
  });
}

function failedFixture(sessionId: string): NormalizedSession {
  return {
    ...baseFixture(sessionId),
    apiErrors: [
      { type: "overloaded_error", message: "boom", timestamp: ERROR_TS },
    ],
  };
}

function successfulFixture(sessionId: string): NormalizedSession {
  return { ...baseFixture(sessionId), apiErrors: [] };
}

async function querySessionStatus(
  db: Db,
  sessionId: string
): Promise<
  | { status: string; ended_at: string | null; ends_with_error: number | null }
  | undefined
> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{
      status: string;
      ended_at: string | null;
      ends_with_error: number | null;
    }>
  >(
    "SELECT status, ended_at, ends_with_error FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0];
}

async function queryMainAgentStatus(
  db: Db,
  sessionId: string
): Promise<string | undefined> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ status: string }>
  >(
    "SELECT status FROM agents WHERE session_id = $1 AND type = 'main'",
    sessionId
  );
  return rows[0]?.status;
}

test("import of a run that ended on an unrecovered API error persists status=error and ends_with_error=1", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-failed-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-failed";
    const result = await db.importer.importSession(
      failedFixture(sessionId),
      "claude"
    );
    assert.notEqual(result.failed, true);

    const session = await querySessionStatus(db, sessionId);
    assert.equal(session?.status, "error");
    assert.notEqual(session?.status, "inactive");
    // ISS-4586: the durable flag is persisted so the reaper can classify a later
    // orphan without re-parsing.
    assert.equal(session?.ends_with_error, 1);
    // A failed run is terminal → its end is stamped, and its main agent errors.
    assert.equal(session?.ended_at, ENDED_AT);
    assert.equal(await queryMainAgentStatus(db, sessionId), "error");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("import of a genuinely successful run persists status=inactive and ends_with_error=0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-ok-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-ok";
    await db.importer.importSession(successfulFixture(sessionId), "claude");

    const session = await querySessionStatus(db, sessionId);
    assert.equal(session?.status, "inactive");
    assert.equal(session?.ends_with_error, 0);
    // The agent vocabulary keeps its own `completed` terminal.
    assert.equal(await queryMainAgentStatus(db, sessionId), "completed");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("import of a run with an error the agent recovered from stays inactive (ends_with_error=0)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-recovered-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-recovered";
    // Error at ERROR_TS, then a later assistant turn — the agent recovered, so
    // the run is not a failure.
    const recovered: NormalizedSession = {
      ...baseFixture(sessionId),
      messages: [
        { role: "assistant", timestamp: ASSISTANT_TS, text: "before" },
        { role: "assistant", timestamp: ENDED_AT, text: "recovered" },
      ],
      apiErrors: [
        { type: "overloaded_error", message: "boom", timestamp: ERROR_TS },
      ],
    };
    await db.importer.importSession(recovered, "claude");

    const session = await querySessionStatus(db, sessionId);
    assert.equal(session?.status, "inactive");
    assert.equal(session?.ends_with_error, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
