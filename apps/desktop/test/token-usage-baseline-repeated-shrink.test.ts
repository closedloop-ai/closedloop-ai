/**
 * ISS-7515: does `baseline_*` COMPOUND across repeated shrinks?
 *
 * The sibling `token-usage-compaction-baseline.test.ts` covers every READ site
 * that folds `baseline_* + current`, but every one of its fixtures hand-INSERTs
 * a row with the baseline already populated. Not one of them executes the
 * accumulating `ON CONFLICT ... SET baseline_x = token_usage.baseline_x +
 * EXCLUDED.baseline_x` in `read-stores.ts` — so the arithmetic that ISS-7515
 * suspected of inflating a $5,994.85 figure had no coverage at all, and a
 * single-shrink fixture could not observe compounding even if it had.
 *
 * These drive the PRODUCTION `tokenUsage.replace` path repeatedly and pin what
 * the accumulation actually does, so a future edit to that SQL cannot silently
 * change the effective total. The empirical verdict recorded against the real
 * desktop store (2,973 `token_usage` rows, ZERO carrying a non-zero baseline,
 * including the 8.26B-token / $6,229.94 session) is in the ticket; these tests
 * are the mechanism half of that answer.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-08-22T12:00:00.000Z";
const SESSION = "sess-repeated-shrink";
const MODEL = "claude-opus-4-5";

/**
 * A transcript re-derivation, as one number per counter. Written as literals in
 * each test rather than computed, so an expectation can never be re-derived from
 * the accumulation it is policing.
 */
type Derivation = { input: number; output: number };

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7515-shrink-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

async function insertSession(db: SqliteDb): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    SESSION,
    "completed",
    "claude_code",
    "2026-08-20T08:00:00.000Z",
    NOW
  );
}

/** Drive the production upsert with one whole-transcript re-derivation. */
async function derive(db: SqliteDb, counts: Derivation): Promise<void> {
  await db.tokenUsage.replace(
    SESSION,
    MODEL,
    { input: counts.input, output: counts.output, cacheRead: 0, cacheWrite: 0 },
    NOW
  );
}

type StoredRow = {
  input: number;
  baselineInput: number;
  output: number;
  baselineOutput: number;
};

async function readRow(db: SqliteDb): Promise<StoredRow> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      input_tokens: bigint | number;
      baseline_input: bigint | number;
      output_tokens: bigint | number;
      baseline_output: bigint | number;
    }[]
  >(
    `SELECT input_tokens, baseline_input, output_tokens, baseline_output
       FROM token_usage WHERE session_id = $1 AND model = $2`,
    SESSION,
    MODEL
  );
  const row = rows[0];
  if (!row) {
    throw new Error("expected a token_usage row for the driven session/model");
  }
  return {
    input: Number(row.input_tokens),
    baselineInput: Number(row.baseline_input),
    output: Number(row.output_tokens),
    baselineOutput: Number(row.baseline_output),
  };
}

/**
 * A monotonically GROWING transcript — the ordinary case — must never roll a
 * baseline. The positive sibling of every compounding assertion below: if the
 * accumulation fired on growth, every long session would inflate, and the
 * shrink-only tests could still pass.
 */
test("ISS-7515: a growing transcript never accumulates a baseline", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db);
    await derive(db, { input: 100, output: 10 });
    await derive(db, { input: 150, output: 20 });
    await derive(db, { input: 220, output: 33 });

    const row = await readRow(db);
    assert.equal(row.input, 220);
    assert.equal(row.output, 33);
    // Literals, not `0` derived from anything: the effective total is exactly
    // the latest derivation because nothing was ever rolled out of the window.
    assert.equal(row.baselineInput, 0);
    assert.equal(row.baselineOutput, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * FOUR shrinks, each followed by growth — the one-way compaction sequence the
 * mechanism was built for, repeated. This is the case a single-shrink fixture
 * cannot see: if the accumulation compounded on ordinary compaction, the
 * effective total here would exceed the sum of the post-compaction segments.
 *
 * Expected effective input, written out by hand:
 *   100                                        (first derivation)
 *   compact to 20  → baseline 100, effective 120
 *   grow to 45     → baseline 100, effective 145
 *   compact to 7   → baseline 145, effective 152
 *   grow to 30     → baseline 145, effective 175
 *   compact to 4   → baseline 175, effective 179
 *   grow to 12     → baseline 175, effective 187
 *   compact to 3   → baseline 187, effective 190
 *
 * Output runs 10, 2, 5, 1, 4, 1, 3, 1 through the same rule and lands on
 * baseline 22, current 1, effective 23.
 */
test("ISS-7515: four compaction cycles accumulate the baseline exactly once each", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db);
    const sequence: Derivation[] = [
      { input: 100, output: 10 },
      { input: 20, output: 2 },
      { input: 45, output: 5 },
      { input: 7, output: 1 },
      { input: 30, output: 4 },
      { input: 4, output: 1 },
      { input: 12, output: 3 },
      { input: 3, output: 1 },
    ];
    for (const step of sequence) {
      await derive(db, step);
    }

    const row = await readRow(db);
    assert.equal(row.input, 3);
    assert.equal(row.baselineInput, 187);
    assert.equal(row.input + row.baselineInput, 190);
    // Not the runaway a compounding accumulation would produce: rolling the
    // WHOLE pre-shrink current on top of an already-rolled baseline would have
    // put the effective input well past 190.
    assert.ok(
      row.input + row.baselineInput <= 190,
      `effective input compounded to ${row.input + row.baselineInput}, expected 190`
    );
    assert.equal(row.output, 1);
    assert.equal(row.baselineOutput, 22);
    assert.equal(row.output + row.baselineOutput, 23);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The SAME lower derivation written repeatedly must roll exactly once. This is
 * the shape a re-import, a retried sync, or a duplicated hook produces, and it
 * is the compounding the ticket suspected: if the roll were not conditioned on a
 * strict decrease, each repeat would add the pre-shrink total again.
 */
test("ISS-7515: re-writing the same post-compaction totals is idempotent", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db);
    await derive(db, { input: 100, output: 10 });
    await derive(db, { input: 20, output: 2 });
    const afterFirstShrink = await readRow(db);
    assert.equal(afterFirstShrink.baselineInput, 100);

    // Five more identical re-derivations — a retry storm.
    for (let i = 0; i < 5; i += 1) {
      await derive(db, { input: 20, output: 2 });
    }

    const row = await readRow(db);
    assert.equal(row.input, 20);
    // Still 100, NOT 600: the roll is gated on a strict decrease, so a repeat of
    // an already-absorbed value adds nothing.
    assert.equal(row.baselineInput, 100);
    assert.equal(row.baselineOutput, 10);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The one shape that DOES compound, pinned deliberately.
 *
 * If two writers disagree about the same (session, model) — one deriving 100 and
 * the other 30 from the same transcript — every 100→30 transition rolls the full
 * 100 into the baseline while the next 100 is read as fresh growth, so the
 * effective total climbs by 100 per cycle without bound. Nothing distinguishes
 * that from a genuine compaction at the value level.
 *
 * This is a latent hazard, not an observed defect: across 2,973 `token_usage`
 * rows in the real desktop store, not one carries a non-zero baseline, so no
 * shrink — let alone an oscillation — has ever occurred there. The test exists
 * so the cost of the current semantics is written down and measured rather than
 * rediscovered, and so a future guard against it fails HERE first.
 */
test("ISS-7515: an oscillating derivation compounds by the full pre-shrink total each cycle", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db);
    await derive(db, { input: 100, output: 10 });

    // Three full 100 → 30 → 100 oscillations.
    for (let i = 0; i < 3; i += 1) {
      await derive(db, { input: 30, output: 3 });
      await derive(db, { input: 100, output: 10 });
    }

    const row = await readRow(db);
    assert.equal(row.input, 100);
    // 100 rolled in on each of the three down-swings.
    assert.equal(row.baselineInput, 300);
    assert.equal(row.input + row.baselineInput, 400);
    // The transcript never held more than 100 input tokens at any instant, so
    // 400 is four times the largest state that ever existed. Pinned as the
    // measured cost of the current accumulation, not as desired behavior.
    assert.notEqual(row.input + row.baselineInput, 100);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A zeroed re-derivation is dropped before the upsert (`replace` returns early
 * when all four counters are 0), so it can neither clear the current totals nor
 * roll them into the baseline. Without that early return an empty parse would
 * read as the largest possible shrink and roll the entire session into the
 * baseline — then the next real derivation would stack on top of it.
 */
test("ISS-7515: an all-zero re-derivation neither clears nor rolls the stored totals", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db);
    await derive(db, { input: 100, output: 10 });
    await derive(db, { input: 0, output: 0 });

    const row = await readRow(db);
    assert.equal(row.input, 100);
    assert.equal(row.output, 10);
    assert.equal(row.baselineInput, 0);
    assert.equal(row.baselineOutput, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
