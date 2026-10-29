/**
 * @file session-status-production-writer-sweep.test.ts
 * @description ISS-9558 runtime sweep for production Desktop writers of
 * `sessions.status`. The source gate catches future literal/column-list drift;
 * this test drives the current bound-parameter writers through real entry
 * points against real SQLite and verifies the analytics copy stays lifecycle-only.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { Harness } from "../src/main/collectors/types.js";
import { RECENT_ACTIVITY_MS } from "../src/main/database/db-constants.js";
import { sweepOrphanedSessions } from "../src/main/database/session-maintenance.js";
import {
  APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES,
  type ApprovedDesktopSessionStatusBoundWrite,
} from "../src/main/database/session-status-bound-writes.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-06-07T12:00:00.000Z";
const STARTED_AT = "2026-06-07T10:00:00.000Z";
const ENDED_AT = "2026-06-07T10:30:00.000Z";
const STALE_UPDATED_AT = "2026-06-07T08:00:00.000Z";
const STALE_LAST_ACTIVITY_AT = "2026-06-07T08:30:00.000Z";
const RECENT_FILE_MTIME_MS = Date.parse(NOW) - RECENT_ACTIVITY_MS / 2;
const STALE_FILE_MTIME_MS = Date.parse(NOW) - RECENT_ACTIVITY_MS * 10;

const LIFECYCLE_VALUES: ReadonlySet<string> = new Set(
  Object.values(SESSION_STATUS)
);
const APPROVED_BOUND_WRITE_FIXTURE_IDS = {
  [APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES.LiveHookSetSessionStatusUpdate]:
    ["iss9558-live-stop-error", "iss9558-live-session-end"],
  [APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES.ImportPhaseSessionAndMainAgentInsert]:
    ["iss9558-import-new"],
  [APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES.ReconcileTerminalSessionUpdate]:
    ["iss9558-import-terminal-heal"],
  [APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES.MinimalCodexSessionUpsertInsert]:
    ["iss9558-codex-otel"],
} satisfies Record<ApprovedDesktopSessionStatusBoundWrite, readonly string[]>;

type StatusRow = {
  id: string;
  status: string | null;
};

type AnalyticsStatusRow = {
  session_id: string;
  status: string | null;
};

test("ISS-9558: production Desktop session-status writers persist only lifecycle values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss9558-status-writers-"));
  const db = await openTestDb(dir, { now: () => NOW });
  try {
    const exercisedSessionIds = [
      "iss9558-live-start",
      "iss9558-live-stop-error",
      "iss9558-live-session-end",
      "iss9558-live-reactivated",
      "iss9558-import-new",
      "iss9558-import-reactivated",
      "iss9558-import-terminal-heal",
      "iss9558-sweep-inactive",
      "iss9558-sweep-error",
      "iss9558-codex-otel",
    ];

    await exerciseLiveWriters(db);
    await exerciseImportWriters(db);
    const staleSweep = await exerciseStaleSweepWriter(db);
    assert.equal(
      staleSweep.swept,
      2,
      "both stale active fixtures must be swept"
    );
    assert.equal(staleSweep.heldBack, 0);
    await exerciseCodexOtelWriter(db);

    const analytics = await db.recomputeAnalyticsRollups(exercisedSessionIds);
    assert.equal(analytics.failed, 0, "analytics recompute must not fail");

    const sessionRows = await selectSessionStatuses(db, exercisedSessionIds);
    assert.deepEqual(
      sessionRows.map((row) => row.id).sort(),
      [...exercisedSessionIds].sort(),
      "the sweep must observe every production-writer fixture"
    );
    assert.deepEqual(
      approvedBoundWriterFixtureProblems(sessionRows.map((row) => row.id)),
      [],
      "every approved bound writer must be exercised by at least one observed sessions.status fixture"
    );
    assert.deepEqual(
      findNonLifecycleStatuses(
        sessionRows.map((row) => ({ owner: row.id, status: row.status }))
      ),
      [],
      "sessions.status"
    );

    const analyticsRows = await selectAnalyticsStatuses(
      db,
      exercisedSessionIds
    );
    assert.deepEqual(
      analyticsRows.map((row) => row.session_id).sort(),
      [...exercisedSessionIds].sort(),
      "the analytics copy must be populated for every writer fixture"
    );
    assert.deepEqual(
      findNonLifecycleStatuses(
        analyticsRows.map((row) => ({
          owner: row.session_id,
          status: row.status,
        }))
      ),
      [],
      "session_analytics.status"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function exerciseLiveWriters(db: SqliteAgentDatabase): Promise<void> {
  await db.processEvent(
    "SessionStart",
    { session_id: "iss9558-live-start" },
    "claude"
  );
  await db.processEvent(
    "Stop",
    { session_id: "iss9558-live-stop-error", stop_reason: "error" },
    "claude"
  );
  await db.processEvent(
    "SessionEnd",
    { session_id: "iss9558-live-session-end" },
    "claude"
  );
  await seedSessionWithMainAgent(db, {
    endedAt: ENDED_AT,
    id: "iss9558-live-reactivated",
    status: SESSION_STATUS.INACTIVE,
    updatedAt: STALE_UPDATED_AT,
  });
  await db.processEvent(
    "UserPromptSubmit",
    { session_id: "iss9558-live-reactivated" },
    "claude"
  );
}

async function exerciseImportWriters(db: SqliteAgentDatabase): Promise<void> {
  await db.importer.importSession(
    makeSession({
      endedAt: ENDED_AT,
      fileModifiedAt: STALE_FILE_MTIME_MS,
      sessionId: "iss9558-import-new",
      startedAt: STARTED_AT,
    }),
    Harness.Claude
  );

  await db.importer.importSession(
    makeSession({
      endedAt: ENDED_AT,
      fileModifiedAt: STALE_FILE_MTIME_MS,
      sessionId: "iss9558-import-reactivated",
      startedAt: STARTED_AT,
    }),
    Harness.Claude
  );
  await db.importer.importSession(
    makeSession({
      endedAt: ENDED_AT,
      fileModifiedAt: RECENT_FILE_MTIME_MS,
      sessionId: "iss9558-import-reactivated",
      startedAt: STARTED_AT,
    }),
    Harness.Claude
  );

  await db.importer.importSession(
    makeSession({
      endedAt: ENDED_AT,
      endedOnUnrecoveredError: false,
      fileModifiedAt: STALE_FILE_MTIME_MS,
      sessionId: "iss9558-import-terminal-heal",
      startedAt: STARTED_AT,
    }),
    Harness.Claude
  );
  await db.importer.importSession(
    makeSession({
      endedAt: ENDED_AT,
      endedOnUnrecoveredError: true,
      fileModifiedAt: STALE_FILE_MTIME_MS,
      sessionId: "iss9558-import-terminal-heal",
      startedAt: STARTED_AT,
    }),
    Harness.Claude
  );
}

async function exerciseStaleSweepWriter(
  db: SqliteAgentDatabase
): Promise<Awaited<ReturnType<typeof sweepOrphanedSessions>>> {
  await seedSessionWithMainAgent(db, {
    endsWithError: 0,
    id: "iss9558-sweep-inactive",
    status: SESSION_STATUS.ACTIVE,
    updatedAt: STALE_UPDATED_AT,
  });
  await seedSessionWithMainAgent(db, {
    endsWithError: 1,
    id: "iss9558-sweep-error",
    status: SESSION_STATUS.ACTIVE,
    updatedAt: STALE_UPDATED_AT,
  });

  return sweepOrphanedSessions(db.prisma, NOW);
}

async function exerciseCodexOtelWriter(db: SqliteAgentDatabase): Promise<void> {
  await db.codexOtel.persistBatch({
    spans: [
      {
        attributes: {
          "gen_ai.system": "codex",
          "session.id": "iss9558-codex-otel",
        },
        durationMs: 125,
        endTime: "2026-06-07T12:00:00.125Z",
        name: "codex.exec",
        sessionId: "iss9558-codex-otel",
        spanId: "span-1",
        startTime: "2026-06-07T12:00:00.000Z",
        status: "ok",
        traceId: "trace-1",
      },
    ],
    tokenUsage: [],
  });
}

async function seedSessionWithMainAgent(
  db: SqliteAgentDatabase,
  input: {
    endedAt?: string | null;
    endsWithError?: number | null;
    id: string;
    status: string;
    updatedAt: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (
       id, status, started_at, last_activity_at, updated_at, ended_at,
       data_revision, ends_with_error
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    input.id,
    input.status,
    STARTED_AT,
    STALE_LAST_ACTIVITY_AT,
    input.updatedAt,
    input.endedAt ?? null,
    effectiveDataRevision(),
    input.endsWithError ?? null
  );
  await db.run(
    "INSERT INTO agents (id, session_id, type, name, status, started_at, updated_at, ended_at) VALUES ($1, $2, 'main', 'main', 'completed', $3, $4, $5)",
    `${input.id}-main`,
    input.id,
    STARTED_AT,
    input.updatedAt,
    input.endedAt ?? null
  );
}

async function selectSessionStatuses(
  db: SqliteAgentDatabase,
  ids: readonly string[]
): Promise<StatusRow[]> {
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
  return await db.prisma.client.$queryRawUnsafe<StatusRow[]>(
    `SELECT id, status FROM sessions WHERE id IN (${placeholders}) ORDER BY id`,
    ...ids
  );
}

async function selectAnalyticsStatuses(
  db: SqliteAgentDatabase,
  ids: readonly string[]
): Promise<AnalyticsStatusRow[]> {
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
  return await db.prisma.client.$queryRawUnsafe<AnalyticsStatusRow[]>(
    `SELECT session_id, status FROM session_analytics WHERE session_id IN (${placeholders}) ORDER BY session_id`,
    ...ids
  );
}

function findNonLifecycleStatuses(
  rows: readonly { owner: string; status: string | null }[]
): { owner: string; status: string | null }[] {
  return rows.filter(
    (row) => row.status === null || !LIFECYCLE_VALUES.has(row.status)
  );
}

function approvedBoundWriterFixtureProblems(
  observedIds: readonly string[]
): string[] {
  const problems: string[] = [];
  const fixtureWriters = Object.keys(APPROVED_BOUND_WRITE_FIXTURE_IDS).sort();
  const approvedWriters = Object.values(
    APPROVED_DESKTOP_SESSION_STATUS_BOUND_WRITES
  ).sort();
  if (fixtureWriters.join("\n") !== approvedWriters.join("\n")) {
    problems.push("approved bound writer list differs from fixture inventory");
  }
  const observed = new Set(observedIds);
  for (const [writer, fixtureIds] of Object.entries(
    APPROVED_BOUND_WRITE_FIXTURE_IDS
  )) {
    if (fixtureIds.length === 0) {
      problems.push(`${writer} has no fixture ids`);
    }
    for (const fixtureId of fixtureIds) {
      if (!observed.has(fixtureId)) {
        problems.push(`${writer} fixture ${fixtureId} was not observed`);
      }
    }
  }
  return problems;
}
