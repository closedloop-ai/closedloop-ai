import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * Contract test for `createSqliteDashboardQueries` on the single `DesktopPrisma`
 * client. Like the session/agent/event store contract tests, this runs through
 * `openSqliteAgentDatabase` (the runtime + electron load), so it is a CI guard —
 * the dev sandbox does not download the electron binary. The
 * `sqlite-conversion-golden` suite already pins `getTokenAnalytics` byte-for-byte,
 * and `sqlite-agent-dashboard-database` exercises `getWorkflowData` /
 * `getCoreFeatures` / large-sum coercion; this test fills the gaps those leave:
 *
 * - the TYPED counts/aggregate in `getSummary` (total/active session counts via
 *   `session.count` + the terminal-status `notIn` filter, COUNT(DISTINCT
 *   event_type) via `event.groupBy().length`, SUM via `tokenUsage.aggregate`
 *   coerced to a JS number, and the `session.findMany` recent-sessions ordering);
 * - the TYPED `event.groupBy` / `agent.groupBy` / `session.groupBy` rollups in
 *   `getAnalytics` reproduce the old `ORDER BY count DESC` (JS sort) and map a
 *   nullable agent `type` to 'unknown';
 * - `getSkills`, now a TYPED two-read (events + a keyed sessions lookup) standing
 *   in for the old `events LEFT JOIN sessions` (the Event model has no Prisma
 *   relation to Session), still yields a null → 'unknown' harness for a Skill
 *   event whose session row is absent — the outer join's NULL semantics.
 */

// FEA-2430: getTokenAnalytics/getAnalytics bucket display days in the
// process-local timezone (strftime 'localtime') and window token analytics
// over local calendar days — pin a fixed non-UTC zone so the conversion is
// actively exercised and deterministic across machines/CI (golden-test
// pattern). Runs at module evaluation, before any test opens a DB.
process.env.TZ = "America/Chicago";

const NOW = "2026-06-22T00:00:00.000Z"; // = June 21 19:00 CDT
const T1 = "2026-06-20T10:00:00.000Z";
const T2 = "2026-06-20T11:00:00.000Z";
const T3 = "2026-06-20T12:00:00.000Z";

test("FEA-1791: dashboard queries run on the single Prisma client against real libSQL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-queries-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    // Sessions: completed×2, running×1; only s1 carries plan metadata.
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, metadata)
       VALUES ($1, $2, $3, $4, $4, $5, $6)`,
      "s1",
      "Session one",
      "completed",
      T1,
      "claude",
      JSON.stringify({
        plans: [
          {
            content: "## Ship it\n\n- step",
            source: "claude",
            timestamp: T1,
          },
        ],
      })
    );
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s2",
      "Session two",
      "completed",
      T2,
      "codex"
    );
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s3",
      "Session three",
      "running",
      T3,
      "claude"
    );

    // Agents: status completed×2, running×1; type general×2, NULL×1.
    for (const [id, sessionId, status, type] of [
      ["a1", "s1", "completed", "general"],
      ["a2", "s1", "running", null],
      ["a3", "s2", "completed", "general"],
    ]) {
      await db.run(
        "INSERT INTO agents (id, session_id, status, type) VALUES ($1, $2, $3, $4)",
        id,
        sessionId,
        status,
        type
      );
    }

    // Events: event_type PreToolUse×4 (3 tool-bearing) + Stop×1 (null tool).
    // Two Skill events — one on s1 (harness 'claude'), one on a session row that
    // does NOT exist ('ghost') to exercise the LEFT-JOIN-null harness path.
    const events: [string, string, string, string | null, string | null][] = [
      ["e1", "s1", "PreToolUse", "Bash", null],
      ["e2", "s1", "PreToolUse", "Read", null],
      ["e3", "s2", "Stop", null, null],
      [
        "e4",
        "s1",
        "PreToolUse",
        "Skill",
        JSON.stringify({ skillName: "core/foo" }),
      ],
      [
        "e5",
        "ghost",
        "PreToolUse",
        "Skill",
        JSON.stringify({ skillName: "ghost/bar" }),
      ],
    ];
    for (const [id, sessionId, eventType, toolName, data] of events) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        id,
        sessionId,
        eventType,
        toolName,
        data,
        T2
      );
    }

    await db.run(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 300, 100, 3.5)`,
      "s1",
      "claude-sonnet-4-5"
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 300, 100, 0, 0, 3.5)`,
      "s1",
      "claude-sonnet-4-5",
      T1
    );

    // --- getSummary: typed counts / aggregate / findMany --------------------
    const summary = await db.dashboard.getSummary();
    assert.equal(summary.totalSessions, 3);
    // notIn(terminal) keeps only the running session.
    assert.equal(summary.activeSessions, 1);
    assert.equal(summary.totalAgents, 3);
    assert.equal(summary.totalEvents, 5);
    // COUNT(DISTINCT event_type) = {PreToolUse, Stop}.
    assert.equal(summary.eventTypeCount, 2);
    // SUM(input + output), coerced from BigInt to a JS number.
    assert.equal(summary.totalTokens, 400);
    assert.equal(typeof summary.totalTokens, "number");
    // started_at DESC, capped at 10.
    assert.deepEqual(
      summary.recentSessions.map((s) => s.id),
      ["s3", "s2", "s1"]
    );

    // --- getAnalytics: typed groupBy rollups with DESC ordering -------------
    const analytics = await db.dashboard.getAnalytics(new Date(NOW));
    assert.deepEqual(
      analytics.eventsByType.map((r) => [r.eventType, r.count]),
      [
        ["PreToolUse", 4],
        ["Stop", 1],
      ]
    );
    assert.equal(typeof analytics.eventsByType[0]?.count, "number");
    // COALESCE(type, 'unknown') + ORDER BY count DESC.
    assert.deepEqual(
      analytics.agentsByType.map((r) => [r.type, r.count]),
      [
        ["general", 2],
        ["unknown", 1],
      ]
    );
    const sessionStatus = new Map(
      analytics.sessionsByStatus.map((r) => [r.status, r.count])
    );
    assert.equal(sessionStatus.get("completed"), 2);
    assert.equal(sessionStatus.get("running"), 1);
    const agentStatus = new Map(
      analytics.agentsByStatus.map((r) => [r.status, r.count])
    );
    assert.equal(agentStatus.get("completed"), 2);
    assert.equal(agentStatus.get("running"), 1);
    assert.equal(analytics.totalSessions, 3);
    assert.equal(analytics.totalAgents, 3);
    assert.equal(analytics.totalEvents, 5);
    assert.equal(analytics.tokens.totalInputTokens, 300);
    assert.equal(typeof analytics.tokens.totalInputTokens, "number");
    // FEA-2331: byModel also surfaces per-model estimated spend (USD) from
    // cost_usd_estimated, rounded to cents.
    assert.deepEqual(
      analytics.tokens.byModel.map((r) => [r.model, r.estimatedCostUsd]),
      [["claude-sonnet-4-5", 3.5]]
    );

    // --- getSkills: typed two-read keeps the LEFT-JOIN null harness ---------
    const skills = await db.dashboard.getSkills();
    const skillByName = new Map(skills.map((s) => [s.name, s.harness]));
    // Skill on s1 → harness from the session row.
    assert.equal(skillByName.get("core/foo"), "claude");
    // Skill on a missing session row → null harness folds to 'unknown'.
    assert.equal(skillByName.get("ghost/bar"), "unknown");

    // --- getTools: raw COUNT(DISTINCT session_id) coerced to numbers --------
    const tools = await db.dashboard.getTools();
    const skillTool = tools.find((t) => t.toolName === "Skill");
    assert.equal(skillTool?.invocationCount, 2);
    // Distinct sessions: s1 + the ghost session id.
    assert.equal(skillTool?.sessionCount, 2);
    assert.equal(typeof skillTool?.invocationCount, "number");

    // --- getWorkflowData: typed subagent/main counts ------------------------
    const workflow = await db.dashboard.getWorkflowData();
    // No subagents seeded (no parent links, no 'subagent' type).
    assert.equal(workflow.stats.totalSubagents, 0);
    // All three agents are roots that are not subagents.
    assert.equal(workflow.orchestration.mainCount, 3);

    // --- getPlans: typed metadata-not-null findMany -------------------------
    const plans = await db.dashboard.getPlans();
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.sessionId, "s1");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// metrics-mira WRONG_DENOMINATOR: the headline stats.successRate and the
// per-type effectiveness[].successRate must use the same definition —
// completed / (completed + errors) — so in-flight agents never dilute one rate
// but not the other. Before the fix the per-type rate divided by the full agent
// count (including running agents), so a type with in-flight work reported a
// rate that contradicted the headline.
test("orchestration dashboard success rate excludes running agents and agrees headline vs per-type", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-successrate-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      "s1",
      "s1",
      "running",
      T1,
      T2,
      "claude"
    );
    // One subagent type 'worker': completed×2, error×1, running×1. The single
    // running agent must NOT count toward the success-rate denominator.
    for (const [id, status] of [
      ["w1", "completed"],
      ["w2", "completed"],
      ["w3", "error"],
      ["w4", "running"],
    ]) {
      await db.run(
        `INSERT INTO agents (id, session_id, status, type, subagent_type)
         VALUES ($1, $2, $3, 'subagent', 'worker')`,
        id,
        "s1",
        status
      );
    }

    const workflow = await db.dashboard.getWorkflowData();
    const worker = workflow.effectiveness.find(
      (e) => e.subagentType === "worker"
    );
    assert.ok(worker, "expected a 'worker' effectiveness row");
    // completed / (completed + errors) = 2 / 3, NOT completed / count (2 / 4).
    assert.ok(
      Math.abs(worker.successRate - (2 / 3) * 100) < 1e-9,
      `per-type rate should be 66.6…%, got ${worker.successRate}`
    );
    // Headline and per-type share one definition, so they agree exactly.
    assert.equal(workflow.stats.successRate, worker.successRate);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2345: getTokenAnalytics sources all facets from token_events over a 30-calendar-day window", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-analytics-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const REF = "2026-06-22T00:00:00.000Z";
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => REF,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s1",
      "Session one",
      "completed",
      "2026-06-20T10:00:00.000Z",
      "claude"
    );

    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 1000, 500, 200, 50, 1.25)`,
      "s1",
      "claude-sonnet-4-5",
      "2026-06-20T10:00:00.000Z"
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 2000, 1000, 300, 100, 2.50)`,
      "s1",
      "claude-sonnet-4-5",
      "2026-06-21T14:00:00.000Z"
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 9999, 9999, 9999, 9999, 99.99)`,
      "s1",
      "claude-sonnet-4-5",
      "2026-05-01T10:00:00.000Z"
    );

    const ta = await db.dashboard.getTokenAnalytics(new Date(REF));

    const byDayInputSum = ta.byDay.reduce((s, d) => s + d.inputTokens, 0);
    const byDayOutputSum = ta.byDay.reduce((s, d) => s + d.outputTokens, 0);
    assert.equal(byDayInputSum, ta.totalInputTokens);
    assert.equal(byDayOutputSum, ta.totalOutputTokens);

    assert.equal(ta.totalInputTokens, 3000);
    assert.equal(ta.totalOutputTokens, 1500);
    assert.equal(ta.totalCacheReadTokens, 500);
    assert.equal(ta.totalCacheWriteTokens, 150);
    assert.equal(ta.windowDays, 30);

    assert.equal(ta.byDay.length, 2);
    assert.equal(ta.byDay[0]?.day, "2026-06-20");
    assert.equal(ta.byDay[1]?.day, "2026-06-21");

    assert.equal(ta.byModel.length, 1);
    assert.equal(ta.byModel[0]?.model, "claude-sonnet-4-5");
    assert.equal(ta.byModel[0]?.inputTokens, 3000);
    assert.equal(ta.byModel[0]?.sessions, 1);
    assert.equal(ta.byModel[0]?.estimatedCostUsd, 3.75);

    const farFuture = new Date("2026-12-01T00:00:00.000Z");
    const taEmpty = await db.dashboard.getTokenAnalytics(farFuture);
    assert.equal(taEmpty.totalInputTokens, 0);
    assert.equal(taEmpty.totalOutputTokens, 0);
    assert.equal(taEmpty.byDay.length, 0);
    assert.equal(taEmpty.byModel.length, 0);
    assert.equal(taEmpty.windowDays, 30);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2430: token analytics bucket and window by LOCAL calendar days (cross-midnight + both edges)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-analytics-tz-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const REF = "2026-06-22T00:00:00.000Z"; // June 21 19:00 CDT
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => REF,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s-tz",
      "TZ session",
      "completed",
      "2026-06-20T10:00:00.000Z",
      "claude"
    );
    // Local 30-day window for REF: [May 23 00:00 CDT, June 21 23:59:59.999 CDT]
    // = [2026-05-23T05:00:00.000Z, 2026-06-22T04:59:59.999Z].
    const seeds: [string, number][] = [
      // Cross-midnight: June 21 03:00Z = June 20 22:00 CDT → LOCAL day June 20.
      ["2026-06-21T03:00:00.000Z", 100],
      // Lower edge: May 23 12:00Z = May 23 07:00 CDT — inside the LOCAL window
      // (a UTC-day window starting 2026-05-24 would wrongly exclude it).
      ["2026-05-23T12:00:00.000Z", 40],
      // Upper edge: June 22 05:30Z = June 22 00:30 CDT — AFTER local end-of-
      // today (a UTC-day window ending 2026-06-22T23:59:59 would include it).
      ["2026-06-22T05:30:00.000Z", 7777],
    ];
    for (const [ts, input] of seeds) {
      await db.run(
        `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
        "s-tz",
        "claude-sonnet-4-5",
        ts,
        input
      );
    }
    // dailyEvents (getAnalytics) shares the localtime day contract: the same
    // cross-midnight instant must land on the LOCAL day June 20.
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ($1, $2, $3, $4)`,
      "ev-tz",
      "s-tz",
      "PostToolUse",
      "2026-06-21T03:00:00.000Z"
    );

    const ta = await db.dashboard.getTokenAnalytics(new Date(REF));
    const days = new Map(ta.byDay.map((d) => [d.day, d.inputTokens]));
    // Cross-midnight event buckets to its local day, not the UTC day.
    assert.equal(days.get("2026-06-20"), 100);
    assert.equal(days.has("2026-06-21"), false);
    // Lower-edge event is inside the local window on its local day.
    assert.equal(days.get("2026-05-23"), 40);
    // Upper-edge event (local tomorrow) is excluded from window AND totals.
    assert.equal(days.has("2026-06-22"), false);
    assert.equal(ta.totalInputTokens, 140);

    const analytics = await db.dashboard.getAnalytics(new Date(REF));
    const daily = new Map(analytics.dailyEvents.map((d) => [d.date, d.count]));
    assert.equal(daily.get("2026-06-20"), 1);
    assert.equal(daily.has("2026-06-21"), false);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2345: runTokenParityCheck compares stores and excludes OTel rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-parity-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s1",
      "S1",
      "completed",
      T1,
      "claude"
    );
    await db.run(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, $2, 300, 100, 50, 10)`,
      "s1",
      "claude-sonnet-4-5"
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, $2, $3, 300, 100, 50, 10)`,
      "s1",
      "claude-sonnet-4-5",
      T1
    );

    const agreeing = await db.runTokenParityCheck();
    assert.equal(agreeing.usageInput, agreeing.eventsInput);
    assert.equal(agreeing.divergentSessionCount, 0);

    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s-div",
      "Divergent",
      "completed",
      T2,
      "claude"
    );
    await db.run(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, $2, 500, 200, 0, 0)`,
      "s-div",
      "claude-sonnet-4-5"
    );

    const divergent = await db.runTokenParityCheck();
    assert.ok(divergent.usageInput > divergent.eventsInput);
    assert.ok(divergent.divergentSessionCount > 0);

    await db.run(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usage_source)
       VALUES ($1, $2, 9999, 9999, 0, 0, 'otel_log_payload')`,
      "s-otel",
      "claude-sonnet-4-5"
    );
    const afterOtel = await db.runTokenParityCheck();
    assert.equal(afterOtel.usageInput, divergent.usageInput);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
