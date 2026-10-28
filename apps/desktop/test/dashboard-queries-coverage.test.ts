/**
 * @file dashboard-queries-coverage.test.ts
 * @description ISS-10514 coverage for dashboard-queries.ts against a real
 * migrated SQLite store: the default store clock, the non-finite lookback
 * clamp, and the NULL-column fallbacks in the tool, subagent and plan reads.
 * Pins CURRENT behavior only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteDashboardQueries } from "../src/main/database/dashboard-queries.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const STORE_NOW = "2026-06-22T12:00:00.000Z";
const WALL_NOW = new Date("2026-03-15T12:00:00.000Z");
const IN_WALL_WINDOW = "2026-03-13T12:00:00.000Z";
const OUT_OF_WALL_WINDOW = "2026-01-10T12:00:00.000Z";
const IN_STORE_WINDOW = "2026-06-20T12:00:00.000Z";
const DEFAULT_WINDOW_DAYS = 30;

let db: SqliteDb;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-queries-cov-"));
  db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => STORE_NOW,
  });
  await db.whenBootMaintenanceSettled();
});

afterEach(async () => {
  vi.useRealTimers();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function insertSession(id: string, updatedAt: string | null) {
  await db.run(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, metadata)
     VALUES ($1, $2, 'inactive', $3, $4, 'claude', $5)`,
    id,
    `Session ${id}`,
    IN_STORE_WINDOW,
    updatedAt,
    null
  );
}

async function insertTokenEvent(
  sessionId: string,
  createdAt: string,
  inputTokens: number
) {
  await db.run(
    `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
     VALUES ($1, 'claude-sonnet-4-5', $2, $3, 0, 0, 0, 1)`,
    sessionId,
    createdAt,
    inputTokens
  );
}

async function insertToolEvent(
  id: string,
  sessionId: string,
  toolName: string,
  createdAt: string | null
) {
  await db.run(
    `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
     VALUES ($1, $2, 'PreToolUse', $3, $4)`,
    id,
    sessionId,
    toolName,
    createdAt
  );
}

describe("createSqliteDashboardQueries default clock", () => {
  it("windows token analytics and tool usage on the wall clock when no nowFn is passed", async () => {
    await insertSession("s1", IN_STORE_WINDOW);
    await insertTokenEvent("s1", IN_WALL_WINDOW, 100);
    await insertTokenEvent("s1", OUT_OF_WALL_WINDOW, 7);
    await insertToolEvent("e1", "s1", "Bash", IN_WALL_WINDOW);
    await insertToolEvent("e2", "s1", "Read", OUT_OF_WALL_WINDOW);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WALL_NOW);

    const queries = createSqliteDashboardQueries(db.prisma);
    const tokens = await queries.getTokenAnalytics();
    const analytics = await queries.getAnalytics();

    expect(tokens.totalInputTokens).toBe(100);
    expect(tokens.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(analytics.tokens.totalInputTokens).toBe(100);
    expect(analytics.toolUsage).toEqual([{ toolName: "Bash", count: 1 }]);
  });

  it("the store-wired instance reads on the store clock, not the wall clock", async () => {
    await insertSession("s1", IN_STORE_WINDOW);
    await insertTokenEvent("s1", IN_STORE_WINDOW, 40);
    await insertTokenEvent("s1", IN_WALL_WINDOW, 9);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WALL_NOW);

    const tokens = await db.dashboard.getTokenAnalytics();

    expect(tokens.totalInputTokens).toBe(40);
  });
});

describe("normalizeLookbackDays non-finite input", () => {
  it("falls back to the 30-day window for NaN and Infinity", async () => {
    await insertSession("s1", IN_STORE_WINDOW);
    await insertTokenEvent("s1", IN_STORE_WINDOW, 5);
    const now = new Date(STORE_NOW);

    const nan = await db.dashboard.getTokenAnalytics(now, Number.NaN);
    const infinite = await db.dashboard.getAnalytics(
      now,
      Number.POSITIVE_INFINITY
    );

    expect(nan.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(nan.totalInputTokens).toBe(5);
    expect(infinite.tokens.windowDays).toBe(DEFAULT_WINDOW_DAYS);
  });
});

describe("NULL timestamp columns", () => {
  it("getTools reports lastUsedAt null for a tool whose only event has no created_at", async () => {
    await insertSession("s1", IN_STORE_WINDOW);
    await insertToolEvent("e1", "s1", "Grep", null);

    const tools = await db.dashboard.getTools();

    expect(tools).toEqual([
      {
        toolName: "Grep",
        invocationCount: 1,
        sessionCount: 1,
        lastUsedAt: null,
      },
    ]);
  });

  it("getSubAgents reports lastUsedAt null only for a type whose subagent rows all lack updated_at", async () => {
    await insertSession("s1", IN_STORE_WINDOW);
    await db.run(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, started_at, updated_at, parent_agent_id)
       VALUES ('root', 's1', 'main', 'main', NULL, 'completed', $1, $1, NULL),
              ('child', 's1', 'helper', 'subagent', 'Explore', 'completed', $1, NULL, 'root'),
              ('planner', 's1', 'planner', 'subagent', 'Plan', 'completed', $1, $1, 'root')`,
      IN_STORE_WINDOW
    );

    const subagents = await db.dashboard.getSubAgents();

    expect(subagents).toEqual([
      {
        subagentType: "Explore",
        total: 1,
        completed: 1,
        errors: 0,
        sessions: 1,
        lastUsedAt: null,
      },
      {
        subagentType: "Plan",
        total: 1,
        completed: 1,
        errors: 0,
        sessions: 1,
        lastUsedAt: IN_STORE_WINDOW,
      },
    ]);
  });

  it("getPlans reports a null timestamp when neither the plan nor the session carries one", async () => {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, cwd, metadata)
       VALUES ('s1', 'Session s1', 'inactive', $1, NULL, 'claude', '/repo', $2)`,
      IN_STORE_WINDOW,
      JSON.stringify({ plans: [{ content: "## Untimed plan\n\n- step" }] })
    );

    const plans = await db.dashboard.getPlans();

    expect(plans).toEqual([
      {
        id: "s1:plan:0",
        sessionId: "s1",
        title: "Untimed plan",
        source: null,
        content: "## Untimed plan\n\n- step",
        timestamp: null,
        harness: "claude",
        cwd: "/repo",
      },
    ]);
  });
});
