/**
 * @file session-cost-rollup-divergence.test.ts
 * @description ISS-7776: `sessions.cost_usd_estimated` and
 * `session_analytics.est_cost` are two derivations of ONE session total, and
 * before this suite nothing asserted them TOGETHER after the derived-rollup
 * phase — the existing web-search coverage only ever read them straight after a
 * full import, when group 4 had just written the authoritative column anyway.
 * These cases pin the states that separate them: a refresh where both must land
 * on the same number, an unpriced and a partially-priced window where the
 * recompute must DECLINE rather than publish a figure it cannot stand behind,
 * and a zero-row session where it must NOT decline because that is a real
 * priceable state.
 *
 * DECLINE, not clear. #5825 review (whitlockk) argued the guard should NULL the
 * column, since a survivor is served verbatim by `attachEstimatedCosts` and so
 * also suppresses the read-path repair. That is the reverse of the contract this
 * repo landed with the same ticket — `write-core-import-phases.test.ts` requires
 * the stale total to survive, on "a stale real number beats a fresh wrong one",
 * and `importPhaseDerivedRollups` REPORTS the skip so the state is not silent.
 * The last ISS-7776 case below seeds a preexisting total and asserts it SURVIVES,
 * which is the only case here that can tell decline from clear apart at all.
 *
 * ISS-7820 closed the half ISS-7776 scoped out and its cases live here too,
 * because they read the SAME pair of columns through the same phase and a
 * separate file would have had to copy this fixture. `session_analytics.est_cost`
 * was `NOT NULL DEFAULT 0` and so had nowhere to put "unknown": an unpriced
 * window reported the web-search line item alone and a partly-priced one reported
 * a SUM that had silently skipped its NULLs. It is nullable now and computed from
 * the shared `sessionEstimatedCostSql`. One ISS-7776 expectation changed with it
 * — the line that PINNED the old $0.03 collapse, written to force exactly this
 * deliberate update — and it is annotated at the assertion.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { importPhaseDerivedRollups } from "../src/main/database/write-core-import-phases-rollups.js";
import { makeSession } from "./normalized-session-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-08-22T12:00:00.000Z";
const SESSION_ID = "iss-7776-cost-rollup";

/**
 * Hand-derived from the published claude-opus-4-5 rates, NOT from either
 * derivation under test — a test that computed its expectation by calling one of
 * them could not fail when both are wrong together, which is the exact defect
 * here. 1000 input × $5/MTok = $0.005, 500 output × $25/MTok = $0.0125,
 * 10 cache-read × $0.50/MTok = $0.000005, 5 cache-write × $6.25/MTok =
 * $0.00003125.
 */
const TOKEN_COST_USD = 0.017_536_25;
/** 3 requests × WEB_SEARCH_COST_PER_REQUEST_USD ($0.01), a session line item. */
const WEB_SEARCH_COST_USD = 0.03;
const TOTAL_COST_USD = 0.047_536_25;

const seedSession = (): NormalizedSession =>
  makeSession({
    sessionId: SESSION_ID,
    model: "claude-opus-4-5",
    startedAt: NOW,
    endedAt: "2026-08-22T12:05:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      "claude-opus-4-5": {
        input: 1000,
        output: 500,
        cacheRead: 10,
        cacheWrite: 5,
      },
    },
    messageTimestamps: ["2026-08-22T12:00:30.000Z"],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
      reasoning_output_tokens: 0,
      web_search_requests: 3,
    },
  });

async function openStore(dir: string): Promise<SqliteDb> {
  return await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
    log: () => {
      /* the rollup's required reporter; nothing under test reads it */
    },
  });
}

/** The authoritative session total. `null` means "no cost could be derived". */
async function sessionCost(db: SqliteDb): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", SESSION_ID);
  const value = rows[0]?.cost_usd_estimated;
  return value == null ? null : Number(value);
}

/** The analytics copy of the same total. */
async function analyticsCost(db: SqliteDb): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { est_cost: number | null }[]
  >("SELECT est_cost FROM session_analytics WHERE session_id = $1", SESSION_ID);
  const value = rows[0]?.est_cost;
  return value == null ? null : Number(value);
}

/** Record group 8 alone, the phase that refreshes `session_analytics`. */
async function runDerivedRollupPhase(
  db: SqliteDb,
  session: NormalizedSession
): Promise<void> {
  await db.prisma.write((client) =>
    client.$transaction((tx) =>
      importPhaseDerivedRollups(
        tx,
        { session, now: NOW, log: () => undefined },
        async () => {
          /* last_activity_at is a separate cursor, not part of this contract */
        }
      )
    )
  );
}

const near = (a: number | null, b: number): boolean =>
  a !== null && Math.abs(a - b) < 1e-9;

describe("ISS-7776 session cost rollup convergence", () => {
  test("the derived-rollup phase refreshes BOTH session totals from the same rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7776-converge-"));
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");

      // PRECONDITION: the seed really did carry a web-search line item, so the
      // re-parse below has $0.03 to lose. Without this the case could pass on a
      // seed that never priced web search at all.
      assert.ok(
        near(await sessionCost(db), TOTAL_COST_USD),
        `seed must price tokens + web search, got ${await sessionCost(db)}`
      );
      assert.ok(near(await analyticsCost(db), TOTAL_COST_USD));
      assert.ok(
        Math.abs(TOTAL_COST_USD - TOKEN_COST_USD - WEB_SEARCH_COST_USD) < 1e-12,
        "the seed's web-search line item must be a real component of the total"
      );

      // The re-parse: the same session parsed again with no web search. Its
      // token_usage rows are untouched and still priced; only the session's
      // persisted metadata loses the count.
      await db.run(
        "UPDATE sessions SET metadata = json_remove(metadata, '$.usageExtras.web_search_requests') WHERE id = $1",
        SESSION_ID
      );
      await runDerivedRollupPhase(db, session);

      assert.ok(
        near(await analyticsCost(db), TOKEN_COST_USD),
        `analytics est_cost should drop the line item, got ${await analyticsCost(db)}`
      );
      assert.ok(
        near(await sessionCost(db), TOKEN_COST_USD),
        `authoritative total should drop it too, got ${await sessionCost(db)}`
      );
      assert.equal(await sessionCost(db), await analyticsCost(db));
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a second identical import moves neither total", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7776-idempotent-"));
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");
      const firstSession = await sessionCost(db);
      const firstAnalytics = await analyticsCost(db);
      assert.ok(near(firstSession, TOTAL_COST_USD));
      // Anchored to each other as well as to the literal, so this case cannot
      // pass on a build where the two are merely each STABLE while disagreeing.
      assert.equal(firstSession, firstAnalytics);

      await db.importer.importSession(seedSession(), "claude");
      assert.equal(await sessionCost(db), firstSession);
      assert.equal(await analyticsCost(db), firstAnalytics);

      // And the phase on its own converges too, so a rollup-only re-run cannot
      // accumulate the line item.
      await runDerivedRollupPhase(db, session);
      assert.equal(await sessionCost(db), firstSession);
      assert.equal(await analyticsCost(db), firstAnalytics);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unpriced token_usage window leaves the authoritative total alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7776-unpriced-"));
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");
      assert.ok(near(await sessionCost(db), TOTAL_COST_USD));

      // Record group 3 re-inserts token_usage bare and group 4 prices it, but
      // group 4 is tolerant — so the rollup can observe rows that exist and are
      // priced NONE. Their sum is not "this session cost nothing".
      await db.run(
        "UPDATE token_usage SET cost_usd_estimated = NULL WHERE session_id = $1",
        SESSION_ID
      );
      const unpricedRows = await db.prisma.client.$queryRawUnsafe<
        { total: number; priced: number }[]
      >(
        "SELECT COUNT(*) AS total, COUNT(cost_usd_estimated) AS priced FROM token_usage WHERE session_id = $1",
        SESSION_ID
      );
      assert.ok(
        Number(unpricedRows[0]?.total ?? 0) > 0,
        "the window needs token_usage rows to exist"
      );
      assert.equal(Number(unpricedRows[0]?.priced ?? -1), 0);

      await runDerivedRollupPhase(db, session);

      // The authoritative column keeps its stale-but-real total rather than
      // being overwritten with the web-search line item alone.
      assert.ok(
        near(await sessionCost(db), TOTAL_COST_USD),
        `unpriced rows must not rewrite the total, got ${await sessionCost(db)}`
      );
      assert.ok(
        !near(await sessionCost(db), WEB_SEARCH_COST_USD),
        "the web-search line item alone is not a session total"
      );
      // ISS-7820: `session_analytics.est_cost` USED to collapse to that same
      // line item — a $0.03 answer for a $0.04753625 session, and the exact
      // evidence that ticket was filed on. The column is nullable now and says
      // "unknown" instead. That expectation change IS ISS-7820, not test drift:
      // ISS-7776 pinned the old value precisely so a future fix would have to
      // come here and change it deliberately.
      //
      // Both halves matter. NULL is the point, and NOT the old wrong number is
      // what proves the collapse is gone rather than merely relabelled.
      assert.equal(
        await analyticsCost(db),
        null,
        `an unpriced window must read unknown, got ${await analyticsCost(db)}`
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a session with no token_usage rows at all still gets its line-item total", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7776-no-rows-"));
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");
      // Zero rows satisfies `priced_rows = token_usage_rows`, and must: a
      // web-search-only session is a real priceable state, not a gap. Narrowing
      // the guard to `priced_rows > 0` reddens exactly here.
      await db.run("DELETE FROM token_usage WHERE session_id = $1", SESSION_ID);
      await db.run(
        "UPDATE sessions SET cost_usd_estimated = 999 WHERE id = $1",
        SESSION_ID
      );

      await runDerivedRollupPhase(db, session);

      assert.ok(
        near(await sessionCost(db), WEB_SEARCH_COST_USD),
        `zero rows must still refresh to the line item, got ${await sessionCost(db)}`
      );
      assert.equal(await sessionCost(db), await analyticsCost(db));
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a partially priced session keeps its unknown rather than a partial sum", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7776-partial-"));
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");
      // A second model the pricing table could not map, alongside the priced
      // one. SUM skips its NULL and records nothing about having done so, so a
      // recompute here would stamp a confident figure that is simply low — and
      // `attachEstimatedCosts` re-prices from token_usage ONLY while this column
      // is NULL, so writing the under-report would also suppress that repair.
      await db.run(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
         VALUES ($1, 'totally-made-up-model-xyz', 4000, 0, 0, 0, $2)`,
        SESSION_ID,
        NOW
      );
      await db.run(
        "UPDATE sessions SET cost_usd_estimated = NULL WHERE id = $1",
        SESSION_ID
      );

      await runDerivedRollupPhase(db, session);

      assert.equal(
        await sessionCost(db),
        null,
        `a partial sum must not become the stored total, got ${await sessionCost(db)}`
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a partially priced session keeps a preexisting total instead of rewriting it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7776-partial-stale-"));
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");
      // The import leaves the authoritative total populated. This is the case
      // the sibling partial-window test cannot reach, because it NULLs the
      // column before recomputing: with a value already there, "skip the write"
      // and "clear the write" are indistinguishable from the column's final
      // state unless something asserts it here. This is the case that pins which
      // of the two this repo ships (#5825 review, whitlockk, argued for clear).
      assert.ok(
        near(await sessionCost(db), TOTAL_COST_USD),
        "the fixture must start with a stored total for this case to mean anything"
      );
      // One model the pricing table cannot map, alongside the priced one, so the
      // window is PARTIALLY priced rather than wholly unpriced.
      await db.run(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
         VALUES ($1, 'totally-made-up-model-xyz', 4000, 0, 0, 0, $2)`,
        SESSION_ID,
        NOW
      );

      await runDerivedRollupPhase(db, session);

      // Preserved, and specifically NOT rewritten to the priced subset's sum:
      // the newly inserted unpriced model contributes nothing to `SUM`, so a
      // rewrite here would republish the same figure the fixture started with by
      // coincidence. Asserting the ORIGINAL total therefore also asserts that a
      // clear (NULL) did not happen — the two outcomes this guard chooses
      // between are "this value" and "NULL", and only one of them is this value.
      assert.ok(
        near(await sessionCost(db), TOTAL_COST_USD),
        `a partial window must leave the preexisting total alone, got ${await sessionCost(db)}`
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ISS-7820 est_cost can say unknown", () => {
  test("a genuinely-zero window reads 0 where an unpriced one reads null", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "iss7820-zero-vs-unknown-")
    );
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");

      // ONE store, ONE session, and the ONLY thing that changes between the two
      // halves below is whether the rows carry a price. Two separate fixtures
      // could differ in some other way and still produce 0 and null; this cannot.

      // A real $0.00: every token_usage row PRICED, priced at zero, and no
      // web-search line item to add. This is the value the old NOT NULL column
      // could not be told apart from "nobody priced this".
      await db.run(
        "UPDATE token_usage SET cost_usd_estimated = 0 WHERE session_id = $1",
        SESSION_ID
      );
      await db.run(
        `UPDATE sessions
         SET metadata = json_remove(metadata, '$.usageExtras.web_search_requests')
         WHERE id = $1`,
        SESSION_ID
      );
      await runDerivedRollupPhase(db, session);

      assert.equal(
        await analyticsCost(db),
        0,
        `a fully priced window summing to zero is a real total, got ${await analyticsCost(db)}`
      );
      // And the sibling column says the same thing, which is what makes the 0
      // above a reading of the data rather than of a DEFAULT.
      assert.equal(await sessionCost(db), 0);

      // Same rows, same metadata, same phase — only the prices go away.
      await db.run(
        "UPDATE token_usage SET cost_usd_estimated = NULL WHERE session_id = $1",
        SESSION_ID
      );
      await runDerivedRollupPhase(db, session);

      assert.equal(
        await analyticsCost(db),
        null,
        `an unpriced window must not report a cost, got ${await analyticsCost(db)}`
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a partially priced window reads null rather than the priced subset's sum", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7820-partial-"));
    const db = await openStore(dir);
    const session = seedSession();
    try {
      await db.importer.importSession(session, "claude");
      assert.ok(
        near(await analyticsCost(db), TOTAL_COST_USD),
        `the fixture must start fully priced, got ${await analyticsCost(db)}`
      );

      // One model the pricing table cannot map, alongside the priced one. SUM
      // skips its NULL silently, so the pre-ISS-7820 column reported
      // TOKEN_COST_USD + WEB_SEARCH_COST_USD for a session that is now worth
      // strictly more than that — a confident figure that is simply low.
      await db.run(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
         VALUES ($1, 'totally-made-up-model-xyz', 4000, 0, 0, 0, $2)`,
        SESSION_ID,
        NOW
      );

      await runDerivedRollupPhase(db, session);

      assert.equal(
        await analyticsCost(db),
        null,
        `a partial sum is not a total, got ${await analyticsCost(db)}`
      );
      // The authoritative column DECLINES instead of clearing, so it keeps the
      // last figure it could stand behind. That asymmetry is deliberate and is
      // what the pair is worth reading together: "unknown" beside "last known"
      // is actionable, "the web-search line item alone" beside "the real total"
      // was not.
      assert.ok(
        near(await sessionCost(db), TOTAL_COST_USD),
        `the authoritative total must survive, got ${await sessionCost(db)}`
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
