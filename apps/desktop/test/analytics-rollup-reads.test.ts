/**
 * ISS-5493: every tool-count read agrees on what a tool invocation IS.
 *
 * `toolInvocationPredicate` is the one definition — `tool_name IS NOT NULL AND
 * tool_name <> ''` — and it is what the canonical `buildAnalytics` fold already
 * applied via its falsy `if (!event.toolName)` test. Before this, the four SQL
 * readers filtered on `IS NOT NULL` alone, so an empty `tool_name` (reachable:
 * live-hook.ts stores the hook payload's `data.tool_name` verbatim) inflated
 * every SQL count and grouped itself as a nameless tool row, while the hydrate
 * path dropped it.
 *
 * A focused sibling suite — the contract files that own these read paths are
 * both grandfathered, so new scenarios land here.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  createSqliteDashboardQueries,
  TOOL_INVOCATION_EVENT_TYPE,
} from "../src/main/database/dashboard-queries.js";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessionAnalytics } from "../src/main/session/shared-agent-sessions-api.js";
import { initGitRepoWithOrigin } from "./attribution-test-helpers.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";
import { makeSession } from "./normalized-session-test-utils.js";

// FEA-2430: `toolRunsOverTime` buckets to the process-local day (strftime
// 'localtime'), so a bare UTC assertion here passes only in zones at or behind
// UTC. Pin the same fixed non-UTC zone the sibling contract file uses, at module
// evaluation, before any test opens a DB or reads a Date, and restore the
// caller's TZ afterward per AGENTS.md Test Practices (wongk review).
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";
after(() => {
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

const STARTED_AT = "2026-06-20T15:00:00.000Z"; // = June 20 10:00 CDT
const NOW = new Date("2026-06-21T12:00:00.000Z");
const DAY = "2026-06-20";

test("ISS-5493 TZ canary: process is pinned to America/Chicago", () => {
  // Minutes behind UTC: CDT (June) = 300. A loud failure here means the
  // module-eval pin did not take and the local-day assertion below would be
  // silently testing the wrong zone.
  assert.equal(new Date(STARTED_AT).getTimezoneOffset(), 300);
});

test("ISS-5493: the Insights tools KPI, toolUsage and toolRunsOverTime all drop an empty tool_name, so they report one consistent total", async () => {
  const { dir, db, prisma } = await openInsightsDb("iss5493-insights-");
  try {
    await db.query(
      "INSERT INTO sessions (id, status, started_at) VALUES ($1, 'inactive', $2)",
      ["s1", STARTED_AT]
    );
    // Two genuine tool invocations, one empty-string tool_name, one non-tool
    // event. Only the first two are tool invocations on every surface.
    const events: [string, string, string | null][] = [
      ["ev1", "PostToolUse", "Bash"],
      ["ev2", "PostToolUse", "Edit"],
      ["ev3", "PostToolUse", ""],
      ["ev4", "SessionEnd", null],
    ];
    for (const [id, type, tool] of events) {
      await db.query(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, "s1", type, tool, STARTED_AT]
      );
    }

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );

    const toolUsage = agents.charts.toolUsage ?? [];
    const trendTotal = (agents.charts.toolRunsOverTime?.points ?? []).reduce(
      (sum, point) => sum + (point.values["tool-runs"] ?? 0),
      0
    );
    const usageTotal = toolUsage.reduce((sum, slice) => sum + slice.value, 0);
    const kpi = agents.kpis.find((k) => k.key === "tool-runs")?.value;

    assert.equal(kpi, 2, "the Tool runs KPI excludes the empty-named event");
    assert.equal(usageTotal, 2, "toolUsage excludes the empty-named event");
    assert.equal(trendTotal, 2, "the trend excludes the empty-named event");
    // The regression this guards is DISAGREEMENT: one surface counting 3 while
    // its neighbour counts 2 renders two different totals on the same screen.
    assert.equal(kpi, trendTotal);
    assert.equal(kpi, usageTotal);
    // The empty name must not survive as its own nameless toolUsage slice.
    assert.deepEqual(toolUsage.map((slice) => slice.key).sort(), [
      "Bash",
      "Edit",
    ]);

    const point = agents.charts.toolRunsOverTime?.points.find(
      (p) => p.date === DAY
    );
    assert.equal(point?.values["tool-runs"], 2);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5493: byTool drops an empty-string tool_name on the SQL path exactly as the hydrate buildAnalytics fold does", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5493-analytics-"));
  const repoDir = path.join(dir, "wt");
  await mkdir(repoDir, { recursive: true });
  initGitRepoWithOrigin(repoDir, "acme/repo-iss5493");
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW.toISOString(),
  });
  try {
    await db.run(
      `INSERT INTO sessions
         (id, name, status, cwd, started_at, updated_at, harness, billing_mode, data_revision)
       VALUES ($1, $1, 'inactive', $2, $3, $3, 'claude', 'metered_api', 1)`,
      "s1",
      repoDir,
      STARTED_AT
    );
    const events: [string, string, string | null][] = [
      ["ev1", "PostToolUse", "Bash"],
      ["ev2", "tool_error", "Bash"],
      // Empty tool name on an ERROR event: absent from byTool, but still
      // counted in the session's repository error total — exactly the order
      // buildAnalytics folds in (error tallied first, tool group skipped).
      ["ev3", "command_failed", ""],
    ];
    for (const [id, type, tool] of events) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        id,
        "s1",
        type,
        tool,
        STARTED_AT
      );
    }

    // No ids/search → the SQL aggregate. Explicit ids → the hydrate fold.
    const sql = await getSharedAgentSessionAnalytics(db.syncSource, {});
    const hydrate = await getSharedAgentSessionAnalytics(db.syncSource, {
      ids: ["s1"],
    });

    assert.deepEqual(sql.byTool, [
      { toolName: "Bash", invocationCount: 2, errorCount: 1, sessionCount: 1 },
    ]);
    assert.deepEqual(
      sql.byTool,
      hydrate.byTool,
      "the SQL aggregate must match the hydrate fold — the FEA-2038 parity contract"
    );
    assert.equal(
      sql.byRepository.find((r) => r.repositoryFullName === "acme/repo-iss5493")
        ?.errorCount,
      2,
      "both error events count toward the repository total, tool-named or not"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5493: the four dashboard reads seeded with an empty tool_name drop it from every result", async () => {
  const { dir, db, prisma } = await openInsightsDb("iss5493-dashboard-");
  try {
    await db.query(
      "INSERT INTO sessions (id, status, started_at) VALUES ($1, 'inactive', $2)",
      ["s1", STARTED_AT]
    );
    // A Bash → <empty> → Edit sequence on the tool-invocation event type: the
    // empty row would otherwise count as its own nameless tool AND split the
    // one real transition (Bash → Edit) into two bogus ones through it. The two
    // trailing rows sit outside that event type, so only the reads that do not
    // scope by it (`getAnalytics`, `getTools`) see them.
    const events: [string, string, string, string][] = [
      ["ev1", TOOL_INVOCATION_EVENT_TYPE, "Bash", STARTED_AT],
      ["ev2", TOOL_INVOCATION_EVENT_TYPE, "", "2026-06-20T15:00:01.000Z"],
      ["ev3", TOOL_INVOCATION_EVENT_TYPE, "Edit", "2026-06-20T15:00:02.000Z"],
      ["ev4", "PostToolUse", "Read", "2026-06-20T15:00:03.000Z"],
      ["ev5", "PostToolUse", "", "2026-06-20T15:00:04.000Z"],
    ];
    for (const [id, eventType, tool, at] of events) {
      await db.query(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, "s1", eventType, tool, at]
      );
    }

    const dashboard = createSqliteDashboardQueries(prisma);
    const analytics = await dashboard.getAnalytics(NOW);
    const workflow = await dashboard.getWorkflowData(NOW);
    const tools = await dashboard.getTools();

    assert.deepEqual(sortedToolCounts(analytics.toolUsage), [
      { toolName: "Bash", count: 1 },
      { toolName: "Edit", count: 1 },
      { toolName: "Read", count: 1 },
    ]);
    assert.deepEqual(sortedToolCounts(workflow.toolFlow.toolCounts), [
      { toolName: "Bash", count: 1 },
      { toolName: "Edit", count: 1 },
    ]);
    // The empty row is not a hop: dropping it reconnects Bash directly to Edit
    // rather than leaving `Bash → ""` and `"" → Edit`.
    assert.deepEqual(workflow.toolFlow.transitions, [
      { source: "Bash", target: "Edit", value: 1 },
    ]);
    // ORDER BY invocation_count DESC, tool_name ASC — every count is 1 here, so
    // the returned order is deterministic and asserted as-is.
    assert.deepEqual(
      tools.map((tool) => ({
        toolName: tool.toolName,
        invocationCount: tool.invocationCount,
        sessionCount: tool.sessionCount,
      })),
      [
        { toolName: "Bash", invocationCount: 1, sessionCount: 1 },
        { toolName: "Edit", invocationCount: 1, sessionCount: 1 },
        { toolName: "Read", invocationCount: 1, sessionCount: 1 },
      ]
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5493: the stored-row invocation rebuild drops an empty tool_name instead of materializing a nameless Tool component", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5493-invocations-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW.toISOString(),
  });
  try {
    const sessionId = "session-empty-tool";
    await db.importer.importSession(
      makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: "2026-06-20T15:05:00.000Z",
        toolUses: [{ id: "toolu_bash", name: "Bash", timestamp: STARTED_AT }],
      }),
      "claude"
    );
    // live-hook.ts persists the hook payload's `data.tool_name` verbatim, so an
    // empty one is a real `events` row — and `events` is exactly what the
    // stored-row rebuild reads back when the source transcript is gone.
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      "ev-empty",
      sessionId,
      TOOL_INVOCATION_EVENT_TYPE,
      "",
      "2026-06-20T15:00:01.000Z"
    );

    const rebuilt = await staleRebuildFromStoredRows(db, sessionId);

    assert.equal(rebuilt.rebuilt, true);
    assert.deepEqual(await toolInvocationKeys(db, sessionId), ["Bash"]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Tool-count rows sorted by name, so a `count DESC` tie cannot flake. */
function sortedToolCounts(
  rows: { toolName: string; count: number }[]
): { toolName: string; count: number }[] {
  return [...rows]
    .map((row) => ({ toolName: row.toolName, count: row.count }))
    .sort((a, b) => a.toolName.localeCompare(b.toolName));
}

/** Every materialized Tool-kind invocation key for `sessionId`, ordered. */
function toolInvocationKeys(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      `SELECT component_key FROM agent_component_invocations
        WHERE session_id = $1 AND component_kind = $2
        ORDER BY component_key`,
      sessionId,
      AgentComponentInvocationKind.Tool
    )
    .then((rows) => rows.map((row) => row.component_key));
}
