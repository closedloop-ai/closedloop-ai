import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * FEA-1791 Phase 3 contract test for `createSqliteDashboardQueries` after the
 * dashboard read surface moved off the raw `SqliteExecutor` handle onto the
 * single `DesktopPrisma` client. Like the session/agent/event store contract
 * tests, this runs through `openSqliteAgentDatabase` (the runtime + electron
 * load), so it is a CI guard — the dev sandbox does not download the electron
 * binary. The `sqlite-conversion-golden` suite already pins `getTokenAnalytics`
 * byte-for-byte, and `sqlite-agent-dashboard-database` exercises
 * `getWorkflowData` / `getCoreFeatures` / large-sum coercion; this test fills
 * the conversion-specific gaps those leave:
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

const NOW = "2026-06-22T00:00:00.000Z";
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
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens)
       VALUES ($1, $2, 300, 100)`,
      "s1",
      "claude-sonnet-4-5"
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
    const analytics = await db.dashboard.getAnalytics();
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
