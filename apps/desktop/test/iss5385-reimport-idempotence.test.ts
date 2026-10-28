import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession as makeSession } from "./normalized-session-test-utils.js";

/**
 * ISS-5385 / PLN-1771 — re-import idempotence, and the vestigial `baseline_*`.
 *
 * Named for ISS-5385 rather than the ISS-7357 golden intake this was written
 * while investigating: that ticket is BLOCKED and no longer the subject, and
 * ISS-7416 now owns the truncation half of what this file documents.
 *
 * Harness transcripts are append-only logs, and the importer is built to
 * re-derive a session's full totals from one on every run. That pairing is the
 * contract this file guards: **re-importing the same transcript must produce
 * the same rows** — never doubled, never shrunk. `write-core.ts`'s
 * delete-then-reinsert (`:846` for `token_usage`, `:882` for `token_events`) is
 * what implements it.
 *
 * These tests document a mechanism that contradicts that design.
 * `token_usage.baseline_*` exists to preserve a prior total when a re-parse
 * yields LOWER counts. Two facts about it, both measured here:
 *
 *   1. It cannot fire on any disk-import path. `replace()` reads the prior row
 *      to compute the baseline (`read-stores.ts:688`), but the importer deleted
 *      that row one statement earlier in the same transaction, so all four
 *      baselines resolve to 0. Driving the identical input through `replace()`
 *      WITHOUT the delete does set them — so the logic is correct and the
 *      delete is what makes it unreachable.
 *   2. Its stated trigger does not occur. A Claude compaction rewrites the
 *      CONTEXT WINDOW, not the file: `3df70da3` retains 1,919 records from
 *      before its first compaction and all four `compactMetadata` records
 *      across four days, and the parser has no compaction-aware skip. So a
 *      re-parse after a compaction yields more, never less.
 *
 * The one shape that does produce smaller totals is named by the codebase
 * itself — `attribution-pr1511-fixes.test.ts:306`, "re-import with SMALLER
 * totals (dedup upgrade)" — a one-time parser upgrade, not an ongoing
 * condition. Whether any harness produces a shrinking re-parse in normal
 * operation is PLN-1771 S1's question; nothing here asserts that it does.
 */

/** SQLite returns these columns as BigInt; the reader coerces once. */
type RawBaselineRow = {
  input_tokens: bigint | number;
  output_tokens: bigint | number;
  baseline_input: bigint | number;
  baseline_output: bigint | number;
};

type BaselineRow = {
  input_tokens: number;
  output_tokens: number;
  baseline_input: number;
  baseline_output: number;
};

const MODEL = "claude-sonnet-4-5";

async function readUsageRow(
  db: SqliteAgentDatabase,
  sessionId: string
): Promise<BaselineRow> {
  const rows = await db.prisma.client.$queryRawUnsafe<RawBaselineRow[]>(
    `SELECT input_tokens, output_tokens, baseline_input, baseline_output
       FROM token_usage WHERE session_id = $1 AND model = $2`,
    sessionId,
    MODEL
  );
  if (rows.length !== 1) {
    // A fixture problem, not a failed expectation — every assertion below reads
    // this row, and a missing one would silently coerce to NaN.
    throw new Error(`expected exactly one token_usage row, got ${rows.length}`);
  }
  const row = rows[0];
  return {
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    baseline_input: Number(row.baseline_input),
    baseline_output: Number(row.baseline_output),
  };
}

function sessionWith(sessionId: string, input: number, output: number) {
  return makeSession({
    sessionId,
    tokensByModel: {
      [MODEL]: { input, output, cacheRead: 0, cacheWrite: 0 },
    },
  });
}

test("importer: a shrinking re-import leaves baseline_* at 0 — the delete-then-read defect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5385-baseline-"));
  const db = await openTestDb(dir);

  try {
    // Pre-compaction: the session's full lifetime so far.
    await db.importer.importSession(
      sessionWith("compaction-1", 1_000_000, 40_000),
      "claude"
    );
    const before = await readUsageRow(db, "compaction-1");
    assert.equal(before.input_tokens, 1_000_000);
    assert.equal(
      before.baseline_input,
      0,
      "nothing to preserve on a first import"
    );

    // A re-derivation yielding a much SMALLER total. This is the exact input
    // `baseline_*` exists to catch. It is synthetic: no append-only transcript
    // produces it (see the file docstring), so this pins the mechanism, not a
    // scenario the product reaches today.
    await db.importer.importSession(
      sessionWith("compaction-1", 25_000, 900),
      "claude"
    );
    const after = await readUsageRow(db, "compaction-1");

    assert.equal(
      after.input_tokens,
      25_000,
      "current holds the post-compaction total"
    );
    assert.equal(after.output_tokens, 900);

    // The load-bearing assertion. `effective_total = baseline + current` can
    // only preserve the lifetime figure if the pre-compaction total was rolled
    // into baseline_input here.
    assert.equal(
      after.baseline_input,
      0,
      "OBSERVED: the pre-compaction total is NOT preserved — baseline_input stays 0"
    );
    assert.equal(after.baseline_output, 0);

    // The consequence, stated so a failure reads as the lost capability rather
    // than a number mismatch.
    const effectiveInput = after.baseline_input + after.input_tokens;
    assert.equal(
      effectiveInput,
      25_000,
      "effective_total = baseline + current reports the remainder, not the lifetime"
    );
    assert.notEqual(
      effectiveInput,
      1_000_000,
      "the lifetime total the invariant promises is not recoverable"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("importer: a GROWING re-import is unaffected either way", async () => {
  // The negative control. A normal append-only re-import must not set a
  // baseline, so a failure in the test above cannot be dismissed as "the
  // baseline is never set by anything".
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5385-baseline-grow-"));
  const db = await openTestDb(dir);

  try {
    await db.importer.importSession(
      sessionWith("grow-1", 10_000, 500),
      "claude"
    );
    await db.importer.importSession(
      sessionWith("grow-1", 30_000, 1500),
      "claude"
    );
    const row = await readUsageRow(db, "grow-1");

    assert.equal(row.input_tokens, 30_000);
    assert.equal(
      row.baseline_input,
      0,
      "a growing re-import correctly sets no baseline"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the mechanism WORKS when reached: the same shrink, without the importer's delete", async () => {
  // The diagnosis. The two tests above both read 0, so on their own they cannot
  // separate "the baseline never fires" from "the baseline is broken". This
  // drives `tokenUsage.replace` directly — the shape the live-hook caller uses
  // (`live-hook.ts:500`), which has no preceding DELETE — with the identical
  // shrinking input.
  //
  // It fires. So the logic is correct, and `write-core.ts:846` is what makes it
  // unreachable from an import. Note this is not a bug in the delete: the
  // delete is what makes re-import idempotent (tests 1 and 2). The two were
  // designed against different assumptions and the delete's is the right one.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5385-baseline-direct-"));
  const db = await openTestDb(dir);

  try {
    const at = "2026-06-07T12:00:00.000Z";
    await db.tokenUsage.replace(
      "direct-1",
      MODEL,
      { input: 1_000_000, output: 40_000, cacheRead: 0, cacheWrite: 0 },
      at
    );
    await db.tokenUsage.replace(
      "direct-1",
      MODEL,
      { input: 25_000, output: 900, cacheRead: 0, cacheWrite: 0 },
      at
    );
    const row = await readUsageRow(db, "direct-1");

    assert.equal(
      row.input_tokens,
      25_000,
      "current still holds the post-compaction total"
    );
    assert.equal(
      row.baseline_input,
      1_000_000,
      "the pre-compaction total IS rolled into baseline when replace can read the prior row"
    );
    assert.equal(row.baseline_output, 40_000);
    assert.equal(
      row.baseline_input + row.input_tokens,
      1_025_000,
      "effective_total recovers the lifetime figure on this path"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("token_events is replaced wholesale per import, not accumulated across imports", async () => {
  // `token_events` is append-only WITHIN an import and wholesale-replaced
  // ACROSS imports: `write-core.ts:882` calls `replaceTokenEvents`, whose first
  // statement is `DELETE FROM token_events WHERE session_id = $1`.
  //
  // That is correct for an append-only source — it is what keeps a re-import
  // idempotent rather than doubling every row. It is pinned here because it
  // means the event log does not independently retain anything the current
  // transcript has dropped, so S3 must not assume that moving the source of
  // truth to events would by itself preserve a total the transcript lost.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5385-events-"));
  const db = await openTestDb(dir);

  const seriesEntry = (minute: number, input: number) => ({
    timestamp: `2026-06-07T10:${String(minute).padStart(2, "0")}:00.000Z`,
    model: MODEL,
    input,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
  });

  const countEvents = async (sessionId: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { n: bigint | number }[]
    >(
      "SELECT COUNT(*) AS n FROM token_events WHERE session_id = $1",
      sessionId
    );
    return Number(rows[0]?.n ?? 0);
  };

  try {
    // Pre-compaction: five requests recorded.
    await db.importer.importSession(
      makeSession({
        sessionId: "events-1",
        tokensByModel: {
          [MODEL]: { input: 5000, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
        tokenSeries: [1, 2, 3, 4, 5].map((m) => seriesEntry(m, 1000)),
      }),
      "claude"
    );
    assert.equal(
      await countEvents("events-1"),
      5,
      "five per-request rows land"
    );

    // Post-compaction: the transcript now only carries the last request, so a
    // full re-derivation produces one series entry.
    await db.importer.importSession(
      makeSession({
        sessionId: "events-1",
        tokensByModel: {
          [MODEL]: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
        },
        tokenSeries: [seriesEntry(5, 1000)],
      }),
      "claude"
    );

    assert.equal(
      await countEvents("events-1"),
      1,
      "the row set mirrors the current parse exactly — not 6, and not 5 retained"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
