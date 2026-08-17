/**
 * @file sync-source-trace-token-isolation.test.ts
 * @description ISS-5311 — `loadSyncedSessions` hydrates a BATCH of sessions in
 * one pass, so a single corrupt persisted cache-write TTL value must not throw
 * out of the whole hydration.
 *
 * Before the per-row isolation in `mapTraceTokenEvents`, the trace mapper ran as
 * a bare `rows.map(normalizeTraceTokenEvent)`: one poisoned `token_events` row
 * rejected list/detail hydration for every VALID sibling session in the same
 * batch, and the session-metadata sync lane caught it only at the lane boundary
 * — leaving that session at the head of the lane, retried forever.
 *
 * Drives the real SQLite → `loadSyncedSessions` boundary, mirroring
 * sync-source-commit-refs.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// A negative persisted counter — nothing in the SQLite DDL rejects it (the
// column carries no CHECK), the libSQL driver round-trips it as a plain JS
// number, and the strict storage reader then rejects it. That makes it the
// corruption shape that actually REACHES this mapper: an over-safe-integer
// BIGINT never gets that far, because the driver itself RangeErrors on decode.
const CORRUPT_NEGATIVE_TOKEN = -1;

const STARTED_AT = "2026-08-05T09:00:00.000Z";
const UPDATED_AT = "2026-08-05T09:30:00.000Z";
const TOKEN_EVENT_AT = "2026-08-05T09:10:00.000Z";

type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

async function seedSession(db: DbRun, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, model, started_at, updated_at, ended_at)
     VALUES (?, 'completed', 'claude-opus-5', ?, ?, ?)`,
    sessionId,
    STARTED_AT,
    UPDATED_AT,
    UPDATED_AT
  );
}

async function seedTokenEvent(
  db: DbRun,
  sessionId: string,
  cacheWrite5mTokens: number | null
): Promise<void> {
  await db.run(
    `INSERT INTO token_events
       (session_id, transport_id, model, created_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens)
     VALUES (?, ?, 'claude-opus-5', ?, 10, 20, 30, 40, ?, 7)`,
    sessionId,
    `transport-${sessionId}`,
    TOKEN_EVENT_AT,
    cacheWrite5mTokens
  );
}

test("ISS-5311: one corrupt cache-write TTL does not reject the hydration batch — valid sibling sessions still hydrate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5311-trace-token-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => UPDATED_AT,
    });
    try {
      await seedSession(db, "s-poison");
      await seedSession(db, "s-valid");
      // The poisoned row's OTHER counts are all valid — only the optional 5m
      // subdivision is corrupt, which is precisely the field this mapper owns
      // (the four required counts are validated a call earlier by
      // mapSyncedTokenEvent, so they never reach the trace mapper corrupt).
      await seedTokenEvent(db, "s-poison", CORRUPT_NEGATIVE_TOKEN);
      await seedTokenEvent(db, "s-valid", 3);

      // Would THROW before the fix, returning nothing for either session.
      const sessions = await db.syncSource.loadSyncedSessions(
        ["s-poison", "s-valid"],
        emptyAttributionCache()
      );
      assert.equal(sessions.length, 2, "both sessions hydrated");

      const valid = sessions.find(
        (session) => session.externalSessionId === "s-valid"
      );
      assert.ok(valid, "the valid sibling session hydrated");
      assert.equal(valid.tokenEvents?.length, 1);
      assert.equal(valid.tokenEvents?.[0]?.inputTokens, 10);
      assert.equal(valid.tokenEvents?.[0]?.outputTokens, 20);
      assert.equal(valid.tokenEvents?.[0]?.cacheReadTokens, 30);
      assert.equal(valid.tokenEvents?.[0]?.cacheWriteTokens, 40);
      assert.ok(
        valid.activityBuckets && valid.activityBuckets.length > 0,
        "the valid sibling's trace was assembled, not skipped"
      );

      // The poisoned session degrades rather than disappearing: its valid
      // counts survive and its trace is still assembled.
      const poisoned = sessions.find(
        (session) => session.externalSessionId === "s-poison"
      );
      assert.ok(poisoned, "the poisoned session still hydrated");
      assert.equal(poisoned.tokenEvents?.length, 1);
      assert.equal(poisoned.tokenEvents?.[0]?.inputTokens, 10);
      assert.equal(poisoned.tokenEvents?.[0]?.cacheWriteTokens, 40);
      assert.ok(
        poisoned.activityBuckets && poisoned.activityBuckets.length > 0,
        "the poisoned session's trace was assembled, not skipped"
      );
      // Degrading the 5m subdivision to `null` does not perturb the priced
      // trace cost: only the 1h tier feeds the FEA-3419 fallback pricing, and
      // both rows carry the same valid 1h value.
      assert.deepEqual(
        poisoned.activityBuckets[0]?.byModel,
        valid.activityBuckets[0]?.byModel,
        "the degraded row still prices exactly like its valid twin"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
