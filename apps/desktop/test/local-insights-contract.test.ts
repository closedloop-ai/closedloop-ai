import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
// FEA-3132: the heatmap/autonomy reads now GROUP BY the materialized
// session_turn_bucket; these tests seed sessions directly, so they must populate
// the buckets the same way production ingest does (rebuildSessionTurnBuckets in
// the rollup tx) before computing.
import { rebuildSessionTurnBuckets } from "../src/main/database/turn-buckets.js";
import { allocateRoundedUsdValues } from "../src/main/database/usd-allocation.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * Contract test for the Insights backend (`local-insights.ts`) on the single
 * `DesktopPrisma` client. The sqlite-conversion golden suite already pins exact
 * byte-for-byte section output against a seeded DB (run in CI, where the runtime +
 * electron load); this test is the ELECTRON-FREE companion that builds the Prisma
 * client straight from the migration runner (no `sqlite.ts`/electron import) so
 * it is verifiable in the dev sandbox too. It focuses on:
 *
 * - the TYPED `agent.groupBy` / `session.groupBy` reads (agentsByStatus /
 *   agentsByType / sessionsByStatus) produce the same keys / counts / desc order
 *   as the old `GROUP BY … ORDER BY n DESC` SQL, with a nullable `type` mapped to
 *   'unknown';
 * - aggregate INTEGER columns the Prisma raw path can surface as `bigint` come
 *   back as JS numbers through the `num()` / `token()` coercion boundary.
 */

// FEA-2430: the insights SQL buckets display days/hours in the process-local
// timezone (strftime 'localtime'), and eachDay() generates local axis keys —
// pin a fixed NON-UTC zone so the conversion is actively exercised (not an
// identity) and deterministic across machines/CI. America/Chicago is a real
// negative offset with DST. Runs at module evaluation, before any test opens
// a DB or reads a Date (same pattern as sqlite-conversion-golden's TZ=UTC).
process.env.TZ = "America/Chicago";

const NOW = new Date("2026-06-22T00:00:00.000Z"); // = June 21 19:00 CDT
const IN_WINDOW = "2026-06-20T10:00:00.000Z"; // = June 20 05:00 CDT (same local day)
// Cross-midnight instant: June 21 03:00 UTC = June 20 22:00 CDT — UTC and
// local calendar days DISAGREE, so any bucket that regresses to UTC misplaces it.
const CROSS_MIDNIGHT = "2026-06-21T03:00:00.000Z";

test("FEA-2430 TZ canary: process is pinned to America/Chicago", () => {
  // getTimezoneOffset is minutes behind UTC: CDT (June) = 300, CST = 360. A
  // loud failure here means the module-eval pin did not take and every
  // localtime assertion in this file would silently test the wrong zone.
  assert.equal(new Date("2026-06-20T10:00:00.000Z").getTimezoneOffset(), 300);
  assert.equal(new Date("2026-01-15T10:00:00.000Z").getTimezoneOffset(), 360);
});

test("FEA-3241: displayed USD allocation conserves signed cents deterministically", () => {
  assert.deepEqual(allocateRoundedUsdValues({}), {});
  assert.deepEqual(allocateRoundedUsdValues({ alpha: 0, zeta: 0 }), {
    alpha: 0,
    zeta: 0,
  });

  const positiveTie = allocateRoundedUsdValues({ zeta: 0.006, alpha: 0.006 });
  const reversedPositiveTie = allocateRoundedUsdValues({
    alpha: 0.006,
    zeta: 0.006,
  });
  assert.deepEqual(positiveTie, { zeta: 0, alpha: 0.01 });
  assert.deepEqual(reversedPositiveTie, { alpha: 0.01, zeta: 0 });

  const negativeTie = allocateRoundedUsdValues({
    zeta: -0.006,
    alpha: -0.006,
  });
  assert.deepEqual(negativeTie, { zeta: 0, alpha: -0.01 });

  const mixed = allocateRoundedUsdValues({
    negativeAlpha: -0.006,
    negativeZeta: -0.006,
    positiveAlpha: 0.004,
    positiveZeta: 0.004,
  });
  assert.deepEqual(mixed, {
    negativeAlpha: 0,
    negativeZeta: 0,
    positiveAlpha: 0,
    positiveZeta: 0,
  });

  const halfCent = allocateRoundedUsdValues({ negativeHalf: -0.005 });
  assert.equal(halfCent.negativeHalf, 0);
  assert.equal(Object.is(halfCent.negativeHalf, -0), false);

  // Simulates the direct KPI SUM differing from the grouped bucket SUM by
  // more than the ordinary fractional-remainder envelope.
  assert.deepEqual(
    allocateRoundedUsdValues({ zeta: 0.004, alpha: 0.004 }, 0.03),
    { zeta: 0.01, alpha: 0.02 }
  );
});

test("FEA-1791: local insights run on the single Prisma client against real libSQL", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-contract-");
  try {
    // Three in-window sessions: status completed×2, running×1.
    for (const [id, status] of [
      ["s1", "completed"],
      ["s2", "completed"],
      ["s3", "running"],
    ]) {
      await db.query(
        "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
        [id, status, IN_WINDOW, "2026-06-20T11:00:00.000Z"]
      );
      await db.query(
        `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
         VALUES ($1, $2, $3, $4)`,
        [id, IN_WINDOW, id === "s1" ? 1 : 0, 2.5]
      );
    }
    // Agents: status completed×2, running×1; type general×2, NULL×1.
    for (const [id, sessionId, status, type] of [
      ["a1", "s1", "completed", "general"],
      ["a2", "s1", "running", "general"],
      ["a3", "s2", "completed", null],
    ]) {
      await db.query(
        "INSERT INTO agents (id, session_id, status, type) VALUES ($1, $2, $3, $4)",
        [id, sessionId, status, type]
      );
    }
    // One tool event (Agents tool-runs KPI + Utilization eventsByType).
    await db.query(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["e1", "s1", "PreToolUse", "Bash", IN_WINDOW]
    );
    // Token usage (Agents tokens KPI / model breakdown) — BigInt columns plus
    // a REAL cost_usd_estimated that the FEA-2331 spend breakdown reads.
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 300, 100, 4.2)`,
      ["s1", "claude-sonnet-4-5"]
    );

    // --- Agents section: typed agent.groupBy reads ------------------------
    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    const agentsByStatus = present(agents.charts.agentsByStatus);
    assert.deepEqual(
      agentsByStatus.map((b) => [b.key, b.value]),
      // completed (2) before running (1) — the SQL's ORDER BY n DESC.
      [
        ["completed", 2],
        ["running", 1],
      ]
    );
    assert.equal(typeof agentsByStatus[0]?.value, "number");
    assert.deepEqual(
      present(agents.charts.agentsByType).map((b) => [b.key, b.value]),
      // type general (2) before the NULL group mapped to 'unknown' (1).
      [
        ["general", 2],
        ["unknown", 1],
      ]
    );
    // Token KPIs come back as numbers (bigint-coerced), models distinct = 1.
    const tokensKpi = agents.kpis.find((k) => k.key === "tokens");
    assert.equal(tokensKpi?.value, 400);
    assert.equal(typeof tokensKpi?.value, "number");
    assert.equal(agents.kpis.find((k) => k.key === "models")?.value, 1);
    assert.equal(agents.kpis.find((k) => k.key === "tool-runs")?.value, 1);
    // FEA-2331: the model breakdown ranks models by estimated SPEND (USD) from
    // cost_usd_estimated — NOT input+output tokens — as a float, not a token int.
    assert.deepEqual(
      agents.charts.modelBreakdown.map((b) => [b.key, b.value]),
      [["claude-sonnet-4-5", 4.2]]
    );
    // The over-time series carries the same spend metric (one in-window day).
    const spendDay = agents.charts.modelUsageOverTime.points.find(
      (point) => point.values["claude-sonnet-4-5"] !== undefined
    );
    assert.equal(spendDay?.values["claude-sonnet-4-5"], 4.2);

    // --- Utilization section: typed session.groupBy read ------------------
    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    assert.deepEqual(
      present(utilization.charts.sessionsByStatus).map((b) => [b.key, b.value]),
      [
        ["completed", 2],
        ["running", 1],
      ]
    );
    const sessionsKpi = utilization.kpis.find((k) => k.key === "sessions");
    assert.equal(sessionsKpi?.value, 3);
    assert.equal(typeof sessionsKpi?.value, "number");
    assert.equal(utilization.kpis.find((k) => k.key === "events")?.value, 1);

    // --- Delivery section: raw reads still run + coerce -------------------
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // No PR artifacts seeded (Captured PRs is unknown regardless, ISS-12902), but
    // the section must compute: cost sums token_usage.cost_usd_estimated ⋈
    // sessions (FEA-2346); only session s1 has a row (4.2), so total cost = 4.2.
    assert.equal(delivery.kpis.find((k) => k.key === "merged")?.value, null);
    const costKpi = delivery.kpis.find((k) => k.key === "cost");
    assert.equal(costKpi?.value, 4.2);
    assert.equal(typeof costKpi?.value, "number");
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3487: Agents token KPIs fold pre-compaction baseline_* like the cost KPI", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-compact-");
  try {
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["compact", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );
    // A Claude-Code context-compacted session: the CURRENT columns hold the
    // post-compaction subset, and `baseline_*` carries the pre-compaction
    // totals that were rolled off. `cost_usd_estimated` is already priced on
    // the EFFECTIVE total (current + baseline). Without the FEA-3487 fold the
    // token KPIs would report only the current subset while cost reflects all
    // incurred tokens — the two would disagree in one dashboard.
    await db.query(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens,
          baseline_input, baseline_output,
          baseline_cache_read, baseline_cache_write,
          cost_usd_estimated)
       VALUES ($1, $2, 100, 40, 10, 5, 1000, 400, 200, 100, 7.7)`,
      ["compact", "claude-sonnet-4-5"]
    );

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Quarter,
      NOW
    );
    // tokens = (input + baseline_input) + (output + baseline_output)
    //        = (100 + 1000) + (40 + 400) = 1540.
    assert.equal(agents.kpis.find((k) => k.key === "tokens")?.value, 1540);
    // input = 100 + 1000, output = 40 + 400.
    assert.equal(
      agents.kpis.find((k) => k.key === "input-tokens")?.value,
      1100
    );
    assert.equal(
      agents.kpis.find((k) => k.key === "output-tokens")?.value,
      440
    );
    // cache saved = (cache_read + baseline_cache_read)
    //             + (cache_write + baseline_cache_write)
    //             = (10 + 200) + (5 + 100) = 315.
    assert.equal(agents.kpis.find((k) => k.key === "cache-tokens")?.value, 315);
    // The token distribution chart reads the same folded columns.
    assert.deepEqual(
      present(agents.charts.tokenDistribution).map((b) => [b.key, b.value]),
      [
        ["input", 1100],
        ["output", 440],
        ["cache-read", 210],
        ["cache-write", 105],
      ]
    );
    // FEA-3497: the per-model `#` (token volume) over-time series folds the same
    // `baseline_*` columns, so the token chart agrees with the Tokens/Cache KPIs
    // and priced spend on a compacted session (summing only current columns would
    // under-report). Effective = (100+1000)+(40+400)+(10+200)+(5+100) = 1855.
    const tokenDay = present(agents.charts.modelTokensOverTime).points.find(
      (point) => point.values["claude-sonnet-4-5"] !== undefined
    );
    assert.equal(tokenDay?.values["claude-sonnet-4-5"], 1855);

    // The sibling cost KPI is priced on the effective total, so both surfaces
    // of the same dashboard now agree on the same compacted session.
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );
    assert.equal(delivery.kpis.find((k) => k.key === "cost")?.value, 7.7);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The conservation property below holds on a NON-STRADDLING population, and this
 * file's fixtures are all of that shape: every row passes one instant for both
 * `started_at` and `last_activity_at`, so the Delivery cost basis and the Agents
 * spend basis coincide and cannot be told apart. That is a real precondition
 * since ISS-10541, not an accident of the fixture, and the case immediately
 * after this one pins the other side of it (#7678 review, tamsinb).
 */
test("FEA-3241: model spend parts conserve to the once-rounded Delivery total", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-spend-");
  try {
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["spend", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );
    for (const [model, cost] of [
      ["model-a", 0.006],
      ["model-b", 0.005],
      ["model-c", 0.004],
    ] as const) {
      await db.query(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
         VALUES ($1, $2, 1, 1, $3)`,
        ["spend", model, cost]
      );
    }

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Quarter,
      NOW
    );
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );
    assert.deepEqual(
      agents.charts.modelBreakdown.map((bucket) => [bucket.key, bucket.value]),
      [
        ["model-a", 0.01],
        ["model-b", 0.01],
        ["model-c", 0],
      ]
    );

    const cost = delivery.kpis.find((kpi) => kpi.key === "cost")?.value;
    assert.equal(typeof cost, "number");
    const targetCents = Math.round(Number(cost) * 100);
    const breakdownCents = agents.charts.modelBreakdown.reduce(
      (sum, bucket) => sum + Math.round(bucket.value * 100),
      0
    );
    assert.equal(breakdownCents, targetCents);

    const spendDay = agents.charts.modelUsageOverTime.points.find(
      (point) => point.date === "2026-06-20"
    );
    assert.ok(spendDay);
    assert.deepEqual(spendDay.values, {
      "model-a": 0.01,
      "model-b": 0.01,
      "model-c": 0,
    });
    const dailyCents = Object.values(spendDay.values).reduce(
      (sum, value) => sum + Math.round(value * 100),
      0
    );
    assert.equal(dailyCents, targetCents);

    // A signed, net-negative day remains present and allocates the negative
    // residual deterministically instead of being dropped by positive-only
    // day-presence logic.
    const signedDay = "2026-06-19T10:00:00.000Z";
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["signed-spend", "completed", signedDay, "2026-06-19T11:00:00.000Z"]
    );
    for (const model of ["signed-alpha", "signed-zeta"]) {
      await db.query(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
         VALUES ($1, $2, 1, 1, -0.006)`,
        ["signed-spend", model]
      );
    }
    const signedAgents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Quarter,
      NOW
    );
    const negativeSpendDay = signedAgents.charts.modelUsageOverTime.points.find(
      (point) => point.date === "2026-06-19"
    );
    assert.ok(negativeSpendDay);
    assert.equal(negativeSpendDay.values["signed-alpha"], -0.01);
    assert.equal(negativeSpendDay.values["signed-zeta"], 0);
    assert.equal(
      Object.values(negativeSpendDay.values).reduce<number>(
        (sum, value) => sum + Math.round(present(value) * 100),
        0
      ),
      -1
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-10541: a straddling session prices into Delivery cost and out of the Agents model breakdown", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-straddle-");
  try {
    // Started a quarter BEFORE the window and last active INSIDE it. The
    // Delivery cost KPI bounds on last activity — ISS-10604's ruling names it
    // among the three reads it aligns — and the Agents section bounds on session
    // start, because the same ruling names agents-spend among the reads it
    // leaves alone. So this one row is inside one read and outside the other,
    // and the model parts do NOT conserve to the Delivery total for it.
    //
    // Asserted rather than described, because the comment on
    // `local-insights-delivery.ts`'s cost read claimed the opposite ("the same
    // source the Agents model charts read so the two cannot drift") for as long
    // as no fixture could contradict it.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $5)",
      [
        "straddler",
        "completed",
        "2026-01-05T10:00:00.000Z",
        IN_WINDOW,
        IN_WINDOW,
      ]
    );
    await db.query(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 10, 10, $3)`,
      ["straddler", "model-a", 1.5]
    );

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Quarter,
      NOW
    );
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );

    assert.equal(delivery.kpis.find((kpi) => kpi.key === "cost")?.value, 1.5);
    assert.deepEqual(
      agents.charts.modelBreakdown.map((bucket) => [bucket.key, bucket.value]),
      []
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3497: modelTokensOverTime sums input+output+cache per (day, model) and shares the spend series keys", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-tokens-");
  try {
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["tok", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );
    // opus outspends sonnet, so it leads the shared top-N ordering. Token totals
    // sum ALL four columns: input + output + cache read + cache write.
    // opus  → 10 + 20 + 30 + 40 = 100 ; sonnet → 1 + 2 + 3 + 4 = 10.
    await db.query(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, 'opus', 10, 20, 30, 40, 1.5),
              ($1, 'sonnet', 1, 2, 3, 4, 0.5)`,
      ["tok"]
    );

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Quarter,
      NOW
    );

    // Same top-N keys/order as the spend series, so the $/# toggle only swaps
    // y-values.
    const spendKeys = agents.charts.modelUsageOverTime.series.map((s) => s.key);
    const tokenKeys = agents.charts.modelTokensOverTime?.series.map(
      (s) => s.key
    );
    assert.deepEqual(tokenKeys, spendKeys);
    assert.deepEqual(spendKeys, ["opus", "sonnet"]);

    const tokenDay = agents.charts.modelTokensOverTime?.points.find(
      (point) => point.date === "2026-06-20"
    );
    assert.ok(tokenDay);
    assert.equal(tokenDay.values.opus, 100);
    assert.equal(tokenDay.values.sonnet, 10);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("activity heatmap buckets parsed turns by their own role — session flag and events corpus are ignored", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-turns-");
  try {
    // FEA-2641 Fix 4 (PM ruling): a HUMAN-steered session (is_human = 1) whose
    // transcript records 1 genuine human prompt and 2 assistant turns. The
    // split must come from the per-turn roles in metadata $.messages — NOT
    // from the session flag or the events corpus. Seed 5 contradictory
    // main-agent events at the same instant: the old event-density query
    // would have painted all 5 Human (is_human = 1, main agent) and scored
    // autonomy 0; per-turn attribution must report 1 Human / 2 Agent and
    // autonomy 200/3 regardless.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata, last_activity_at) VALUES ($1, $2, $3, $4, $5, $3)",
      [
        "h1",
        "completed",
        IN_WINDOW,
        "2026-06-20T11:00:00.000Z",
        JSON.stringify({
          messages: [
            { role: "human", timestamp: IN_WINDOW, text: "Build it." },
            { role: "assistant", timestamp: IN_WINDOW, text: "On it." },
            { role: "assistant", timestamp: IN_WINDOW, text: "Done." },
          ],
          // FEA-3597: agent buckets now come from the PARENT-attributed token
          // series, not from assistant `messages` rows. Two billable
          // round-trips, matching the two assistant turns above — so this
          // fixture still asserts 1 Human / 2 Agent rather than being weakened.
          tokenSeries: [
            { timestamp: IN_WINDOW, model: "m", input: 1, output: 1 },
            { timestamp: IN_WINDOW, model: "m", input: 1, output: 1 },
          ],
        }),
      ]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human)
       VALUES ($1, $2, 1)`,
      ["h1", IN_WINDOW]
    );
    await db.query(
      "INSERT INTO agents (id, session_id, type, parent_agent_id) VALUES ($1, $2, $3, $4)",
      ["h1-main", "h1", "general", null]
    );
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO events (id, session_id, agent_id, event_type, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [`ev-${i}`, "h1", "h1-main", "PostToolUse", IN_WINDOW]
      );
    }
    // A headless-SDK session (entrypoint "sdk-cli" — cron-scheduled review,
    // fleet agent, scripted `claude -p`) on a DIFFERENT local day. Its
    // role:"human" kickoff was injected programmatically, so BOTH of its
    // turns must attribute to Agent and its day must score 100% agentic.
    const CRON_DAY = "2026-06-19T12:00:00.000Z"; // June 19 07:00 CDT
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata, last_activity_at) VALUES ($1, $2, $3, $4, $5, $3)",
      [
        "cron1",
        "completed",
        CRON_DAY,
        "2026-06-19T12:10:00.000Z",
        JSON.stringify({
          entrypoint: "sdk-cli",
          messages: [
            { role: "human", timestamp: CRON_DAY, text: "Review PR #42." },
            {
              role: "assistant",
              timestamp: "2026-06-19T12:05:00.000Z",
              text: "Reviewed.",
            },
          ],
          // FEA-3597: the headless classifier still SUPPRESSES the human row,
          // but it no longer PROMOTES it to an agent row — agent units come
          // from the token series. Two entries keep this day at 2 Agent / 0
          // Human, so it still scores 100% agentic for the original reason.
          tokenSeries: [
            { timestamp: CRON_DAY, model: "m", input: 1, output: 1 },
            {
              timestamp: "2026-06-19T12:05:00.000Z",
              model: "m",
              input: 1,
              output: 1,
            },
          ],
        }),
      ]
    );

    // A scripted Codex session — since DATA_REVISION 13 the parser stores
    // session_meta.originator as the entrypoint, so exec-style launches
    // ("codex_exec", "claude-codex-exec") must classify headless exactly like
    // Claude's "sdk-cli" (the LIKE '%exec%' arm of the predicate).
    const CODEX_DAY = "2026-06-18T12:00:00.000Z"; // June 18 07:00 CDT
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata, last_activity_at) VALUES ($1, $2, $3, $4, $5, $3)",
      [
        "codex1",
        "completed",
        CODEX_DAY,
        "2026-06-18T12:10:00.000Z",
        JSON.stringify({
          entrypoint: "claude-codex-exec",
          messages: [
            { role: "human", timestamp: CODEX_DAY, text: "Review PR #7." },
            {
              role: "assistant",
              timestamp: "2026-06-18T12:04:00.000Z",
              text: "Reviewed.",
            },
          ],
          // FEA-3597: same as the sdk-cli seed above — suppression retained,
          // promotion gone, agent units sourced from the token series.
          tokenSeries: [
            { timestamp: CODEX_DAY, model: "m", input: 1, output: 1 },
            {
              timestamp: "2026-06-18T12:04:00.000Z",
              model: "m",
              input: 1,
              output: 1,
            },
          ],
        }),
      ]
    );
    // FEA-3132: materialize the turn buckets the heatmap/autonomy now read.
    await prisma.write((client) =>
      client.$transaction((tx) =>
        rebuildSessionTurnBuckets(tx, ["h1", "cron1", "codex1"])
      )
    );

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    const { cells } = present(utilization.charts.activityHeatmap);
    const humanTotal = cells.reduce((sum, cell) => sum + cell.human, 0);
    const agentTotal = cells.reduce((sum, cell) => sum + cell.agent, 0);
    // Interactive session: 1 human + 2 assistant turns — not the 5 Human the
    // old event-density split would have produced from the seeded events.
    // Headless sessions (sdk-cli + claude-codex-exec): 0 human + 2 agent each.
    assert.equal(humanTotal, 1);
    assert.equal(agentTotal, 6);
    for (const [day, label] of [
      ["2026-06-19", "sdk-cli"],
      ["2026-06-18", "codex exec"],
    ] as const) {
      const headlessCells = cells.filter((cell) => cell.day === day);
      assert.equal(
        headlessCells.reduce((sum, cell) => sum + cell.human, 0),
        0,
        `${label} kickoff must not paint a Human cell`
      );
      assert.equal(
        headlessCells.reduce((sum, cell) => sum + cell.agent, 0),
        2
      );
    }

    // The autonomy trend (Agents section) shares the SAME turn source, so the
    // same fixture must report the same attribution: 2 of 3 turns are the
    // agent's → 200/3 ≈ 66.7% (the old event split would score 0). Asserting
    // it here keeps the heatmap and autonomy SQL provably in lockstep.
    const agentsSection = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    const autonomyTrend = present(agentsSection.charts.autonomyTrend);
    const autonomyPoint = autonomyTrend.points.find(
      (point) => point.date === "2026-06-20"
    );
    assert.ok(autonomyPoint, "expected an autonomy point for the seeded day");
    const autonomyValue = autonomyPoint.values.autonomy;
    assert.ok(
      typeof autonomyValue === "number" &&
        Math.abs(autonomyValue - 200 / 3) < 1e-6,
      `expected ~66.7% agent-driven autonomy, got ${autonomyValue}`
    );
    // Headless sessions' days are fully agentic: their human-role kickoffs
    // count toward the agent share, not the human share.
    for (const day of ["2026-06-19", "2026-06-18"]) {
      assert.equal(
        autonomyTrend.points.find((point) => point.date === day)?.values
          .autonomy,
        100,
        `expected 100% agentic autonomy on ${day}`
      );
    }
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2346: Delivery Cost KPI reads token_usage, not session_analytics.est_cost (stale rollup + missing row)", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-cost-src-");
  try {
    // Session A: stale rollup — est_cost deliberately disagrees with
    // SUM(token_usage.cost_usd_estimated). If the KPI reads est_cost it will
    // report 100; the correct (token_usage-derived) answer is 18.03.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["stale", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 100)`,
      ["stale", IN_WINDOW]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 500, 200, 18.03)`,
      ["stale", "claude-opus-4-5"]
    );

    // Session B: token_usage exists but NO session_analytics row at all.
    // If the KPI reads session_analytics this session's cost is invisible.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["no-analytics", "completed", IN_WINDOW, "2026-06-20T12:00:00.000Z"]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 100, 50, 3.50)`,
      ["no-analytics", "claude-sonnet-4-5"]
    );

    // Session C: in the PRIOR window (before the 90-day current window) —
    // verifies the prior-window query also reads token_usage, not est_cost.
    // NOW is 2026-06-22, 90-day window starts ~2026-03-24, prior window is
    // [~2025-12-24, ~2026-03-24). Use 2026-01-15 to land firmly in prior.
    const PRIOR_WINDOW = "2026-01-15T10:00:00.000Z";
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["prior", "completed", PRIOR_WINDOW, "2026-01-15T11:00:00.000Z"]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 999)`,
      ["prior", PRIOR_WINDOW]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 200, 100, 7.00)`,
      ["prior", "claude-opus-4-5"]
    );

    // Sentinel session: older than priorStartIso (~2025-12-24) so the
    // hasFullPriorPeriod gate is true and reportDelta produces a real deltaPct.
    // No token_usage → contributes $0 to both windows.
    const SENTINEL_DATE = "2025-12-01T00:00:00.000Z";
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["sentinel", "completed", SENTINEL_DATE, SENTINEL_DATE]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 0)`,
      ["sentinel", SENTINEL_DATE]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );

    // Current-window cost: 18.03 (stale) + 3.50 (no-analytics) = 21.53.
    // If it read session_analytics.est_cost it would be 100 (only the stale
    // session has an analytics row; no-analytics session would be invisible).
    const costKpi = delivery.kpis.find((k) => k.key === "cost");
    assert.equal(costKpi?.value, 21.53);
    assert.equal(typeof costKpi?.value, "number");

    // Prior-window cost from token_usage: 7.00 (session "prior").
    // If the prior-window query read session_analytics.est_cost it would be
    // 999 and deltaPct would be ~ -98 instead of +208.
    // FEA-2895: pctDelta rounds to a whole percent —
    // Math.round(((21.53 - 7.00) / 7.00) * 100) = 208.
    assert.equal(costKpi?.deltaPct, 208);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2413: Delivery cost and Utilization sessions scale together across every time band", async () => {
  // The reported symptom was a cost card that stayed flat while the session
  // count dropped across the 7/30/90/all toggle — i.e. cost not scoped to the
  // selected window. FEA-2346 moved the cost KPI onto the windowed token_usage
  // join; this pins the acceptance: over a corpus whose spend is spread across
  // the bands, BOTH the Delivery `cost` KPI and the Utilization `sessions` KPI
  // must grow monotonically 7 ⊂ 30 ⊂ 90 ⊂ all — and stay consistent with each
  // other (both windowed on sessions.started_at).
  const { dir, db, prisma } = await openInsightsDb("local-insights-fea2413-");
  try {
    // NOW = 2026-06-22. Each session's started_at is chosen to land inside a
    // specific band and its spend is distinct so a leaked (unwindowed) sum is
    // detectable. (in 7d, in 30d, in 90d, only-in-all).
    const seed = async (
      id: string,
      startedAt: string,
      cost: number
    ): Promise<void> => {
      await db.query(
        "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, 'completed', $2, $2, $2)",
        [id, startedAt]
      );
      await db.query(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
         VALUES ($1, 'claude-opus-4-5', 100, 50, $2)`,
        [id, cost]
      );
    };
    await seed("d3", "2026-06-19T10:00:00.000Z", 10); // 7 / 30 / 90 / all
    await seed("d20", "2026-06-02T10:00:00.000Z", 5); // 30 / 90 / all
    await seed("d60", "2026-04-23T10:00:00.000Z", 3); // 90 / all
    await seed("d200", "2025-12-04T10:00:00.000Z", 1); // all only

    const costFor = async (period: InsightsPeriod): Promise<number> => {
      const delivery = await computeLocalInsights(
        prisma,
        InsightsSection.Delivery,
        period,
        NOW
      );
      return delivery.kpis.find((k) => k.key === "cost")?.value as number;
    };
    const sessionsFor = async (period: InsightsPeriod): Promise<number> => {
      const util = await computeLocalInsights(
        prisma,
        InsightsSection.Utilization,
        period,
        NOW
      );
      return util.kpis.find((k) => k.key === "sessions")?.value as number;
    };

    // Cost scales with the window (each band adds exactly the in-band spend).
    assert.equal(await costFor(InsightsPeriod.Week), 10);
    assert.equal(await costFor(InsightsPeriod.Month), 15);
    assert.equal(await costFor(InsightsPeriod.Quarter), 18);
    assert.equal(await costFor(InsightsPeriod.All), 19);

    // Session count scales the same way — cost and count stay internally
    // consistent (this is the "cost flat while count drops" bug's guard).
    assert.equal(await sessionsFor(InsightsPeriod.Week), 1);
    assert.equal(await sessionsFor(InsightsPeriod.Month), 2);
    assert.equal(await sessionsFor(InsightsPeriod.Quarter), 3);
    assert.equal(await sessionsFor(InsightsPeriod.All), 4);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2430: cross-midnight activity buckets to the LOCAL day/hour across all storage owners", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-tz-");
  try {
    // One seed per STORAGE OWNER at the same cross-midnight instant (June 21
    // 03:00 UTC = June 20 22:00 CDT), so every day-bucketed chart family is
    // proven local, not just the event-backed ones:
    //   1. sessions.started_at        → perDay, toolsOverTime, modelUsageOverTime
    //   2. events.created_at          → eventsPerDay
    //   2b. metadata $.messages ts    → heatmap (day+hour), autonomy (FEA-2641
    //       Fix 4: turn-based; one assistant turn at the same instant)
    //   3. artifacts COALESCE         → prTrend, klocTrend
    // (4. token_events.created_at is covered in dashboard-queries-contract.)
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata, last_activity_at) VALUES ($1, $2, $3, $4, $5, $3)",
      [
        "night",
        "completed",
        CROSS_MIDNIGHT,
        "2026-06-21T04:00:00.000Z",
        JSON.stringify({
          messages: [{ role: "assistant", timestamp: CROSS_MIDNIGHT }],
          // FEA-3597: the agent bucket this guard asserts now comes from the
          // PARENT-attributed token series, not the assistant `messages` row.
          // Re-seeded at the SAME cross-midnight instant so the FEA-2430
          // contract still bites — this is the only assertion pinning that the
          // read path buckets on the LOCAL day/hour rather than UTC, and
          // dropping it would silently un-pin timezone correctness.
          tokenSeries: [
            { timestamp: CROSS_MIDNIGHT, model: "m", input: 1, output: 1 },
          ],
        }),
      ]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human)
       VALUES ($1, $2, 0)`,
      ["night", CROSS_MIDNIGHT]
    );
    await db.query(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["night-ev", "night", "PostToolUse", "Bash", CROSS_MIDNIGHT]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 100, 50, 1.5)`,
      ["night", "claude-sonnet-4-5"]
    );
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          observed_at, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', 9, $3, $3, $3)`,
      ["night-pr", "pr:org/repo:9", CROSS_MIDNIGHT]
    );
    // FEA-3132: materialize the turn buckets the heatmap/autonomy now read.
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ["night"]))
    );

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    // Owner 2b (metadata $.messages timestamp): heatmap cell lands on the
    // LOCAL day at the LOCAL hour (22:00 CDT), not UTC day June 21 hour 03.
    const heatmap = present(utilization.charts.activityHeatmap);
    const cell = heatmap.cells.find(
      (c) => c.day === "2026-06-20" && c.hour === 22
    );
    assert.ok(cell, "expected heatmap cell at 2026-06-20 hour 22 (local)");
    assert.equal(cell.agent, 1);
    assert.equal(
      heatmap.cells.some((c) => c.day === "2026-06-21" && c.hour === 3),
      false,
      "no cell may appear at the UTC day/hour"
    );
    // Axis lockstep: the SQL's local day key must exist in eachDay()'s axis,
    // and the axis must end on the LOCAL day of NOW (June 21 CDT, not June 22).
    const { days } = heatmap;
    assert.ok(days.includes("2026-06-20"), "axis must contain the local day");
    assert.equal(days.at(-1), "2026-06-21");
    // Owner 1 (sessions.started_at): sessions-per-day trend.
    const sessionPoint = utilization.charts.eventActivity.points.find(
      (p) => p.date === "2026-06-20"
    );
    assert.equal(sessionPoint?.values.sessions, 1);
    assert.equal(
      utilization.charts.eventActivity.points.find(
        (p) => p.date === "2026-06-21"
      )?.values.sessions,
      0
    );
    // Owner 2 again via the events-per-day trend.
    const eventPoint = present(utilization.charts.eventVolume).points.find(
      (p) => p.date === "2026-06-20"
    );
    assert.equal(eventPoint?.values.events, 1);

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    // Owner 1: tool runs + model spend bucket by s.started_at → local June 20.
    assert.equal(
      present(agents.charts.toolRunsOverTime).points.find(
        (p) => p.date === "2026-06-20"
      )?.values["tool-runs"],
      1
    );
    assert.equal(
      agents.charts.modelUsageOverTime.points.find(
        (p) => p.date === "2026-06-20"
      )?.values["claude-sonnet-4-5"],
      1.5
    );
    // Owner 2b: lone assistant turn → 100% agent-driven on the local day.
    assert.equal(
      present(agents.charts.autonomyTrend).points.find(
        (p) => p.date === "2026-06-20"
      )?.values.autonomy,
      100
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // Owner 3 (artifacts COALESCE(observed_at, created_at)): PR trend.
    assert.equal(
      delivery.charts.prTrend.points.find((p) => p.date === "2026-06-20")
        ?.values.merged,
      1
    );
    assert.equal(
      delivery.charts.prTrend.points.find((p) => p.date === "2026-06-21")
        ?.values.merged,
      0
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3091: events-per-day counts events by their own time, even when the parent session started before the trend window", async () => {
  // A session that began BEFORE the trend-window start but keeps emitting events
  // inside it must count on the event's local day — matching web's
  // fetchEventVolume (filters `e.event_created_at BETWEEN trendStart AND end`)
  // and the bucket field localDay(e.created_at). The old query scoped by
  // s.started_at, so this session was fully excluded, depressing the left edge.
  const { dir, db, prisma } = await openInsightsDb("local-insights-evwin-");
  try {
    // period "90" → trendStart = NOW - 90d = 2026-03-24. Session started well
    // before that (Jan 1), event lands IN_WINDOW (June 20).
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["long-runner", "completed", "2026-01-01T00:00:00.000Z", IN_WINDOW]
    );
    await db.query(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["late-ev", "long-runner", "PostToolUse", "Bash", IN_WINDOW]
    );

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    // Bucketed on the event's local day (June 20 CDT), and counted despite the
    // session's Jan 1 start being outside the trend window.
    assert.equal(
      present(utilization.charts.eventVolume).points.find(
        (p) => p.date === "2026-06-20"
      )?.values.events,
      1
    );
    // The session itself (started Jan 1) contributes no sessions-per-day point
    // inside the window — confirming the two series legitimately scope on
    // different columns now.
    assert.equal(
      utilization.charts.eventActivity.points.find(
        (p) => p.date === "2026-06-20"
      )?.values.sessions,
      0
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2430: DST transitions bucket by true local wall-clock (fall-back collapse, spring-forward gap)", async () => {
  // Raw-SQL characterization (attribution-day-bucketing style): the production
  // bucket expression against the two America/Chicago DST boundaries in 2026.
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-dst-"));
  const { db } = await openMigrationDatabase(path.join(dir, "dst.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS dst_events (
        id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    await db.query(
      `INSERT INTO dst_events (id, created_at) VALUES
         ('fallback-cdt', '2026-11-01T06:30:00.000Z'),
         ('fallback-cst', '2026-11-01T07:30:00.000Z'),
         ('springfwd',    '2026-03-08T08:30:00.000Z')`
    );
    const rows = await db.query<{ id: string; day: string; hour: number }>(
      `SELECT id,
              strftime('%Y-%m-%d', created_at, 'localtime') AS day,
              CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour
       FROM dst_events ORDER BY id`
    );
    const byId = new Map(
      rows.rows.map((r) => [r.id, { day: r.day, hour: Number(r.hour) }])
    );
    // Fall-back: 06:30Z is 01:30 CDT (UTC-5) and 07:30Z is 01:30 CST (UTC-6) —
    // two distinct UTC hours collapse into the same local day+hour bucket.
    assert.deepEqual(byId.get("fallback-cdt"), { day: "2026-11-01", hour: 1 });
    assert.deepEqual(byId.get("fallback-cst"), { day: "2026-11-01", hour: 1 });
    // Spring-forward: 02:xx local does not exist on 2026-03-08; 08:30Z resolves
    // to 03:30 CDT (UTC-5 after the jump), never to a phantom hour 2.
    assert.deepEqual(byId.get("springfwd"), { day: "2026-03-08", hour: 3 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5828: local Delivery withholds default-sensitive branch coverage without account authority", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-fea3455-");
  try {
    // Session required by the session_artifact_link FK constraint.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["fea3455-session", "completed", IN_WINDOW, IN_WINDOW]
    );
    // 3 captured PRs, 2 of them authored in-session. No PR state is stored
    // (ISS-12709), so prByState is empty rather than a fabricated
    // "Captured locally" bucket of 3.
    for (const [id, prNum] of [
      ["fea3455-m1", 1],
      ["fea3455-m2", 2],
      ["fea3455-open", 3],
    ] as [string, number][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number,
            created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
        [id, `pr:fea3455:${prNum}`, prNum, IN_WINDOW]
      );
    }
    for (const [linkId, artifactId] of [
      ["sal-fea3455-m1", "fea3455-m1"],
      ["sal-fea3455-m2", "fea3455-m2"],
    ] as [string, string][]) {
      await db.query(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          linkId,
          "fea3455-session",
          artifactId,
          ArtifactRefRelation.Created,
          ArtifactRefMethod.PrCreateOutput,
          "{}",
          1,
          IN_WINDOW,
          IN_WINDOW,
        ]
      );
    }
    // 3 branch artifacts: feature-a (has a PR row), feature-b (no PR row), and
    // the default branch main (excluded — you don't open a PR from main). So the
    // real branchesWithoutPr split is has-pr=1, no-pr=1, replacing the fabricated
    // {has-pr: captured, no-pr: 0} that always painted 100% "has a PR".
    for (const [id, branchName] of [
      ["br-a", "feature-a"],
      ["br-b", "feature-b"],
      ["br-main", "main"],
    ] as [string, string][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name,
            created_at, last_seen_at)
         VALUES ($1, $2, 'branch', 'org/repo', $3, $4, $4)`,
        [id, `branch:fea3455:${branchName}`, branchName, IN_WINDOW]
      );
    }
    // pull_requests lifecycle row makes feature-a "has a PR" via the canonical
    // (repo_full_name, branch_name) mapping.
    await db.query(
      `INSERT INTO pull_requests
         (id, pr_url, pr_number, repo_full_name, branch_name)
       VALUES ($1, $2, $3, 'org/repo', 'feature-a')`,
      ["pr-lifecycle-a", "https://github.com/org/repo/pull/1", 1]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    assert.deepEqual(delivery.charts.prByState, []);
    assert.deepEqual(delivery.charts.branchesWithoutPr, []);
    // checkStatus omitted (no local CI signal) and its tile Unavailable.
    assert.equal(delivery.charts.checkStatus, undefined);
    assert.equal(
      delivery.tileAvailability?.["chart:checkStatus"],
      "unavailable"
    );
    assert.equal(
      delivery.tileAvailability?.["chart:branchesWithoutPr"],
      "unavailable"
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3537: agent-pipeline graph rolls up nodes by type and edges by parent→child hand-off", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-contract-");
  try {
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["sp", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );
    // One orchestrator spawns two reviewers (one completed, one errored). Node
    // type resolves via COALESCE(subagent_type, type, 'unknown'); the edge via
    // the parent_agent_id self-join.
    for (const [id, status, type, subagentType, parentId] of [
      ["m1", "completed", "orchestrator", null, null],
      ["c1", "completed", "subagent", "reviewer", "m1"],
      ["c2", "error", "subagent", "reviewer", "m1"],
    ] as const) {
      await db.query(
        "INSERT INTO agents (id, session_id, status, type, subagent_type, parent_agent_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, "sp", status, type, subagentType, parentId]
      );
    }

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    const pipeline = agents.charts.agentPipeline;
    assert.ok(pipeline, "agentPipeline should be present");
    const reviewer = pipeline.nodes.find((n) => n.subagentType === "reviewer");
    assert.equal(reviewer?.total, 2);
    assert.equal(reviewer?.completed, 1);
    assert.equal(reviewer?.errors, 1);
    assert.equal(reviewer?.sessions, 1);
    // 1 completed of 2 finished ⇒ 50%.
    assert.equal(reviewer?.successRate, 50);
    const orchestrator = pipeline.nodes.find(
      (n) => n.subagentType === "orchestrator"
    );
    assert.equal(orchestrator?.total, 1);
    assert.equal(orchestrator?.successRate, 100);
    // Both children hand off from the orchestrator ⇒ one weighted edge.
    assert.deepEqual(pipeline.edges, [
      { source: "orchestrator", target: "reviewer", weight: 2 },
    ]);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Narrow an additive chart (or per-series bucket value) the local backend ALWAYS
 * emits. The shared `@closedloop-ai/loops-api` contract types these optional/nullable
 * only so older peers may omit them; absent HERE is a contract regression.
 */
function present<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error("local insights must emit this value");
  }
  return value;
}
