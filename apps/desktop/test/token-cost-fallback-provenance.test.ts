/**
 * @file token-cost-fallback-provenance.test.ts
 * @description ISS-7762: a cost priced from `UNKNOWN_MODEL_FALLBACK_TIER` must
 * NOT persist as `genai_prices_v1`.
 *
 * When genai-prices has no entry for a model id, `computeHarnessCost` recovers a
 * price from a hardcoded Opus-standard tier (FEA-3546) — deliberately, so a
 * heavily-used session on a newer-than-the-table model is never reported as
 * $0/null. Its own docstring calls that tier "a parity floor, not a verified
 * rate". The arithmetic is exact; the RATE is a guess. Before this fix the flag
 * saying so was dropped in `estimateTokenCost` and every row was stamped
 * `genai_prices_v1`, claiming the library had confirmed a rate it had never
 * heard of. On the live desktop store that was 99.968% of one session's
 * $6,229.94.
 *
 * The oracle here is deliberately NOT a constant copied out of the code under
 * test: each case first asks the PURE library engine (`computeTokenCost`, which
 * has no fallback layer) whether it can price the model, and only then asserts
 * what the writer stamped. So the premise "this model really is / is not in the
 * pinned table" is re-established by an independent engine on every run rather
 * than assumed — if a genai-prices bump ever teaches the library one of these
 * ids, the premise assertion fails loudly instead of the test passing for the
 * wrong reason.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeTokenCost } from "@repo/cost/genai-cost";
import { test } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import { startBootMaintenance } from "../src/main/database/boot-maintenance.js";
import { healFallbackCostSourceStamps } from "../src/main/database/cost-source-provenance-heal.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { repriceUnpricedTokenUsage } from "../src/main/database/token-cost-maintenance.js";
import { updateTokenUsageCost } from "../src/main/database/token-cost-writes.js";
import { ModelPricingSource } from "../src/main/model-pricing/model-pricing-fixture.js";
import { makeSession } from "./normalized-session-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const DB_NOW = "2026-06-21T12:00:00.000Z";

/**
 * A model id genai-prices cannot price. Synthetic on purpose: the real-world
 * trigger is whichever Anthropic/OpenAI id is newer than the pinned table
 * (`claude-opus-5` today), and pinning the test to a real id would turn a
 * routine price-table bump into a red suite.
 */
const UNPRICED_MODEL = "synthetic-unpriced-model-x1";

/** A second unpriceable id, so the per-model loop is driven past one model. */
const UNPRICED_MODEL_2 = "synthetic-unpriced-model-x2";

/** A model id the pinned table DOES carry — the positive sibling. */
const LIBRARY_PRICED_MODEL = "claude-haiku-4-5-20251001";

const COUNTS = {
  input: 1_000_000,
  output: 200_000,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fallback-provenance-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => DB_NOW,
  });
  return { db, dir };
}

/** Assert, via the library-pure engine, that the pinned table cannot price
 *  `model` — the premise every fallback assertion below rests on. */
function assertLibraryCannotPrice(model: string): void {
  const lib = computeTokenCost({
    model,
    inputTokens: COUNTS.input,
    outputTokens: COUNTS.output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called from test blocks
  assert.equal(
    lib.priced,
    false,
    `premise broken: genai-prices now prices "${model}" (reason ${lib.reason}), so this case no longer exercises the fallback tier`
  );
}

/** Assert, via the library-pure engine, that the pinned table CAN price
 *  `model` — the premise the genai-stamped sibling rests on. */
function assertLibraryPrices(model: string): void {
  const lib = computeTokenCost({
    model,
    inputTokens: COUNTS.input,
    outputTokens: COUNTS.output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called from test blocks
  assert.equal(
    lib.priced,
    true,
    `premise broken: genai-prices can no longer price "${model}" (reason ${lib.reason}), so this case no longer proves a library-priced stamp`
  );
}

async function usageRows(
  db: SqliteDb,
  sessionId: string
): Promise<
  { model: string; cost_source: string | null; cost: number | null }[]
> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      model: string;
      cost_source: string | null;
      cost_usd_estimated: number | null;
    }[]
  >(
    "SELECT model, cost_source, cost_usd_estimated FROM token_usage WHERE session_id = $1 ORDER BY model ASC",
    sessionId
  );
  return rows.map((r) => ({
    model: r.model,
    cost_source: r.cost_source,
    cost: r.cost_usd_estimated == null ? null : Number(r.cost_usd_estimated),
  }));
}

async function eventSources(
  db: SqliteDb,
  sessionId: string
): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_source: string | null }[]
  >(
    "SELECT DISTINCT cost_source FROM token_events WHERE session_id = $1 ORDER BY cost_source ASC",
    sessionId
  );
  return rows.map((r) => r.cost_source ?? "<null>");
}

async function sessionSource(
  db: SqliteDb,
  sessionId: string
): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_source: string | null }[]
  >("SELECT cost_source FROM sessions WHERE id = $1", sessionId);
  return rows[0]?.cost_source ?? null;
}

/**
 * Recreate what a pre-fix build left behind: fallback-priced rows wearing the
 * library stamp. Rewrites the STAMP only, so every cost stays the genuine one
 * the fixed writer produced and a heal that moved a dollar figure is detectable.
 */
async function stampAsPreFix(db: SqliteDb, sessionId: string): Promise<void> {
  for (const table of ["token_usage", "token_events"]) {
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE ${table} SET cost_source = $1 WHERE session_id = $2`,
        ModelPricingSource.GenaiPricesV1,
        sessionId
      )
    );
  }
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE sessions SET cost_source = $1 WHERE id = $2",
      ModelPricingSource.GenaiPricesV1,
      sessionId
    )
  );
}

function sessionOnModels(sessionId: string, models: string[]) {
  return makeSession({
    sessionId,
    model: models[0],
    tokensByModel: Object.fromEntries(
      models.map((m) => [
        m,
        {
          input: COUNTS.input,
          output: COUNTS.output,
          cacheRead: COUNTS.cacheRead,
          cacheWrite: COUNTS.cacheWrite,
        },
      ])
    ),
    tokenSeries: models.map((m, i) => ({
      timestamp: `2026-06-20T08:0${i}:00.000Z`,
      model: m,
      input: COUNTS.input,
      output: COUNTS.output,
      cacheRead: COUNTS.cacheRead,
      cacheWrite: COUNTS.cacheWrite,
    })),
  });
}

test("ISS-7762: a fallback-tier price persists as fallback_tier_v1, never as the library source", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-fallback-priced";
    await db.importer.importSession(
      sessionOnModels(sessionId, [UNPRICED_MODEL]),
      Harness.Claude
    );

    const usage = await usageRows(db, sessionId);
    assert.equal(usage.length, 1, "expected one token_usage row");
    // Still PRICED — the fix must not regress FEA-3546 into a $0/null row.
    assert.ok(
      usage[0].cost !== null && usage[0].cost > 0,
      `fallback row must still carry a cost (got ${usage[0].cost})`
    );
    assert.equal(
      usage[0].cost_source,
      ModelPricingSource.FallbackTierV1,
      `token_usage.cost_source must record the fallback floor, not a rate the library never supplied (got ${usage[0].cost_source})`
    );
    assert.deepEqual(
      await eventSources(db, sessionId),
      [ModelPricingSource.FallbackTierV1],
      "token_events must carry the same provenance as token_usage for the same estimate"
    );
    assert.equal(
      await sessionSource(db, sessionId),
      ModelPricingSource.FallbackTierV1,
      "sessions.cost_source must not claim a library-confirmed rate"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: a library-priced model still persists as genai_prices_v1", async () => {
  assertLibraryPrices(LIBRARY_PRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-library-priced";
    await db.importer.importSession(
      sessionOnModels(sessionId, [LIBRARY_PRICED_MODEL]),
      Harness.Claude
    );

    const usage = await usageRows(db, sessionId);
    assert.equal(usage.length, 1, "expected one token_usage row");
    assert.equal(
      usage[0].cost_source,
      ModelPricingSource.GenaiPricesV1,
      `a model the library CAN price must keep the library stamp (got ${usage[0].cost_source})`
    );
    assert.deepEqual(
      await eventSources(db, sessionId),
      [ModelPricingSource.GenaiPricesV1],
      "token_events must carry the library stamp for a library-priced model"
    );
    assert.equal(
      await sessionSource(db, sessionId),
      ModelPricingSource.GenaiPricesV1,
      "a wholly library-priced session keeps the library stamp"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: one library-priced model does not launder a session that is part fallback floor", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  assertLibraryPrices(LIBRARY_PRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-mixed-provenance";
    await db.importer.importSession(
      sessionOnModels(sessionId, [UNPRICED_MODEL, LIBRARY_PRICED_MODEL]),
      Harness.Claude
    );

    // The mix must be real, or the precedence assertion below proves nothing.
    const usage = await usageRows(db, sessionId);
    const bySource = new Map(usage.map((r) => [r.model, r.cost_source]));
    assert.equal(
      bySource.get(UNPRICED_MODEL),
      ModelPricingSource.FallbackTierV1,
      "the unpriced model's row must be stamped fallback"
    );
    assert.equal(
      bySource.get(LIBRARY_PRICED_MODEL),
      ModelPricingSource.GenaiPricesV1,
      "the library-priced model's row must be stamped genai"
    );

    // Weakest provenance wins: part of this session's total is a guessed rate,
    // so the session-level stamp must say so.
    assert.equal(
      await sessionSource(db, sessionId),
      ModelPricingSource.FallbackTierV1,
      "a session mixing a fallback floor with a verified rate is not a library-priced session"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the BATCH session rollup applies the same weakest-wins precedence as the per-session one", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  assertLibraryPrices(LIBRARY_PRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-batch-rollup";
    await db.importer.importSession(
      sessionOnModels(sessionId, [UNPRICED_MODEL, LIBRARY_PRICED_MODEL]),
      Harness.Claude
    );

    // Drive the SET-BASED rollup, not the per-session one. `repriceUnpricedTokenUsage`
    // selects sessions holding an unpriced row and finishes by calling
    // `updateSessionCostRollupBatch`, so NULLing one model's cost is what routes
    // this session through the batch path. Without this case the batch's own
    // precedence ladder is executed by the suite but asserted by nothing.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE token_usage SET cost_usd_estimated = NULL, cost_source = NULL WHERE session_id = $1 AND model = $2",
        sessionId,
        LIBRARY_PRICED_MODEL
      )
    );
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sessions SET cost_source = NULL WHERE id = $1",
        sessionId
      )
    );

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // The batch re-priced the NULLed row back to the library stamp...
    const usage = await usageRows(db, sessionId);
    const bySource = new Map(usage.map((r) => [r.model, r.cost_source]));
    assert.equal(
      bySource.get(LIBRARY_PRICED_MODEL),
      ModelPricingSource.GenaiPricesV1,
      "reprice must restore the library stamp on the row it re-priced"
    );
    assert.equal(
      bySource.get(UNPRICED_MODEL),
      ModelPricingSource.FallbackTierV1,
      "the fallback row must be left stamped fallback"
    );
    // ...and the batch's fold must still refuse to call the session library-priced.
    assert.equal(
      await sessionSource(db, sessionId),
      ModelPricingSource.FallbackTierV1,
      "the batch rollup must fold to the weakest provenance, exactly as the per-session rollup does"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the boot heal re-stamps pre-fix rows without moving a single cost", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-prefix-rows";
    await db.importer.importSession(
      sessionOnModels(sessionId, [UNPRICED_MODEL]),
      Harness.Claude
    );

    // Recreate what a pre-fix build left behind: a fallback-priced row wearing
    // the library stamp. Only the STAMP is rewritten here, so the cost captured
    // below is the genuine one the fixed writer produced.
    const costBefore = (await usageRows(db, sessionId))[0].cost;
    await stampAsPreFix(db, sessionId);

    await healFallbackCostSourceStamps(db.prisma, () => undefined);

    const healed = await usageRows(db, sessionId);
    assert.equal(
      healed[0].cost_source,
      ModelPricingSource.FallbackTierV1,
      "the heal must correct a pre-fix token_usage stamp"
    );
    assert.deepEqual(
      await eventSources(db, sessionId),
      [ModelPricingSource.FallbackTierV1],
      "the heal must correct pre-fix token_events stamps too"
    );
    assert.equal(
      await sessionSource(db, sessionId),
      ModelPricingSource.FallbackTierV1,
      "the heal must re-roll the stale session-level stamp"
    );
    // The heal corrects provenance ONLY. A cost that moved would mean it
    // re-priced something, which it must never do.
    assert.equal(
      healed[0].cost,
      costBefore,
      `the heal must not move a cost (was ${costBefore}, now ${healed[0].cost})`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the boot heal leaves a genuinely library-priced row alone", async () => {
  assertLibraryPrices(LIBRARY_PRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-library-untouched";
    await db.importer.importSession(
      sessionOnModels(sessionId, [LIBRARY_PRICED_MODEL]),
      Harness.Claude
    );

    await healFallbackCostSourceStamps(db.prisma, () => undefined);

    // The heal keys on whether the MODEL is priceable, so a library-priced row
    // must survive it untouched — otherwise it would launder every rate in the
    // store into "unverified" and the new value would mean nothing.
    assert.equal(
      (await usageRows(db, sessionId))[0].cost_source,
      ModelPricingSource.GenaiPricesV1,
      "a library-priced row must NOT be re-stamped as a fallback floor"
    );
    assert.equal(
      await sessionSource(db, sessionId),
      ModelPricingSource.GenaiPricesV1,
      "a wholly library-priced session must keep the library stamp through the heal"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: a row the engine refuses entirely persists cost_source NULL, not a fabricated stamp", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-unpriceable";
    await db.importer.importSession(
      sessionOnModels(sessionId, [LIBRARY_PRICED_MODEL]),
      Harness.Claude
    );

    // The THIRD state. `estimateTokenCost` returns `undefined` for a row it
    // cannot price at all (empty model id → `unknown_model`, deliberately
    // excluded from the FEA-3546 fallback), and `persistImportedTokenCosts`
    // forwards that `undefined` straight to this writer. Priced-and-verified,
    // priced-and-guessed, and not-priced must stay three distinct values —
    // without this case, returning a fallback stamp for `undefined` is green.
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        updateTokenUsageCost(
          tx,
          sessionId,
          LIBRARY_PRICED_MODEL,
          undefined,
          "2026-06-20T08:00:00.000Z"
        )
      )
    );

    const [row] = await usageRows(db, sessionId);
    assert.equal(
      row.cost_source,
      null,
      `an unpriced row must carry NO provenance, not a guessed one (got ${row.cost_source})`
    );
    assert.equal(row.cost, null, "an unpriced row must carry no cost");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the boot-maintenance chain actually runs the provenance heal", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-boot-wired";
    await db.importer.importSession(
      sessionOnModels(sessionId, [UNPRICED_MODEL]),
      Harness.Claude
    );
    await stampAsPreFix(db, sessionId);

    // Drives the PRODUCTION chain, not the pass in isolation: deleting the
    // `healFallbackCostSourceStamps` step from `boot-maintenance.ts` leaves every
    // other case in this file green while shipping a heal that never runs.
    await startBootMaintenance(db.prisma, () => undefined);

    assert.equal(
      (await usageRows(db, sessionId))[0].cost_source,
      ModelPricingSource.FallbackTierV1,
      "the boot chain must run the provenance heal"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the heal is idempotent — a second run changes nothing", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-idempotent";
    await db.importer.importSession(
      sessionOnModels(sessionId, [UNPRICED_MODEL]),
      Harness.Claude
    );
    await stampAsPreFix(db, sessionId);

    await healFallbackCostSourceStamps(db.prisma, () => undefined);
    const afterFirst = await usageRows(db, sessionId);
    const sessionAfterFirst = await sessionSource(db, sessionId);

    // Convergence is the property that makes this safe to run on every boot.
    const logs: string[] = [];
    await healFallbackCostSourceStamps(db.prisma, (m) => logs.push(m));

    assert.deepEqual(
      await usageRows(db, sessionId),
      afterFirst,
      "a second heal must leave the rows byte-for-byte as the first left them"
    );
    assert.equal(
      await sessionSource(db, sessionId),
      sessionAfterFirst,
      "a second heal must not disturb the session stamp"
    );
    assert.deepEqual(
      logs,
      [],
      `a converged heal must do no work and log nothing; got ${JSON.stringify(logs)}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the heal corrects every fallback model across every session, in chunks", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  assertLibraryCannotPrice(UNPRICED_MODEL_2);
  assertLibraryPrices(LIBRARY_PRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionIds = ["sess-fan-a", "sess-fan-b", "sess-fan-c"];
    for (const sessionId of sessionIds) {
      await db.importer.importSession(
        sessionOnModels(sessionId, [
          UNPRICED_MODEL,
          UNPRICED_MODEL_2,
          LIBRARY_PRICED_MODEL,
        ]),
        Harness.Claude
      );
      await stampAsPreFix(db, sessionId);
    }

    // chunkSize 1 over 3 sessions drives the re-roll loop past a single chunk;
    // at the default 200 every fixture here fits in one pass and a mutation to
    // the stride would go unnoticed.
    await healFallbackCostSourceStamps(db.prisma, () => undefined, 1);

    for (const sessionId of sessionIds) {
      const bySource = new Map(
        (await usageRows(db, sessionId)).map((r) => [r.model, r.cost_source])
      );
      assert.equal(
        bySource.get(UNPRICED_MODEL),
        ModelPricingSource.FallbackTierV1,
        `${sessionId}: first fallback model must be corrected`
      );
      assert.equal(
        bySource.get(UNPRICED_MODEL_2),
        ModelPricingSource.FallbackTierV1,
        `${sessionId}: the SECOND fallback model must be corrected too — a loop that stops after one model must fail here`
      );
      assert.equal(
        bySource.get(LIBRARY_PRICED_MODEL),
        ModelPricingSource.GenaiPricesV1,
        `${sessionId}: the library-priced model must be left alone`
      );
      assert.equal(
        await sessionSource(db, sessionId),
        ModelPricingSource.FallbackTierV1,
        `${sessionId}: every session in every chunk must be re-rolled`
      );
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the heal re-rolls a HALF-healed session whose rows are already correct", async () => {
  assertLibraryCannotPrice(UNPRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-half-healed";
    await db.importer.importSession(
      sessionOnModels(sessionId, [UNPRICED_MODEL]),
      Harness.Claude
    );

    // The state a crash BETWEEN the two passes leaves behind, and the one the
    // module docstring names: token_usage/token_events already re-stamped
    // `fallback_tier_v1`, `sessions.cost_source` still the stale library stamp.
    // Pass 1 finds no `genai_prices_v1` row here and restamps NOTHING, so the
    // session can only be repaired by pass 2 running unconditionally. Gating the
    // re-roll on `restamped > 0` leaves every other case in this file green and
    // strands these sessions stale on every subsequent boot.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sessions SET cost_source = $1 WHERE id = $2",
        ModelPricingSource.GenaiPricesV1,
        sessionId
      )
    );
    assert.deepEqual(
      (await usageRows(db, sessionId)).map((r) => r.cost_source),
      [ModelPricingSource.FallbackTierV1],
      "premise: the fixture's rows must already be healed, so pass 1 has no work"
    );

    const logs: string[] = [];
    await healFallbackCostSourceStamps(db.prisma, (m) => logs.push(m));

    assert.equal(
      await sessionSource(db, sessionId),
      ModelPricingSource.FallbackTierV1,
      "a session left stale by an interrupted heal must be re-rolled on the next boot even though no row needed re-stamping"
    );
    assert.ok(
      logs.some((m) => m.includes("re-stamped 0 fallback-priced model(s)")),
      `pass 2 must have done the work alone; got ${JSON.stringify(logs)}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7762: the heal reports price-table membership drift instead of re-deriving it", async () => {
  assertLibraryPrices(LIBRARY_PRICED_MODEL);
  const { db, dir } = await openTempDb();
  try {
    const driftedSession = "sess-drift-fallback-rows";
    const laterSession = "sess-drift-library-rows";
    for (const sessionId of [driftedSession, laterSession]) {
      await db.importer.importSession(
        sessionOnModels(sessionId, [LIBRARY_PRICED_MODEL]),
        Harness.Claude
      );
    }

    // A build whose pinned table did NOT yet carry this id priced it from the
    // fallback tier and stamped it honestly; today's table DOES carry it. Only a
    // table that gained the id can produce that pair, so it is proof that
    // writer-era membership differed from the membership the heal reads.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE token_usage SET cost_source = $1 WHERE session_id = $2",
        ModelPricingSource.FallbackTierV1,
        driftedSession
      )
    );

    const logs: string[] = [];
    await healFallbackCostSourceStamps(db.prisma, (m) => logs.push(m));

    // The other session's rows were written by a build whose table membership
    // for this id is unknowable from here. Re-deriving them either way asserts a
    // provenance nothing observed, so they must survive exactly as written.
    assert.equal(
      (await usageRows(db, laterSession))[0].cost_source,
      ModelPricingSource.GenaiPricesV1,
      "a genai_prices_v1 row must never be re-derived from the current price table"
    );
    assert.ok(
      logs.some(
        (m) =>
          m.includes("price-table membership moved") &&
          m.includes(LIBRARY_PRICED_MODEL)
      ),
      `the heal must name the drifted model rather than converge silently over it; got ${JSON.stringify(logs)}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
