/**
 * @file import-zero-model-token-usage-preservation.test.ts
 * @description ISS-7736: a re-parse that yields ZERO models must not wipe the
 * `token_usage` rows a previous good parse wrote.
 *
 * `importPhaseTokenUsage` replaces the JSONL-parser-sourced rows wholesale —
 * `DELETE FROM token_usage WHERE session_id = ? AND usage_source = ?`, then
 * reinsert from `tokensByModel`. That is deliberate (FEA-1459, PR #1511 review):
 * the boot importer derives full totals from the entire transcript every run, so
 * a new derivation is authoritative, and overwrite-by-model alone would strand a
 * stale row when a model key disappears under a new parser.
 *
 * The gap was the EMPTY derivation. With no `length > 0` guard the delete landed
 * and nothing was written back, so a zero-model re-parse read as "the
 * authoritative answer is nothing" rather than "the parse produced nothing
 * usable". The cloud ingest path already preserves on an empty payload, so the
 * two surfaces disagreed about the same session and desktop was the wrong one.
 *
 * BOTH halves are here on purpose, and either alone is a false green:
 *   - the zero-model case is satisfied by code that simply never deletes;
 *   - the non-empty case is satisfied by the unguarded pre-fix code.
 * Only the pair pins "preserve on empty, still replace wholesale on non-empty".
 *
 * Driven through the REAL ingest path (`db.importer.importSession`) against a
 * live SQLite store, so the guard is exercised inside the real transaction
 * rather than against a re-implementation.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { runTokenParityCheck } from "../src/main/database/token-parity.js";
import { CodexOtelTokenUsageSource } from "../src/main/otel/codex-otel-contract.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-22T12:00:00.000Z";
const STARTED_AT = "2026-08-01T12:00:00.000Z";
const ASSISTANT_TS = "2026-08-01T12:03:00.000Z";
const ENDED_AT = "2026-08-01T12:05:30.000Z";
/** Well before NOW so the fixture reads as a finished import, not a live run. */
const OLD_FILE_MTIME_MS = Date.parse("2026-08-01T12:00:00.000Z");

const OPUS = "claude-opus-4-5";
const SONNET = "claude-sonnet-4-5";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/** One model's counts as the parser reports them. */
type ModelCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** A `token_usage` row reduced to the columns these cases grade. */
type UsageRow = { model: string; input: number; output: number };

async function openDb(dir: string): Promise<Db> {
  return await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

/**
 * The same session, re-parsed with a different model map — the re-import the
 * boot importer performs on every run. `tokensByModel` is the ONLY thing that
 * varies between calls, so a surviving row can only be attributed to the guard.
 */
function reparse(
  sessionId: string,
  tokensByModel: Record<string, ModelCounts>
): NormalizedSession {
  return makeSession({
    sessionId,
    cwd: "/sandbox/project",
    model: OPUS,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    fileModifiedAt: OLD_FILE_MTIME_MS,
    userMessages: 1,
    assistantMessages: 1,
    messages: [{ role: "assistant", timestamp: ASSISTANT_TS, text: "hello" }],
    tokensByModel,
  });
}

/** The parser-sourced rows for a session, ordered so assertions are stable. */
async function readParserUsage(db: Db, sessionId: string): Promise<UsageRow[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ model: string; input_tokens: bigint; output_tokens: bigint }>
  >(
    "SELECT model, input_tokens, output_tokens FROM token_usage WHERE session_id = $1 AND usage_source = $2 ORDER BY model",
    sessionId,
    CodexOtelTokenUsageSource.JsonlParser
  );
  return rows.map((row) => ({
    model: row.model,
    input: Number(row.input_tokens),
    output: Number(row.output_tokens),
  }));
}

test("a zero-model re-parse preserves the token_usage rows a previous parse wrote (ISS-7736)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7736-zero-model-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-zero-model-reparse";

    const first = await db.importer.importSession(
      reparse(sessionId, {
        [OPUS]: { input: 1000, output: 500, cacheRead: 10, cacheWrite: 5 },
      }),
      "claude"
    );
    assert.notEqual(first.failed, true);

    // Precondition, not decoration: without rows to lose, the survival
    // assertion below would hold on a session that never had any.
    const seeded = await readParserUsage(db, sessionId);
    assert.deepEqual(
      seeded,
      [{ model: OPUS, input: 1000, output: 500 }],
      "the first import wrote no parser-sourced usage, so this case cannot prove preservation"
    );

    // The defect: the same transcript re-parsed to nothing usable. Pre-fix the
    // unconditional DELETE landed and the reinsert loop had nothing to write.
    const second = await db.importer.importSession(
      reparse(sessionId, {}),
      "claude"
    );
    assert.notEqual(second.failed, true);

    assert.deepEqual(
      await readParserUsage(db, sessionId),
      seeded,
      "a zero-model re-parse wiped the session's token_usage — desktop now reports 0 tokens where the cloud still holds the real totals"
    );
    // Preserving token_usage while the SIBLING phase still emptied token_events
    // would trade the old wipe for a new divergence: the two stores would
    // disagree for this session and `runTokenParityCheck` — the monitored store
    // invariant — would start raising `token_store_divergence`. The empty-parse
    // rule has to hold for both phases, so it is graded through the real check.
    assert.equal(
      (await runTokenParityCheck(db.prisma)).divergentSessionCount,
      0,
      "token_usage was preserved but token_events was not — the two token stores now disagree about this session"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-empty re-parse still replaces wholesale, so a disappeared model leaves no stale row (FEA-1459 preserved)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7736-replacement-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-model-key-disappears";

    const first = await db.importer.importSession(
      reparse(sessionId, {
        [OPUS]: { input: 1000, output: 500, cacheRead: 10, cacheWrite: 5 },
        [SONNET]: { input: 200, output: 100, cacheRead: 2, cacheWrite: 1 },
      }),
      "claude"
    );
    assert.notEqual(first.failed, true);
    assert.deepEqual(
      (await readParserUsage(db, sessionId)).map((row) => row.model),
      [OPUS, SONNET],
      "the two-model seed did not land, so a disappearing key cannot be observed"
    );

    // A DIFFERENT non-empty set: Opus is gone and Sonnet's counts moved. The
    // guard must not narrow this into an overwrite-by-model, which would strand
    // the Opus row — the exact regression FEA-1459's delete exists to prevent.
    const second = await db.importer.importSession(
      reparse(sessionId, {
        [SONNET]: { input: 777, output: 333, cacheRead: 3, cacheWrite: 2 },
      }),
      "claude"
    );
    assert.notEqual(second.failed, true);

    assert.deepEqual(
      await readParserUsage(db, sessionId),
      [{ model: SONNET, input: 777, output: 333 }],
      "the re-parse did not replace wholesale: the disappeared model key left a stale row behind"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The SECOND caller of the same teardown, found by review.
 *
 * `runRebuildSessionTransaction` used to issue its OWN raw
 * `DELETE FROM token_usage ... usage_source = 'jsonl_parser'` before calling
 * `importSessionWithTx`. The predicate was byte-identical to the import phase's,
 * so it was redundant on a non-empty re-parse — and on an EMPTY one it ran ahead
 * of the guard and defeated it: the rows went, the guarded reinsert correctly
 * wrote nothing back, and the wipe happened anyway. Removing it makes
 * `importPhaseTokenUsage` the single owner, which is the rule that file already
 * applies to `events` and `session_artifact_links`.
 *
 * This path is worse than the ordinary one, which is why it gets its own case:
 * the rebuild is gated to TERMINAL sessions, and those do not cycle back through
 * ordinary reimport — so a wipe here waits for the next DATA_REVISION bump
 * instead of healing on the next boot sweep.
 */
test("a zero-model DATA_REVISION rebuild preserves token_usage, and its baseline ledger with it (ISS-7736)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7736-rebuild-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-zero-model-rebuild";
    const seededImport = await db.importer.importSession(
      reparse(sessionId, {
        [OPUS]: { input: 1000, output: 500, cacheRead: 10, cacheWrite: 5 },
      }),
      "claude"
    );
    assert.notEqual(seededImport.failed, true);

    // The compaction ledger (ISS-4606) rides across the rebuild on a
    // read-before-delete seed. It is asserted here because it is the collateral
    // damage: once the row is gone, the restoring UPDATE matches zero rows and
    // the ledger is lost too, silently.
    await db.prisma.write((tx) =>
      tx.$executeRawUnsafe(
        "UPDATE token_usage SET baseline_input = 9999 WHERE session_id = $1 AND model = $2",
        sessionId,
        OPUS
      )
    );
    assert.deepEqual(
      await readParserUsage(db, sessionId),
      [{ model: OPUS, input: 1000, output: 500 }],
      "precondition: the rebuild has nothing to preserve unless the seed landed"
    );

    // A TERMINAL session on a stale data_revision is what the rebuild claims.
    await db.run(
      "UPDATE sessions SET data_revision = 1, status = 'inactive' WHERE id = $1",
      sessionId
    );
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${sessionId}.jsonl`],
          // The re-parse yields NOTHING usable — the defect's trigger.
          parse: () => Promise.resolve([reparse(sessionId, {})]),
          sessionIdForSource: () => sessionId,
        }),
      ],
      db,
    });
    assert.equal(result.rebuilt, 1, "precondition: the session was rebuilt");

    assert.deepEqual(
      await readParserUsage(db, sessionId),
      [{ model: OPUS, input: 1000, output: 500 }],
      "a zero-model rebuild wiped token_usage — the guard in importPhaseTokenUsage was defeated by a raw DELETE running ahead of it"
    );
    const baselines = await db.prisma.client.$queryRawUnsafe<
      Array<{ baseline_input: bigint }>
    >(
      "SELECT baseline_input FROM token_usage WHERE session_id = $1 AND model = $2",
      sessionId,
      OPUS
    );
    assert.equal(
      Number(baselines[0]?.baseline_input),
      9999,
      "the compaction ledger did not survive the zero-model rebuild"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
