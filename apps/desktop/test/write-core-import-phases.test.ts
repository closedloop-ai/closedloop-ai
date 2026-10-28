/**
 * @file write-core-import-phases.test.ts
 * @description Locks the derived-rollup orchestration contract while the import
 * phases move out of write-core.ts (ISS-7578).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "@repo/cost/harness-cost-parity";
import { describe, test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { importPhaseDerivedRollups } from "../src/main/database/write-core-import-phases-rollups.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-22T12:00:00.000Z";
const MISSING_AGENT_ID = "iss-7578-missing-agent";
const DROPPED_AGENT_REPORT = /dropped 1 agent_id/;
const PRICED_MODEL = "claude-opus-4-5";
const SECOND_PRICED_MODEL = "claude-sonnet-4-5";
const WEB_SEARCH_REQUESTS = 3;
/** What a re-parse reports after the session accumulated more web searches. */
const WEB_SEARCH_REQUESTS_REPARSED = 5;
const PARTIALLY_PRICED_REPORT =
  /session_cost_rollup .*1 of 2 token_usage rows priced/;

describe("ISS-7578 write-core import phases", () => {
  test("the derived rollup replaces component usage and reports dropped agent references", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "write-core-phases-"));
    const messages: string[] = [];
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
      log: (message) => messages.push(message),
    });
    const session = makeSession({
      sessionId: "iss-7578-derived-rollup",
      startedAt: NOW,
      endedAt: "2026-08-22T12:05:00.000Z",
      toolUses: [
        {
          id: "toolu_iss_7578",
          providerToolUseId: "toolu_iss_7578",
          name: "Read",
          kind: "builtin",
          timestamp: "2026-08-22T12:00:01.000Z",
        },
      ],
    });

    try {
      await db.importer.importSession(session, "claude");
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        session.sessionId
      );
      await db.run(
        "UPDATE events SET agent_id = $1 WHERE session_id = $2 AND tool_name IS NOT NULL",
        MISSING_AGENT_ID,
        session.sessionId
      );
      await db.run(
        `INSERT INTO agent_component_session_usage
           (session_id, component_kind, component_key)
         VALUES ($1, 'skill', 'stale-skill')`,
        session.sessionId
      );
      messages.length = 0;

      const ctx = {
        session,
        now: NOW,
        log: (message: string) => messages.push(message),
      };
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          importPhaseDerivedRollups(tx, ctx, async () => {})
        )
      );

      const usage = await db.prisma.client.$queryRawUnsafe<
        Array<{ component_kind: string; component_key: string }>
      >(
        `SELECT component_kind, component_key
           FROM agent_component_session_usage
          WHERE session_id = $1
          ORDER BY component_kind, component_key`,
        session.sessionId
      );
      assert.deepEqual(usage, [
        { component_kind: "tool", component_key: "Read" },
      ]);
      assert.equal(messages.length, 1);
      assert.match(messages[0] ?? "", DROPPED_AGENT_REPORT);
      assert.match(messages[0] ?? "", new RegExp(MISSING_AGENT_ID));
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `sessions.cost_usd_estimated` and `session_analytics.est_cost` are two
   * INDEPENDENT derivations of one number: each sums
   * `token_usage.cost_usd_estimated` and adds the web-search line item read from
   * `sessions.metadata` through the shared `webSearchCostSql` fragment. Sharing
   * that fragment makes them PRICE web search identically; it does not make them
   * AGREE when only the analytics half re-runs.
   *
   * ISS-7776: the seeded state below is what an import leaves behind when the
   * session phase refreshes `sessions.metadata` but the token-cost phase returns
   * before `persistImportedTokenCosts` — ISS-7736's zero-model preserve path. The
   * `token_usage` rows survive PRICED, so group 8 can and must recompute BOTH
   * totals and a reader of either column sees the same session cost. (The
   * unpriced-rows case is deliberately NOT this; see the next test.)
   *
   * Both columns are asserted on purpose: the ISS-7736 suite read neither, which
   * is how a divergence between them survived a change to the phase that feeds
   * them.
   */
  test("the derived rollup recomputes the session cost total, not only the analytics one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "write-core-cost-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
    });
    const session = makeSession({
      sessionId: "cost-rollup-agreement",
      model: PRICED_MODEL,
      startedAt: NOW,
      endedAt: "2026-08-22T12:05:00.000Z",
      tokensByModel: {
        [PRICED_MODEL]: {
          input: 1000,
          output: 500,
          cacheRead: 10,
          cacheWrite: 5,
        },
      },
      usageExtras: {
        service_tiers: [],
        speeds: [],
        inference_geos: [],
        reasoning_output_tokens: 0,
        web_search_requests: WEB_SEARCH_REQUESTS,
      },
    });

    try {
      await db.importer.importSession(session, "claude");
      const tokenCostUsd = await readTokenUsageCost(db, session.sessionId);
      const seeded = await readCostTotals(db, session.sessionId);

      // Precondition, not decoration. If the seed did not actually carry a
      // web-search line item on top of the token cost, the healing assertion
      // below would hold on a session that had nothing to lose.
      assert.equal(
        seeded.sessionCostUsd,
        seeded.analyticsCostUsd,
        "the seeded import already disagreed with itself"
      );
      assert.equal(
        seeded.sessionCostUsd,
        tokenCostUsd + WEB_SEARCH_REQUESTS * WEB_SEARCH_COST_PER_REQUEST_USD,
        "the seed carried no web-search line item, so this case cannot observe it being dropped"
      );

      // The re-parse reported no web search. `shapePersistedUsageExtras` omits
      // the key entirely at zero, so this is byte-for-byte the blob the session
      // phase writes — not a synthetic corruption.
      await db.run(
        "UPDATE sessions SET metadata = json_remove(metadata, '$.usageExtras.web_search_requests') WHERE id = $1",
        session.sessionId
      );

      assert.deepEqual(
        await runDerivedRollups(db, session),
        [],
        "the derived rollup reported a dropped reference this fixture should not produce"
      );

      const healed = await readCostTotals(db, session.sessionId);
      assert.equal(
        healed.sessionCostUsd,
        healed.analyticsCostUsd,
        "the derived-rollup phase left the authoritative session cost stale beside a recomputed analytics cost — the two columns now report different totals for one session"
      );
      assert.equal(
        healed.sessionCostUsd,
        tokenCostUsd,
        "the recomputed total did not drop the web-search line item the metadata no longer reports"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The negative sibling of the case above, and the reason group 8's cost
   * recompute is guarded rather than unconditional.
   *
   * Record group 3 re-inserts `token_usage` with NO cost columns; record group 4
   * is what prices them, and in the isolated-import path a group-4 failure is
   * TOLERATED — logged, then the import continues to group 8. Summing rows that
   * exist but are all unpriced answers "this session cost nothing", and with a
   * web-search count present it writes that line item ALONE as the whole total.
   * An unguarded recompute rewrote a real $0.04753625 session to $0.03 here.
   *
   * "Not priced yet" is not a cost. The stored total stays a stale real number
   * instead of becoming a fresh wrong one.
   */
  test("the derived rollup leaves the session cost alone when the token rows are unpriced", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "write-core-unpriced-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
    });
    const session = makeSession({
      sessionId: "cost-rollup-unpriced",
      model: PRICED_MODEL,
      startedAt: NOW,
      endedAt: "2026-08-22T12:05:00.000Z",
      tokensByModel: {
        [PRICED_MODEL]: {
          input: 1000,
          output: 500,
          cacheRead: 10,
          cacheWrite: 5,
        },
      },
      usageExtras: {
        service_tiers: [],
        speeds: [],
        inference_geos: [],
        reasoning_output_tokens: 0,
        web_search_requests: WEB_SEARCH_REQUESTS,
      },
    });

    try {
      await db.importer.importSession(session, "claude");
      const seeded = await readCostTotals(db, session.sessionId);
      const webSearchOnlyUsd =
        WEB_SEARCH_REQUESTS * WEB_SEARCH_COST_PER_REQUEST_USD;

      // Precondition: the seed must cost MORE than its web-search line item, or
      // the collapse this case exists to catch would be invisible.
      assert.ok(
        (seeded.sessionCostUsd ?? 0) > webSearchOnlyUsd,
        "the seeded session cost no more than its web-search line item, so a collapse to that line item alone could not be observed"
      );

      // Exactly what record group 3 leaves behind: the rows are re-inserted from
      // the parse with no cost columns, and group 4 never priced them.
      await db.run(
        "UPDATE token_usage SET cost_usd_estimated = NULL, cost_source = NULL WHERE session_id = $1",
        session.sessionId
      );

      assert.deepEqual(
        await runDerivedRollups(db, session),
        [],
        "the derived rollup reported a dropped reference this fixture should not produce"
      );

      assert.equal(
        (await readCostTotals(db, session.sessionId)).sessionCostUsd,
        seeded.sessionCostUsd,
        "the derived rollup overwrote the authoritative session cost from unpriced rows, reporting the web-search line item alone as the session's whole cost"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The case between the two above, and the one the first guard could not see:
   * a population where SOME rows are priced and some are not.
   *
   * Record group 4 prices `token_usage` row by row, and in the isolated-import
   * path its failure is TOLERATED. A failure partway through therefore leaves a
   * mixture — reachable too when an isolated import preserves an already-priced
   * row while inserting a second model the tolerated phase never got to.
   * `updateSessionCostRollup` sums the non-NULL rows and persists that sum as the
   * authoritative total, so rolling up here answers the two-model question with
   * one model's spend: a confident number over an incomplete population, and one
   * nothing downstream can tell apart from a complete one.
   *
   * `priced_rows > 0` was true of this state, which is why the predicate requires
   * the WHOLE population priced. The skip is reported, because a partly-priced
   * population is a state no other phase mentions and the skip leaves no trace in
   * the columns it declined to write.
   */
  test("the derived rollup leaves the session cost alone when only some token rows are priced", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "write-core-partial-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
    });
    const session = makeSession({
      sessionId: "cost-rollup-partially-priced",
      model: PRICED_MODEL,
      startedAt: NOW,
      endedAt: "2026-08-22T12:05:00.000Z",
      tokensByModel: {
        [PRICED_MODEL]: {
          input: 1000,
          output: 500,
          cacheRead: 10,
          cacheWrite: 5,
        },
        [SECOND_PRICED_MODEL]: {
          input: 4000,
          output: 2000,
          cacheRead: 40,
          cacheWrite: 20,
        },
      },
      usageExtras: {
        service_tiers: [],
        speeds: [],
        inference_geos: [],
        reasoning_output_tokens: 0,
        web_search_requests: WEB_SEARCH_REQUESTS,
      },
    });

    try {
      await db.importer.importSession(session, "claude");
      const seeded = await readCostTotals(db, session.sessionId);
      const fullTokenCostUsd = await readTokenUsageCost(db, session.sessionId);

      assert.deepEqual(
        await readTokenUsagePricingCounts(db, session.sessionId),
        { usageRows: 2, pricedRows: 2 },
        "the seed did not import two priced token_usage rows, so a mixture cannot be constructed from it"
      );

      // Group 4 priced one row and then failed: the second model keeps the NULL
      // cost columns record group 3 inserts it with.
      await db.run(
        "UPDATE token_usage SET cost_usd_estimated = NULL, cost_source = NULL WHERE session_id = $1 AND model = $2",
        session.sessionId,
        SECOND_PRICED_MODEL
      );

      const partialTokenCostUsd = await readTokenUsageCost(
        db,
        session.sessionId
      );
      // Precondition: the surviving rows must sum to LESS than the whole
      // population, or a rollup over the partial population would be
      // indistinguishable from a correct one.
      assert.ok(
        partialTokenCostUsd < fullTokenCostUsd,
        "the unpriced row carried no cost, so a rollup over the remaining priced rows could not be observed undercounting"
      );

      const reported = await runDerivedRollups(db, session);

      assert.equal(
        (await readCostTotals(db, session.sessionId)).sessionCostUsd,
        seeded.sessionCostUsd,
        "the derived rollup overwrote the authoritative session cost from a partially priced population, reporting one model's spend as the two-model session's whole cost"
      );
      assert.equal(reported.length, 1);
      assert.match(reported[0] ?? "", PARTIALLY_PRICED_REPORT);
      assert.match(reported[0] ?? "", new RegExp(session.sessionId));
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The zero-row side of the guard, which is a PASS and not a skip.
   *
   * A session with no `token_usage` rows has nothing pending, so there is no
   * unpriced population to protect and its cost is exactly its session-level line
   * items. A web-search-only session is that session: `web_search_requests` is
   * billed per request from `sessions.metadata`, never from a `token_usage` row,
   * so the guard must let group 8 write it. Requiring a priced row before rolling
   * up would leave these sessions carrying whatever total predated the metadata
   * refresh — silently, since the analytics half re-runs either way.
   *
   * The re-parse below raises the count the session phase persists, so only a
   * recompute in this phase can produce the right total.
   */
  test("the derived rollup still computes a web-search-only session's cost with no token rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "write-core-websearch-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
    });
    const session = makeSession({
      sessionId: "cost-rollup-web-search-only",
      model: PRICED_MODEL,
      startedAt: NOW,
      endedAt: "2026-08-22T12:05:00.000Z",
      tokensByModel: {},
      usageExtras: {
        service_tiers: [],
        speeds: [],
        inference_geos: [],
        reasoning_output_tokens: 0,
        web_search_requests: WEB_SEARCH_REQUESTS,
      },
    });

    try {
      await db.importer.importSession(session, "claude");

      assert.deepEqual(
        await readTokenUsagePricingCounts(db, session.sessionId),
        { usageRows: 0, pricedRows: 0 },
        "the fixture imported token_usage rows, so it is not the zero-row branch"
      );
      assert.equal(
        (await readCostTotals(db, session.sessionId)).sessionCostUsd,
        WEB_SEARCH_REQUESTS * WEB_SEARCH_COST_PER_REQUEST_USD,
        "the seeded session cost was not its web-search line item alone"
      );

      await db.run(
        "UPDATE sessions SET metadata = json_set(metadata, '$.usageExtras.web_search_requests', $2) WHERE id = $1",
        session.sessionId,
        WEB_SEARCH_REQUESTS_REPARSED
      );

      assert.deepEqual(
        await runDerivedRollups(db, session),
        [],
        "the derived rollup reported a dropped reference this fixture should not produce"
      );

      const healed = await readCostTotals(db, session.sessionId);
      assert.equal(
        healed.sessionCostUsd,
        WEB_SEARCH_REQUESTS_REPARSED * WEB_SEARCH_COST_PER_REQUEST_USD,
        "the derived rollup skipped a session with no token_usage rows, leaving a web-search-only session's authoritative cost stale"
      );
      assert.equal(
        healed.sessionCostUsd,
        healed.analyticsCostUsd,
        "the two cost columns disagree for a session whose whole cost is its web-search line item"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ISS-5801: an invocation-set change advances the sync watermark even when session data is unchanged", async () => {
    // whitlockk on #6166: a deriver upgrade re-derives a session's invocation set
    // from byte-identical session data (`sessionDataChanged` false). Without a
    // watermark bump the parent stays behind the incremental sync cursor while
    // its freshly queued invocation children ship — and terminally reject with
    // `session_missing`. The bump must ALSO not fire for a byte-identical
    // re-derivation, or every re-import re-syncs the whole corpus.
    const dir = await mkdtemp(path.join(os.tmpdir(), "write-core-watermark-"));
    let clock = NOW;
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
      now: () => clock,
    });
    const session = makeSession({
      sessionId: "iss-5801-watermark",
      startedAt: NOW,
      endedAt: "2026-08-22T12:05:00.000Z",
      toolUses: [
        {
          id: "toolu_iss_5801",
          providerToolUseId: "toolu_iss_5801",
          name: "Read",
          kind: "builtin",
          timestamp: "2026-08-22T12:00:01.000Z",
        },
      ],
    });
    const readUpdatedAt = async () => {
      const rows = await db.prisma.client.$queryRawUnsafe<
        Array<{ updated_at: string }>
      >("SELECT updated_at FROM sessions WHERE id = $1", session.sessionId);
      return rows[0]?.updated_at;
    };

    try {
      await db.importer.importSession(session, "claude");
      // The deriver-upgrade shape: identical session data, invocation rows
      // re-derived from scratch on the next import pass.
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        session.sessionId
      );
      clock = "2026-08-22T13:00:00.000Z";
      await db.importer.importSession(session, "claude");
      assert.equal(
        await readUpdatedAt(),
        clock,
        "the invocation-set change did not advance the sync watermark — a withheld parent would stay behind the cursor while its children queue"
      );

      clock = "2026-08-22T14:00:00.000Z";
      await db.importer.importSession(session, "claude");
      assert.equal(
        await readUpdatedAt(),
        "2026-08-22T13:00:00.000Z",
        "a byte-identical re-derivation bumped the watermark — every re-import would re-sync the whole corpus"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Run record group 8 against a session, the way the import pipeline does, and
 * hand back whatever it reported through the phase's log sink.
 */
async function runDerivedRollups(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  session: Parameters<typeof db.importer.importSession>[0]
): Promise<string[]> {
  const reported: string[] = [];
  await db.prisma.write((client) =>
    client.$transaction((tx) =>
      importPhaseDerivedRollups(
        tx,
        { session, now: NOW, log: (message) => reported.push(message) },
        async () => {
          // The last-activity recomputation is the caller's concern, not this
          // phase's; these cases grade the two cost columns.
        }
      )
    )
  );
  return reported;
}

/** Σ of the session's priced `token_usage` rows — the term both totals share. */
async function readTokenUsageCost(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ cost_usd: number | null }>
  >(
    "SELECT COALESCE(SUM(cost_usd_estimated), 0) AS cost_usd FROM token_usage WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.cost_usd ?? 0);
}

/**
 * The population the group-8 guard reads: how many `token_usage` rows the session
 * has, and how many of them carry a cost. Asserted as a PRECONDITION by the cases
 * below so each one pins the branch it means to exercise — a fixture that
 * silently stopped producing two rows, or produced one where it meant none, would
 * otherwise keep asserting on a branch it no longer reaches.
 */
async function readTokenUsagePricingCounts(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
): Promise<{ usageRows: number; pricedRows: number }> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ usage_rows: number | bigint; priced_rows: number | bigint }>
  >(
    `SELECT COUNT(*) AS usage_rows, COUNT(cost_usd_estimated) AS priced_rows
       FROM token_usage
      WHERE session_id = $1`,
    sessionId
  );
  return {
    usageRows: Number(rows[0]?.usage_rows ?? 0),
    pricedRows: Number(rows[0]?.priced_rows ?? 0),
  };
}

/** The two independently-derived session cost totals, read from their columns. */
async function readCostTotals(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
): Promise<{ sessionCostUsd: number | null; analyticsCostUsd: number | null }> {
  const sessions = await db.prisma.client.$queryRawUnsafe<
    Array<{ cost_usd_estimated: number | null }>
  >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", sessionId);
  const analytics = await db.prisma.client.$queryRawUnsafe<
    Array<{ est_cost: number | null }>
  >("SELECT est_cost FROM session_analytics WHERE session_id = $1", sessionId);
  return {
    sessionCostUsd: sessions[0]?.cost_usd_estimated ?? null,
    analyticsCostUsd: analytics[0]?.est_cost ?? null,
  };
}
