import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSqliteDashboardQueries } from "../src/main/database/dashboard-queries.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  emptyExpectedByModelRows,
  projectTokenAnalyticsByModelRows,
  tokenAnalyticsByModelRow,
} from "./fixtures/analytics-golden.js";

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
 * - `getSkills`, now a RAW `events LEFT JOIN sessions` aggregate (the Event
 *   model has no Prisma relation to Session), still yields a null → 'unknown'
 *   harness for a Skill event whose session row is absent — the outer join's
 *   NULL semantics.
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
      "inactive",
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
      "inactive",
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
    // `getSummary` is hoisted onto the database handle itself, not onto the
    // `dashboard` sub-object (sqlite.ts wires `getSummary: () =>
    // dashboard.getSummary()`); the runtime object carried both, so calling it
    // off `dashboard` type-checked as `any` before this project existed.
    const summary = await db.getSummary();
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
    assert.equal(sessionStatus.get("inactive"), 2);
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
      projectTokenAnalyticsByModelRows(analytics.tokens.byModel),
      [
        tokenAnalyticsByModelRow({
          model: "claude-sonnet-4-5",
          inputTokens: 300,
          outputTokens: 100,
          sessions: 1,
          estimatedCostUsd: 3.5,
        }),
      ]
    );

    // --- getSkills: the SQL aggregate keeps the LEFT-JOIN null harness ------
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

// Goal stage 1 (sync reliability): getPlans/getSkills now extract their JSON
// fields in SQL. Persisted blobs are a trust boundary — malformed or
// wrongly-typed values ARE reachable — so pin that the SQL guards classify
// them exactly as the former JS parse did: invalid JSON and non-array `plans`
// contribute nothing, a non-object array entry and a non-string field extract
// nothing, the ORIGINAL array index survives skipped siblings, and extracted
// strings are trimmed by the unchanged fold.
test("getPlans/getSkills SQL extraction degrades malformed persisted JSON like the JS parse did", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-json-edges-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    // Invalid JSON metadata → no plans, no crash.
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, metadata)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude', $3)`,
      "s-bad-json",
      T1,
      "{not json"
    );
    // `plans` present but not an array → nothing (the former Array.isArray gate).
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, metadata)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude', $3)`,
      "s-plans-object",
      T2,
      JSON.stringify({ plans: { content: "not a list" } })
    );
    // `plans` is a JSON STRING whose contents spell an array — Array.isArray
    // rejected it, and the SQL must too. json_extract returns string fields
    // DEQUOTED, so a post-extraction re-validation would wrongly admit this
    // text as an array and fabricate a plan row (db-review finding); the
    // production query therefore types the field against the PARENT document.
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, metadata)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude', $3)`,
      "s-plans-string-array",
      T2,
      JSON.stringify({ plans: '[{"content":"fabricated plan"}]' })
    );
    // Mixed array: scalar entry, object with non-string content, then a real
    // plan at index 2 with whitespace to trim and a non-string source.
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, metadata)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude', $3)`,
      "s-mixed",
      T3,
      JSON.stringify({
        plans: [42, { content: 123 }, { content: "  Real plan  ", source: 7 }],
      })
    );
    const plans = await db.dashboard.getPlans();
    assert.equal(plans.length, 1);
    // The ORIGINAL array index survives the skipped siblings.
    assert.equal(plans[0]?.id, "s-mixed:plan:2");
    // nonEmptyString trims the extracted value, exactly as the JS parse did.
    assert.equal(plans[0]?.content, "Real plan");
    assert.equal(plans[0]?.source, null);
    // No plan timestamp → the session's updated_at fallback.
    assert.equal(plans[0]?.timestamp, T3);

    // Skill events: invalid data JSON falls back to summary; an object-valued
    // skillName is "no value" (never its JSON text), falling back too.
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, data, summary, created_at)
       VALUES ($1, $2, 'PreToolUse', 'Skill', $3, $4, $5)`,
      "e-bad-json",
      "s-bad-json",
      "{not json",
      "fallback/one",
      T1
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, data, summary, created_at)
       VALUES ($1, $2, 'PreToolUse', 'Skill', $3, $4, $5)`,
      "e-object-name",
      "s-mixed",
      JSON.stringify({ skillName: { nested: true } }),
      "fallback/two",
      T2
    );
    const skills = await db.dashboard.getSkills();
    assert.deepEqual(skills.map((s) => s.name).sort(), [
      "fallback/one",
      "fallback/two",
    ]);
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
    // Headline and per-type share one formula. They agree EXACTLY here only
    // because every agent seeded above is a subagent, so the two populations
    // coincide; see the ISS-4857 test below for the case where they do not.
    assert.equal(workflow.stats.successRate, worker.successRate);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ISS-4857: pin the POPULATION each orchestration rate is computed over, which
// nothing asserted before — the test above seeds only subagents, so the two
// populations coincide there and the divergence never surfaces. The headline
// `stats.successRate` is an all-agent KPI; `totalSubagents` and every
// `effectiveness[]` row count subagents only (`parent_agent_id IS NOT NULL OR
// type = 'subagent'`). They share the completed/(completed+errors) formula but
// NOT the population, so on this seed the headline reads 50% against a 0%
// breakdown — by design, and now enforced rather than merely implied. The
// all-agent scope is the one the signed corpus oracle records
// (`workflow.completed_agents`/`error_agents`/`success_rate` in
// packages/golden-sessions/corpus-expectations.yaml); narrowing the headline to
// subagents would move that signed value and is an oracle amendment under
// packages/golden-sessions/AGENTS.md, not a change to make here.
test("ISS-4857: headline success rate is all-agent, the per-type breakdown is subagent-only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-successscope-"));
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
    // Root agent: succeeded, and NOT part of the subagent population.
    await db.run(
      `INSERT INTO agents (id, session_id, status, type)
       VALUES ($1, $2, 'completed', 'main')`,
      "root",
      "s1"
    );
    // Its one subagent failed. ISS-5186: the child qualifies for the subagent
    // population by its parent link ALONE — `type` is left NULL, so this seed
    // goes red if the `parent_agent_id IS NOT NULL` branch is dropped or the
    // `OR` regresses to `AND`. The success-rate test above pins the other
    // branch with parent-less `type = 'subagent'` rows, so between them both
    // branches are covered.
    await db.run(
      `INSERT INTO agents (id, session_id, parent_agent_id, status, subagent_type)
       VALUES ($1, $2, $3, 'error', 'worker')`,
      "w1",
      "s1",
      "root"
    );

    const workflow = await db.dashboard.getWorkflowData();
    const worker = workflow.effectiveness.find(
      (e) => e.subagentType === "worker"
    );
    assert.ok(worker, "expected a 'worker' effectiveness row");
    // Breakdown: subagents only — the failing subagent alone.
    assert.equal(workflow.stats.totalSubagents, 1);
    assert.equal(worker.total, 1);
    assert.equal(worker.successRate, 0);
    // Headline: all agents — the succeeding root counts too, so 1 of 2 finished.
    assert.equal(workflow.stats.totalAgents, 2);
    assert.equal(workflow.stats.successRate, 50);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-1421: workflow tool flow counts PreToolUse invocations only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-tool-flow-"));
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
      "Tool flow session",
      "inactive",
      T1,
      "claude"
    );

    const events: [string, string, string, string][] = [
      ["e1", "PreToolUse", "Bash", "2026-06-20T10:00:00.000Z"],
      ["e2", "PostToolUse", "Bash", "2026-06-20T10:00:01.000Z"],
      ["e3", "PreToolUse", "Read", "2026-06-20T10:00:02.000Z"],
      ["e4", "PostToolUse", "Read", "2026-06-20T10:00:03.000Z"],
    ];
    for (const [id, eventType, toolName, createdAt] of events) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, 's1', $2, $3, $4)`,
        id,
        eventType,
        toolName,
        createdAt
      );
    }

    const workflow = await db.dashboard.getWorkflowData(new Date(NOW));
    assert.deepEqual(workflow.toolFlow.transitions, [
      { source: "Bash", target: "Read", value: 1 },
    ]);

    const toolCounts = new Map(
      workflow.toolFlow.toolCounts.map((tool) => [tool.toolName, tool.count])
    );
    assert.equal(toolCounts.size, 2);
    assert.equal(toolCounts.get("Bash"), 1);
    assert.equal(toolCounts.get("Read"), 1);
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
      "inactive",
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

    assert.deepEqual(projectTokenAnalyticsByModelRows(ta.byModel), [
      tokenAnalyticsByModelRow({
        model: "claude-sonnet-4-5",
        inputTokens: 3000,
        outputTokens: 1500,
        sessions: 1,
        estimatedCostUsd: 3.75,
      }),
    ]);

    const farFuture = new Date("2026-12-01T00:00:00.000Z");
    const taEmpty = await db.dashboard.getTokenAnalytics(farFuture);
    assert.equal(taEmpty.totalInputTokens, 0);
    assert.equal(taEmpty.totalOutputTokens, 0);
    assert.equal(taEmpty.byDay.length, 0);
    assert.deepEqual(
      projectTokenAnalyticsByModelRows(taEmpty.byModel),
      emptyExpectedByModelRows()
    );
    assert.equal(taEmpty.windowDays, 30);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3722: token/analytics window honors the caller's lookbackDays (7d / all-time)", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "token-analytics-lookback-")
  );
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
      "inactive",
      "2026-06-20T10:00:00.000Z",
      "claude"
    );
    // Recent event: within a 7-day window of REF.
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 1000, 500, 0, 0, 1.00)`,
      "s1",
      "claude-sonnet-4-5",
      "2026-06-20T10:00:00.000Z"
    );
    // Old event: ~52 days back — outside 7d and 30d, but inside all-time.
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 8000, 4000, 0, 0, 9.00)`,
      "s1",
      "claude-sonnet-4-5",
      "2026-05-01T10:00:00.000Z"
    );

    // 7-day window: only the recent event; window label reflects the request.
    const ta7 = await db.dashboard.getTokenAnalytics(new Date(REF), 7);
    assert.equal(ta7.windowDays, 7);
    assert.equal(ta7.totalInputTokens, 1000);
    assert.equal(ta7.totalOutputTokens, 500);

    // Default (undefined) keeps the historical 30-day window: still excludes the
    // ~52-day-old event.
    const taDefault = await db.dashboard.getTokenAnalytics(new Date(REF));
    assert.equal(taDefault.windowDays, 30);
    assert.equal(taDefault.totalInputTokens, 1000);

    // All-time (null): unbounded lower bound pulls in the old event too, and the
    // reported windowDays is the 0 "unbounded" sentinel.
    const taAll = await db.dashboard.getTokenAnalytics(new Date(REF), null);
    assert.equal(taAll.windowDays, 0);
    assert.equal(taAll.totalInputTokens, 9000);
    assert.equal(taAll.totalOutputTokens, 4500);

    // getAnalytics forwards the same lookback to its token facet.
    const analyticsAll = await db.dashboard.getAnalytics(new Date(REF), null);
    assert.equal(analyticsAll.tokens.windowDays, 0);
    assert.equal(analyticsAll.tokens.totalInputTokens, 9000);
    const analytics7 = await db.dashboard.getAnalytics(new Date(REF), 7);
    assert.equal(analytics7.tokens.windowDays, 7);
    assert.equal(analytics7.tokens.totalInputTokens, 1000);
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
      "inactive",
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
      "inactive",
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
      "inactive",
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

test("ISS-4976: the invocation-telemetry integrity read counts impossible values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "invocation-telemetry-"));
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
      "s-inv",
      "Invocations",
      "inactive",
      T1,
      "claude"
    );

    const clean = await db.runInvocationTelemetryIntegrityCheck();
    assert.deepEqual(clean, {
      outOfRangeTokenRows: 0,
      outOfRangeCostRows: 0,
      nonSubagentUsageRows: 0,
    });

    // A negative count, an out-of-range cost, and subagent-only usage on a tool
    // row: three values a collector could never legitimately compute.
    await insertInvocationRow(db, "bad-count", "subagent", {
      input_tokens: -1,
    });
    await insertInvocationRow(db, "bad-cost", "subagent", {
      estimated_cost: 100_000_000,
    });
    await insertInvocationRow(db, "wrong-kind", "tool", { input_tokens: 10 });

    const dirty = await db.runInvocationTelemetryIntegrityCheck();
    assert.equal(dirty.outOfRangeTokenRows, 1);
    assert.equal(dirty.outOfRangeCostRows, 1);
    assert.equal(dirty.nonSubagentUsageRows, 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ISS-4856: avgDepth is averaged in SQL (AVG over the per-session max depths)
// instead of returning one row per session and reducing in JS. The mean must
// still be per-session, and AVG's NULL over an empty set must fold to 0.
test("getWorkflowData averages agent depth per session and folds the empty set to 0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-avg-depth-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    // The avgDepth VALUE is identical under the old O(sessions) JS reduction, so
    // it cannot catch the hydration coming back on its own. Record the row count
    // at the production raw-read boundary — since ISS-5938 the dashboard reads
    // dispatch through `prisma.read` onto the reader pool, so the spy wraps the
    // pooled reader handed to each read callback — and pin the depth CTE to ONE
    // row regardless of how many sessions have agents.
    const depthRowCounts: number[] = [];
    const spyReader = (
      reader: Parameters<Parameters<DesktopPrisma["read"]>[0]>[0]
    ) =>
      new Proxy(reader, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "$queryRawUnsafe" || typeof value !== "function") {
            return value;
          }
          return async (sql: string, ...args: unknown[]) => {
            const rows: unknown[] = await value.call(target, sql, ...args);
            if (sql.includes("agent_depth")) {
              depthRowCounts.push(rows.length);
            }
            return rows;
          };
        },
      });
    const prisma: DesktopPrisma = {
      ...db.prisma,
      read: (fn) => db.prisma.read((reader) => fn(spyReader(reader))),
    };
    const dashboard = createSqliteDashboardQueries(prisma);

    // No agents at all → AVG over an empty set is NULL, which must read as 0.
    // AVG still yields exactly one row there, which is what makes `[0]?.avg`
    // the whole empty-set contract.
    const empty = await dashboard.getWorkflowData();
    assert.equal(empty.stats.avgDepth, 0);
    assert.deepEqual(depthRowCounts, [1]);

    for (const [id, name] of [
      ["s1", "Session one"],
      ["s2", "Session two"],
    ]) {
      await db.run(
        `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        id,
        name,
        "inactive",
        T1,
        "claude"
      );
    }
    // s1: root → child → grandchild (max depth 2). s2: root → child (depth 1).
    // The mean over the two SESSIONS is 1.5 — not the mean over the five agent
    // rows (0.8), and not the ungrouped max (2). The fractional expectation also
    // pins real division: integer division in SQL would truncate it to 1.
    for (const [id, sessionId, parentId] of [
      ["a1", "s1", null],
      ["a2", "s1", "a1"],
      ["a3", "s1", "a2"],
      ["a4", "s2", null],
      ["a5", "s2", "a4"],
    ]) {
      await db.run(
        `INSERT INTO agents (id, session_id, status, parent_agent_id)
         VALUES ($1, $2, $3, $4)`,
        id,
        sessionId,
        "completed",
        parentId
      );
    }

    const workflow = await dashboard.getWorkflowData();
    assert.equal(workflow.stats.avgDepth, 1.5);
    // Two sessions with agents, still one row back: the per-session maxes are
    // folded in SQL, not hydrated into the db-host worker to be reduced in JS.
    assert.deepEqual(depthRowCounts, [1, 1]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function insertInvocationRow(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  id: string,
  kind: string,
  telemetry: {
    input_tokens?: number;
    estimated_cost?: number;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO agent_component_invocations (
       id, session_id, external_invocation_id, component_kind, component_key,
       relationship, invoked_at, sequence, anchor_kind, anchor_value,
       attribution_status, evidence_class, input_tokens, estimated_cost,
       created_at, updated_at
     )
     VALUES ($1, 's-inv', $2, $3, 'Read', 'direct', $4, 0, 'event', $5,
             'unresolved', 'none', $6, $7, $4, $4)`,
    id,
    `external-${id}`,
    kind,
    T1,
    JSON.stringify({ eventId: `event-${id}` }),
    telemetry.input_tokens ?? null,
    telemetry.estimated_cost ?? null
  );
}
