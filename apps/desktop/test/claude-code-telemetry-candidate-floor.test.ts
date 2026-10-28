/**
 * ISS-11323 — the per-session floor on the Claude Code candidate query.
 *
 * The query runs every 15 seconds forever, including once the lane has drained.
 * Before this change every union operand was `WHERE <col> GLOB <canonical form>`
 * and nothing else, and a GLOB with no literal prefix cannot use
 * `idx_claude_code_*_observed`, so the steady-state pass scanned every row of
 * every family and then built a temp b-tree over the lot.
 *
 * THE FIRST TEST IS THE IMPORTANT ONE. The reviewer's suggested fix was a floor
 * derived from `MIN(synced_observed_to)` across the cursor table, and it would
 * have stranded exactly the population this lane exists to drain: a session that
 * has never been delivered has NO cursor row, so it contributes nothing to that
 * MIN and is protected by no floor. If its rows predate the global minimum across
 * the sessions that HAVE synced, every one of its operands excludes it, it never
 * becomes a candidate, and its telemetry is lost with nothing red anywhere. The
 * case is built to fail under that mechanism and pass under the correlated one.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { createClaudeCodeTelemetrySyncStore } from "../src/main/database/claude-code-telemetry-sync-store.js";
import { CLAUDE_CODE_TELEMETRY_SESSION_ABSENT_ERROR } from "../src/main/otel/claude-code-telemetry-candidates.js";
import {
  openTestDatabase,
  SESSION_ID,
  seedSession,
} from "./helpers/claude-code-otel-fixtures.js";

const SOURCE_KEY = "claude_code_telemetry:target-1";
/** The never-delivered session's rows. OLDER than every synced watermark below. */
const ANCIENT_AT = "2024-01-02T03:04:05.000Z";
const SYNCED_AT = "2026-06-18T19:00:00.000Z";
const NEWER_AT = "2026-06-18T19:30:00.000Z";
const STRANDED_SESSION_ID = "claude-otel-never-delivered";

type Db = Awaited<ReturnType<typeof openTestDatabase>>["db"];

async function seedOtherSession(db: Db, id: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
    id,
    "2024-01-01T00:00:00.000Z"
  );
}

async function seedCostEvent(
  db: Db,
  id: string,
  sessionId: string,
  observedAt: string
): Promise<void> {
  await db.run(
    `INSERT INTO claude_code_cost_event
       (id, session_id, model, cost_usd, observed_at, attribution_key,
        attribution_source, data_revision)
     VALUES ($1, $2, 'claude-sonnet-4-5', 1.25, $3, '', 'otel', 1)`,
    id,
    sessionId,
    observedAt
  );
}

async function seedCursor(
  db: Db,
  sessionId: string,
  syncedObservedTo: string,
  options: {
    dataRevision?: number;
    lastError?: string;
    updatedAt?: string;
  } = {}
): Promise<void> {
  await db.run(
    `INSERT INTO claude_code_telemetry_sync_cursor
       (source_key, session_id, synced_observed_to, rejected_attempts,
        deferred_attempts, data_revision, last_error, updated_at)
     VALUES ($1, $2, $3, 0, 0, $4, $5, $6)`,
    SOURCE_KEY,
    sessionId,
    syncedObservedTo,
    options.dataRevision ?? effectiveDataRevision(),
    options.lastError ?? null,
    options.updatedAt ?? syncedObservedTo
  );
}

test("ISS-11323: a never-delivered session OLDER than every synced watermark is still selected", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    // Two sessions that HAVE synced, both with watermarks far newer than the
    // stranded session's only row. Their MIN(synced_observed_to) is SYNCED_AT,
    // which is what the rejected global-floor mechanism would have compared
    // against — and ANCIENT_AT is below it, so that mechanism excludes the
    // stranded session's every operand.
    await seedSession(db);
    await seedCostEvent(db, "cost-synced-1", SESSION_ID, SYNCED_AT);
    await seedCursor(db, SESSION_ID, SYNCED_AT);

    const secondSynced = "claude-otel-second-synced";
    await seedOtherSession(db, secondSynced);
    await seedCostEvent(db, "cost-synced-2", secondSynced, NEWER_AT);
    await seedCursor(db, secondSynced, NEWER_AT);

    // The session this lane exists for: old, never delivered, NO cursor row.
    await seedOtherSession(db, STRANDED_SESSION_ID);
    await seedCostEvent(db, "cost-ancient", STRANDED_SESSION_ID, ANCIENT_AT);

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const pending = await store.loadPendingSessions(SOURCE_KEY, 10);

    assert.deepEqual(
      pending.map((entry) => entry.sessionId),
      [STRANDED_SESSION_ID],
      "the never-delivered session must be the one and only candidate"
    );
    assert.equal(pending[0]?.observedTo, ANCIENT_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-11323: a session delivered past its own watermark is not selected", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedCostEvent(db, "cost-1", SESSION_ID, SYNCED_AT);
    await seedCursor(db, SESSION_ID, SYNCED_AT);

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    assert.deepEqual(await store.loadPendingSessions(SOURCE_KEY, 10), []);

    // And the floor admits it again the moment a newer row lands, with the
    // watermark naming the NEW row rather than the acknowledged one.
    await seedCostEvent(db, "cost-2", SESSION_ID, NEWER_AT);
    const owed = await store.loadPendingSessions(SOURCE_KEY, 10);
    assert.equal(owed.length, 1);
    assert.equal(owed[0]?.observedTo, NEWER_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-11323: the floor preserves the session_absent re-admission door and its cooldown", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedCostEvent(db, "cost-1", SESSION_ID, SYNCED_AT);
    // Passed for `session_absent`, watermark advanced, and the cooldown has
    // elapsed. Nothing in this session's corpus is past the watermark, so the
    // ONLY thing that can re-admit it is that arm — which now lives inside the
    // per-operand floor rather than in an outer HAVING.
    await seedCursor(db, SESSION_ID, NEWER_AT, {
      lastError: CLAUDE_CODE_TELEMETRY_SESSION_ABSENT_ERROR,
      updatedAt: "2026-06-18T00:00:00.000Z",
    });

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const owed = await store.loadPendingSessions(SOURCE_KEY, 10);
    assert.equal(owed.length, 1, "the recovery door must still open");
  } finally {
    await cleanup();
  }
});

test("ISS-11323: a session inside its session_absent cooldown is not re-admitted", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedCostEvent(db, "cost-1", SESSION_ID, SYNCED_AT);
    // Same shape as above, but the pass happened just now, so the cooldown has
    // NOT elapsed. Pinned separately because a floor that admitted on
    // `last_error` alone would pass the previous case and re-try this session on
    // every 15s tick forever.
    await seedCursor(db, SESSION_ID, NEWER_AT, {
      lastError: CLAUDE_CODE_TELEMETRY_SESSION_ABSENT_ERROR,
      updatedAt: new Date().toISOString(),
    });

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    assert.deepEqual(await store.loadPendingSessions(SOURCE_KEY, 10), []);
  } finally {
    await cleanup();
  }
});

test("ISS-11323: a NULL last_error does not defeat the floor", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedCostEvent(db, "cost-1", SESSION_ID, SYNCED_AT);
    // `last_error` NULL is the STEADY STATE, so this is the majority case rather
    // than an edge one. A bare `f.last_error = ?` against NULL yields NULL, the
    // `NOT (...)` propagates it, and the whole `NOT EXISTS` then admits every
    // row — the floor silently doing nothing on almost every session. The
    // COALESCE in the operand is what this pins.
    await seedCursor(db, SESSION_ID, SYNCED_AT, { lastError: undefined });

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    assert.deepEqual(await store.loadPendingSessions(SOURCE_KEY, 10), []);
  } finally {
    await cleanup();
  }
});

test("ISS-11323: a rejected pass is NOT re-admitted by the recovery arm", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await seedCostEvent(db, "cost-1", SESSION_ID, SYNCED_AT);
    // `payload_rejected` is attributable to the payload; repeating it would just
    // re-spend the budget. Only `session_absent` opens the door.
    await seedCursor(db, SESSION_ID, NEWER_AT, {
      lastError: "payload_rejected",
      updatedAt: "2026-06-18T00:00:00.000Z",
    });

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    assert.deepEqual(await store.loadPendingSessions(SOURCE_KEY, 10), []);
  } finally {
    await cleanup();
  }
});
