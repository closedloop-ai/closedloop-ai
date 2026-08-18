/**
 * @file token-parity-corruption-monitored.test.ts
 * @description ISS-5342 — a token total that cannot be right must reach the
 * MONITORED store-integrity path, not be swallowed.
 *
 * Neither `token_usage` nor `token_events` declares a nonnegative CHECK on its
 * `BIGINT` token columns, so a negative total is something the REAL parity query
 * returns against a corrupt store — not only something a version-skewed db host
 * could fabricate. When the wire schema rejected such a value, the throw landed
 * in `runOptionalCheck`'s transport-failure catch, which logs locally and
 * returns BEFORE appending to `checksRun` or `issues`; the run then reported
 * `healthy: true` and `Observability.storeIntegrityResult` published nothing at
 * all about a store whose token data was demonstrably corrupt.
 *
 * These tests run against a REAL libSQL store opened through
 * `openSqliteAgentDatabase` and drive the PRODUCTION wiring
 * (`createWiredStoreIntegrityProbe`), so they prove the parity check is actually
 * injected and that a genuinely-corrupt store is what produces the issue — a
 * mocked reader could assert the classifier and still leave the query, the
 * schema, and the injection unproven. The emit cadence downstream of `runOnce`
 * is generic to every check and is covered by
 * `wal-probe-health-monitored.test.ts`; nothing here depends on a timer.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createWiredStoreIntegrityProbe } from "../src/main/database/store-integrity-wiring.js";
import type {
  StoreIntegrityDiagnostics,
  StoreIntegrityIssue,
} from "../src/main/telemetry/telemetry-protocol.js";

const NOW = "2026-06-22T00:00:00.000Z";
const T1 = "2026-06-20T10:00:00.000Z";
const MODEL = "claude-sonnet-4-5";

type OpenStore = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function openStore(prefix: string): Promise<{
  db: OpenStore;
  runOnce: () => Promise<StoreIntegrityDiagnostics>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  const probe = createWiredStoreIntegrityProbe({
    agentDatabase: db,
    emit: () => {
      /* the cadence is not what these tests measure — see the file header */
    },
    getIngestProgress: () => ({ preparing: false, total: 0, processed: 0 }),
    log: () => {
      /* the swallowed-failure log line is the bug, not the contract */
    },
  });
  return {
    db,
    runOnce: () => probe.runOnce(),
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Seed one session plus a matching `token_usage`/`token_events` pair, so the
 *  store starts in the state the parity check calls clean. */
async function seedAgreeingPair(
  db: OpenStore,
  sessionId: string,
  input: number
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
     VALUES ($1, $2, $3, $4, $4, $5)`,
    sessionId,
    sessionId,
    "completed",
    T1,
    "claude"
  );
  await db.run(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1, $2, $3, 0, 0, 0)`,
    sessionId,
    MODEL,
    input
  );
  await db.run(
    `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1, $2, $3, $4, 0, 0, 0)`,
    sessionId,
    MODEL,
    T1,
    input
  );
}

function parityIssues(diag: StoreIntegrityDiagnostics): StoreIntegrityIssue[] {
  return diag.issues.filter((issue) => issue.check === "token_parity");
}

test("ISS-5342: a negative token total in the real store is reported, not swallowed", async () => {
  const store = await openStore("token-parity-negative-");
  try {
    await seedAgreeingPair(store.db, "s-ok", 300);

    const clean = await store.runOnce();
    assert.ok(
      clean.checksRun.includes("token_parity"),
      "the parity check runs against a healthy store"
    );
    assert.deepEqual(parityIssues(clean), []);

    // A collector writes a negative count to BOTH stores for the same
    // (session_id, model). The two sides still agree exactly, so divergence is
    // NOT what is wrong here — the totals themselves are impossible, and before
    // this fix that fact was the one the probe threw away.
    await seedAgreeingPair(store.db, "s-negative", -500);

    const corrupt = await store.runOnce();

    assert.equal(corrupt.healthy, false);
    assert.ok(
      corrupt.checksRun.includes("token_parity"),
      "the check is recorded as RUN — the corruption came from it, not instead of it"
    );
    assert.deepEqual(parityIssues(corrupt), [
      {
        check: "token_parity",
        category: "token_total_out_of_range",
        object: "usage_input_tokens",
        objectType: "unknown",
      },
      {
        check: "token_parity",
        category: "token_total_out_of_range",
        object: "events_input_tokens",
        objectType: "unknown",
      },
    ]);
  } finally {
    await store.cleanup();
  }
});

test("ISS-5342: a one-sided negative total is corruption, not a store divergence", async () => {
  const store = await openStore("token-parity-one-sided-");
  try {
    await seedAgreeingPair(store.db, "s-ok", 300);
    await store.db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s-usage-only",
      "Usage only",
      "completed",
      T1,
      "claude"
    );
    // token_usage alone carries the negative row, so `usageInput` (-200) both is
    // impossible AND disagrees with `eventsInput` (300).
    await store.db.run(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, $2, -500, 0, 0, 0)`,
      "s-usage-only",
      MODEL
    );

    const diag = await store.runOnce();

    assert.equal(diag.healthy, false);
    assert.ok(diag.checksRun.includes("token_parity"));
    const issues = parityIssues(diag);
    assert.deepEqual(
      issues.filter((issue) => issue.category === "token_total_out_of_range"),
      [
        {
          check: "token_parity",
          category: "token_total_out_of_range",
          object: "usage_input_tokens",
          objectType: "unknown",
        },
      ]
    );
    // The `input_tokens` comparison is suppressed: one operand is corrupt, so
    // "the stores disagree on input_tokens" would name the wrong root cause and
    // count one fault twice.
    assert.equal(
      issues.some(
        (issue) =>
          issue.category === "token_store_divergence" &&
          issue.object === "input_tokens"
      ),
      false
    );
    // The per-(session_id, model) tally is a separate, still-usable signal: the
    // pair exists in token_usage and not in token_events, which really is a
    // divergence and is still reported.
    assert.ok(
      issues.some(
        (issue) =>
          issue.category === "token_store_divergence" &&
          issue.object === "token_events"
      )
    );
  } finally {
    await store.cleanup();
  }
});
