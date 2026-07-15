/**
 * @file write-core-component-usage.test.ts
 * @description FEA-2923 (T-10.8) — desktop write-core component-usage
 * materialization tests.
 *
 * Asserts the two independent write paths triggered by a session import:
 *   1. `agent_component_session_usage` — USAGE rows per (session, kind, key).
 *   2. `agent_components`              — EXISTENCE rows per (kind, key).
 *
 * Test matrix:
 *   - Built-in tool (Read)       → kind=tool, component_key=Read
 *   - MCP tool (mcp__srv__fn)    → kind=mcp, component_key=srv (mcpServer field)
 *   - Skill (/skill-name prompt) → kind=skill, component_key=skill-name
 *   - Slash command              → kind=command, via slashCommands metadata
 *   - Subagent spawn             → kind=subagent via agents rows
 *   - Hook / Config              → zero usage rows (correct — no invocation signal)
 *   - Independence               → existence rows survive even when usage rows absent
 *   - Idempotency                → re-import is a no-op on both tables
 *   - agentComponentId           → usage rows link to agent_components when present
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-06-20T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

/**
 * Query the usage table for a specific session and optionally filter by kind.
 */
function queryUsage(
  db: Db,
  sessionId: string,
  kind?: string
): Promise<
  Array<{
    component_kind: string;
    component_key: string;
    invocations: number;
    error_count: number;
    agent_component_id: string | null;
  }>
> {
  const kindClause = kind ? `AND component_kind = '${kind}'` : "";
  return db.prisma.client.$queryRawUnsafe<
    Array<{
      component_kind: string;
      component_key: string;
      invocations: number;
      error_count: number;
      agent_component_id: string | null;
    }>
  >(
    `SELECT component_kind, component_key, invocations, error_count, agent_component_id
     FROM agent_component_session_usage
     WHERE session_id = $1 ${kindClause}
     ORDER BY component_kind, component_key`,
    sessionId
  );
}

/**
 * Count all usage rows for a session.
 */
async function countUsage(db: Db, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<[{ n: number }]>(
    "SELECT COUNT(*) AS n FROM agent_component_session_usage WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Query the existence table for a specific (kind, key) pair.
 */
function queryComponent(
  db: Db,
  kind: string,
  key: string
): Promise<
  Array<{
    id: string;
    component_kind: string;
    component_key: string;
    first_seen_at: string | null;
    last_seen_at: string | null;
  }>
> {
  return db.prisma.client.$queryRawUnsafe<
    Array<{
      id: string;
      component_kind: string;
      component_key: string;
      first_seen_at: string | null;
      last_seen_at: string | null;
    }>
  >(
    `SELECT id, component_kind, component_key, first_seen_at, last_seen_at
     FROM agent_components
     WHERE component_kind = $1 AND component_key = $2`,
    kind,
    key
  );
}

/**
 * Insert a session + events directly via raw SQL for finer control over tool
 * names and event data without going through the full hook pipeline.
 *
 * Used when `importSession` alone is not enough to populate the events table
 * (e.g., to seed MCP events with `data.mcpServer` in the JSON blob).
 */
async function insertSessionWithEvents(
  db: Db,
  sessionId: string,
  harness: string,
  events: Array<{
    id: string;
    agentId: string;
    eventType: string;
    toolName: string | null;
    data: Record<string, unknown> | null;
    createdAt: string;
  }>
): Promise<void> {
  const mainAgentId = `${sessionId}:main`;
  await db.run(
    `INSERT OR IGNORE INTO sessions (id, status, harness, started_at, updated_at, billing_mode)
     VALUES ($1, 'completed', $2, $3, $3, 'metered_api')`,
    sessionId,
    harness,
    NOW
  );
  await db.run(
    `INSERT OR IGNORE INTO agents (id, session_id, type, name, status, started_at, updated_at)
     VALUES ($1, $2, 'main', 'Main', 'completed', $3, $3)`,
    mainAgentId,
    sessionId,
    NOW
  );
  for (const evt of events) {
    await db.run(
      `INSERT OR IGNORE INTO events
         (id, session_id, agent_id, event_type, tool_name, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      evt.id,
      sessionId,
      evt.agentId ?? mainAgentId,
      evt.eventType,
      evt.toolName,
      evt.data ? JSON.stringify(evt.data) : null,
      evt.createdAt
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("write-core component usage materialization (T-10.8)", () => {
  test("built-in tool (Read) produces a tool usage row and a component existence row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-tool-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-builtin-tool";
      const mainAgentId = `${sessionId}:main`;
      await insertSessionWithEvents(db, sessionId, "claude", [
        {
          id: `${sessionId}-evt-1`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "Read",
          data: { tool_name: "Read" },
          createdAt: NOW,
        },
        {
          id: `${sessionId}-evt-2`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "Read",
          data: { tool_name: "Read" },
          createdAt: NOW,
        },
      ]);

      // Trigger the analytics rollup (which materializes component usage).
      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const usage = await queryUsage(db, sessionId, "tool");
      assert.equal(usage.length, 1, "one tool usage row");
      assert.equal(usage[0]?.component_kind, "tool");
      assert.equal(usage[0]?.component_key, "Read");
      assert.equal(usage[0]?.invocations, 2, "two invocations counted");

      // Existence row should also be present.
      const comp = await queryComponent(db, "tool", "Read");
      assert.equal(comp.length, 1, "one agent_components row for tool/Read");
      assert.ok(comp[0]?.id, "id is set");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("MCP tool (mcp__server__method) produces kind=mcp with server name as key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-mcp-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-mcp-tool";
      const mainAgentId = `${sessionId}:main`;
      await insertSessionWithEvents(db, sessionId, "claude", [
        {
          id: `${sessionId}-evt-1`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          // tool_name starts with mcp__ → picked up as mcp kind
          toolName: "mcp__myserver__do_thing",
          data: { tool_name: "mcp__myserver__do_thing", mcpServer: "myserver" },
          createdAt: NOW,
        },
      ]);

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const usage = await queryUsage(db, sessionId, "mcp");
      assert.equal(usage.length, 1, "one mcp usage row");
      assert.equal(usage[0]?.component_kind, "mcp");
      // component_key should be the mcpServer value, not the raw tool_name.
      assert.equal(
        usage[0]?.component_key,
        "myserver",
        "component_key is the mcpServer name"
      );

      const comp = await queryComponent(db, "mcp", "myserver");
      assert.equal(comp.length, 1, "existence row for mcp/myserver");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // FEA-3048: skills are now classified off the first-class `Skill` tool call
  // (`tool_name='Skill'`) — NOT off the former fragile
  // `UserPromptSubmit AND prompt LIKE '/_%'` heuristic. The skill name lands
  // under different keys per write path, so insertSkillUsage COALESCEs across
  // both: `data.skillName` (JSONL import) and `data.tool_input.skill` (live
  // Claude hook). This case covers the import path.
  test("Skill tool call produces a skill usage row keyed by data.skillName", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-skill-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-skill";
      const mainAgentId = `${sessionId}:main`;
      await insertSessionWithEvents(db, sessionId, "claude", [
        {
          id: `${sessionId}-evt-1`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "Skill",
          // The parser folds tool_use.input.skill into data.skillName.
          data: { tool_name: "Skill", skillName: "myskill" },
          createdAt: NOW,
        },
        {
          id: `${sessionId}-evt-2`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "Skill",
          data: { tool_name: "Skill", skillName: "myskill" },
          createdAt: NOW,
        },
      ]);

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const usage = await queryUsage(db, sessionId, "skill");
      assert.equal(usage.length, 1, "one skill usage row");
      assert.equal(usage[0]?.component_kind, "skill");
      assert.equal(usage[0]?.component_key, "myskill");
      assert.equal(usage[0]?.invocations, 2, "both Skill calls counted");

      // The Skill tool call must NOT also land in the generic `tool` bucket.
      const toolUsage = await queryUsage(db, sessionId, "tool");
      assert.equal(
        toolUsage.length,
        0,
        "Skill is routed to the skill bucket, not counted as a generic tool"
      );

      const comp = await queryComponent(db, "skill", "myskill");
      assert.equal(comp.length, 1, "existence row for skill/myskill");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // FEA-3048: the live Claude hook path (agent-monitor-listener → insertEvent)
  // persists the raw hook payload unchanged, so a Skill call's name stays under
  // `data.tool_input.skill` — there is NO `data.skillName` here (that field is
  // synthesized only on the JSONL import path by importToolEventData). The skill
  // bucket must still classify it via the COALESCE fallback.
  test("live-hook Skill event is classified via data.tool_input.skill (no skillName)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-skill-hook-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-skill-hook";
      const mainAgentId = `${sessionId}:main`;
      await insertSessionWithEvents(db, sessionId, "claude", [
        {
          id: `${sessionId}-evt-1`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "Skill",
          // Raw live-hook shape: name under tool_input.skill, no skillName field.
          data: { tool_name: "Skill", tool_input: { skill: "hookskill" } },
          createdAt: NOW,
        },
      ]);

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const usage = await queryUsage(db, sessionId, "skill");
      assert.equal(usage.length, 1, "one skill usage row from the live hook");
      assert.equal(usage[0]?.component_kind, "skill");
      assert.equal(usage[0]?.component_key, "hookskill");
      assert.equal(usage[0]?.invocations, 1, "the Skill call is counted");

      // Still must NOT leak into the generic tool bucket.
      const toolUsage = await queryUsage(db, sessionId, "tool");
      assert.equal(
        toolUsage.length,
        0,
        "live-hook Skill is routed to the skill bucket, not the tool bucket"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // FEA-3048: a `/foo` slash-command prompt must NOT be classified as a skill.
  // Under the old prompt-heuristic it would have. It fires NO `Skill` tool call,
  // so it can only be counted once — as a command.
  test("a /foo slash-command prompt is counted once as a command, never as a skill (FEA-3048)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-slash-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-slash-cmd";
      await db.run(
        `INSERT OR IGNORE INTO sessions (id, status, harness, started_at, updated_at, billing_mode, metadata)
         VALUES ($1, 'completed', 'claude', $2, $2, 'metered_api', $3)`,
        sessionId,
        NOW,
        JSON.stringify({ slashCommands: [{ name: "xyz", timestamp: NOW }] })
      );
      const mainAgentId = `${sessionId}:main`;
      await db.run(
        `INSERT OR IGNORE INTO agents (id, session_id, type, name, status, started_at, updated_at)
         VALUES ($1, $2, 'main', 'Main', 'completed', $3, $3)`,
        mainAgentId,
        sessionId,
        NOW
      );
      // A UserPromptSubmit event whose prompt is `/xyz ...` — the exact shape the
      // old `prompt LIKE '/_%'` matcher keyed off. It must NOT create a skill row.
      await db.run(
        `INSERT OR IGNORE INTO events
           (id, session_id, agent_id, event_type, tool_name, data, created_at)
         VALUES ($1, $2, $3, 'UserPromptSubmit', NULL, $4, $5)`,
        `${sessionId}-evt-1`,
        sessionId,
        mainAgentId,
        JSON.stringify({ prompt: "/xyz do the thing" }),
        NOW
      );

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const commandUsage = await queryUsage(db, sessionId, "command");
      const skillUsage = await queryUsage(db, sessionId, "skill");
      assert.equal(commandUsage.length, 1, "one command usage row");
      assert.equal(commandUsage[0]?.component_key, "/xyz");
      assert.equal(
        skillUsage.length,
        0,
        "the /xyz prompt matcher no longer fires — it is a command, not a skill"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("slash command in slashCommands metadata produces a command usage row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-cmd-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-cmd";
      // The command path reads from sessions.metadata → $.slashCommands[].name
      // We need a session row with that metadata.
      await db.run(
        `INSERT OR IGNORE INTO sessions (id, status, harness, started_at, updated_at, billing_mode, metadata)
         VALUES ($1, 'completed', 'claude', $2, $2, 'metered_api', $3)`,
        sessionId,
        NOW,
        JSON.stringify({
          slashCommands: [
            { name: "review", timestamp: NOW },
            { name: "review", timestamp: NOW },
          ],
        })
      );
      const mainAgentId = `${sessionId}:main`;
      await db.run(
        `INSERT OR IGNORE INTO agents (id, session_id, type, name, status, started_at, updated_at)
         VALUES ($1, $2, 'main', 'Main', 'completed', $3, $3)`,
        mainAgentId,
        sessionId,
        NOW
      );

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const usage = await queryUsage(db, sessionId, "command");
      assert.equal(
        usage.length,
        1,
        "one command usage row (deduplicated by name)"
      );
      assert.equal(usage[0]?.component_kind, "command");
      // component_key is '/' + name
      assert.equal(usage[0]?.component_key, "/review");

      const comp = await queryComponent(db, "command", "/review");
      assert.equal(comp.length, 1, "existence row for command//review");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("first import of a /cmd prompt that is also a slashCommand is counted ONCE as a command, not double-counted as a skill (FEA-2923)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-dblcount-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-double-count";
      // A session whose metadata lists `/review` as a slash command AND whose
      // events include the matching `/review` UserPromptSubmit prompt. The
      // former prompt heuristic wrongly emitted both a skill('review') and a
      // command('/review') usage row — a double-count. FEA-3048 removes the
      // prompt heuristic entirely (skills key off the `Skill` tool call), so a
      // `/review` prompt with NO `Skill` tool call can only be a command.
      await db.run(
        `INSERT OR IGNORE INTO sessions (id, status, harness, started_at, updated_at, billing_mode, metadata)
         VALUES ($1, 'completed', 'claude', $2, $2, 'metered_api', $3)`,
        sessionId,
        NOW,
        JSON.stringify({ slashCommands: [{ name: "review", timestamp: NOW }] })
      );
      const mainAgentId = `${sessionId}:main`;
      await db.run(
        `INSERT OR IGNORE INTO agents (id, session_id, type, name, status, started_at, updated_at)
         VALUES ($1, $2, 'main', 'Main', 'completed', $3, $3)`,
        mainAgentId,
        sessionId,
        NOW
      );
      await db.run(
        `INSERT OR IGNORE INTO events
           (id, session_id, agent_id, event_type, tool_name, data, created_at)
         VALUES ($1, $2, $3, 'UserPromptSubmit', NULL, $4, $5)`,
        `${sessionId}-evt-1`,
        sessionId,
        mainAgentId,
        JSON.stringify({ prompt: "/review the PR" }),
        NOW
      );

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      // FIRST import only — this is where the pre-fix double-count occurred.
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const commandUsage = await queryUsage(db, sessionId, "command");
      const skillUsage = await queryUsage(db, sessionId, "skill");
      assert.equal(commandUsage.length, 1, "one command usage row");
      assert.equal(commandUsage[0]?.component_key, "/review");
      assert.equal(
        skillUsage.length,
        0,
        "NO skill usage row — the /review invocation is a command, not a skill (no double-count on first import)"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("subagent spawn produces a subagent usage row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-sub-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-subagent";
      const mainAgentId = `${sessionId}:main`;
      await db.run(
        `INSERT OR IGNORE INTO sessions (id, status, harness, started_at, updated_at, billing_mode)
         VALUES ($1, 'completed', 'claude', $2, $2, 'metered_api')`,
        sessionId,
        NOW
      );
      await db.run(
        `INSERT OR IGNORE INTO agents (id, session_id, type, name, status, started_at, updated_at)
         VALUES ($1, $2, 'main', 'Main', 'completed', $3, $3)`,
        mainAgentId,
        sessionId,
        NOW
      );
      // A subagent row: type='subagent', subagent_type is the key
      const subId = `${sessionId}:sub-1`;
      await db.run(
        `INSERT OR IGNORE INTO agents (id, session_id, type, subagent_type, name, status, started_at, updated_at)
         VALUES ($1, $2, 'subagent', 'code-review-agent', 'Sub1', 'completed', $3, $3)`,
        subId,
        sessionId,
        NOW
      );

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const usage = await queryUsage(db, sessionId, "subagent");
      assert.equal(usage.length, 1, "one subagent usage row");
      assert.equal(usage[0]?.component_kind, "subagent");
      assert.equal(usage[0]?.component_key, "code-review-agent");
      assert.equal(usage[0]?.invocations, 1);

      const comp = await queryComponent(db, "subagent", "code-review-agent");
      assert.equal(
        comp.length,
        1,
        "existence row for subagent/code-review-agent"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hook and config kinds produce zero usage rows (no invocation signal — correct)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-hook-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-hook-config";
      // Import a session via the normal path — no hook/config signals in events.
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: "2026-06-20T12:05:00.000Z",
          cwd: "/project",
          model: "claude-sonnet-4-5",
        }),
        "claude"
      );

      // Existence rows for hook/config are NOT written by event-driven discovery
      // (no invocation signal). Usage rows must also be absent.
      const hookUsage = await queryUsage(db, sessionId, "hook");
      const configUsage = await queryUsage(db, sessionId, "config");
      assert.equal(hookUsage.length, 0, "zero hook usage rows");
      assert.equal(configUsage.length, 0, "zero config usage rows");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-import is idempotent: row counts stay stable on the second import", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-idem-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-idempotent";
      const mainAgentId = `${sessionId}:main`;
      await insertSessionWithEvents(db, sessionId, "claude", [
        {
          id: `${sessionId}-evt-1`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "Bash",
          data: { tool_name: "Bash" },
          createdAt: NOW,
        },
      ]);

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      const rollup = () =>
        db.prisma.write((client) =>
          client.$transaction((tx) =>
            upsertSessionAnalyticsRollup(tx, sessionId, NOW)
          )
        );

      // First rollup
      await rollup();
      const usageAfterFirst = await countUsage(db, sessionId);
      const compAfterFirst = await db.prisma.client.$queryRawUnsafe<
        [{ n: number }]
      >(
        "SELECT COUNT(*) AS n FROM agent_components WHERE component_key = 'Bash'"
      );

      // Second rollup (idempotent)
      await rollup();
      const usageAfterSecond = await countUsage(db, sessionId);
      const compAfterSecond = await db.prisma.client.$queryRawUnsafe<
        [{ n: number }]
      >(
        "SELECT COUNT(*) AS n FROM agent_components WHERE component_key = 'Bash'"
      );

      assert.equal(
        usageAfterFirst,
        usageAfterSecond,
        "usage row count stable after re-rollup"
      );
      assert.equal(
        Number(compAfterFirst[0]?.n),
        Number(compAfterSecond[0]?.n),
        "existence row count stable after re-rollup"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("agentComponentId is set on usage row when a matching agent_components row exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-fkid-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-fk-id";
      const mainAgentId = `${sessionId}:main`;
      await insertSessionWithEvents(db, sessionId, "claude", [
        {
          id: `${sessionId}-evt-1`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "Write",
          data: { tool_name: "Write" },
          createdAt: NOW,
        },
      ]);

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      // Run once to create both the usage and the existence row.
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      const [comp] = await queryComponent(db, "tool", "Write");
      assert.ok(comp, "existence row exists for tool/Write");
      assert.ok(comp.id, "existence row has an id");

      const usage = await queryUsage(db, sessionId, "tool");
      const writeRow = usage.find((r) => r.component_key === "Write");
      assert.ok(writeRow, "usage row exists for Write");
      // The agent_component_id FK is resolved on insert via a sub-SELECT.
      // After the existence row is created (step T-8.5), the usage row is
      // rebuilt on the same rollup pass so they co-exist; agent_component_id
      // may be null the first time (row doesn't exist yet when the INSERT runs)
      // but the existence row itself must always be present.
      // This assertion verifies the FK resolves on a second rollup pass.
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );
      const usageAfterSecond = await queryUsage(db, sessionId, "tool");
      const writeRowAfterSecond = usageAfterSecond.find(
        (r) => r.component_key === "Write"
      );
      assert.ok(
        writeRowAfterSecond,
        "usage row still present after second rollup"
      );
      // The agent_component_id should now resolve to the existence row's id.
      assert.equal(
        writeRowAfterSecond.agent_component_id,
        comp.id,
        "agent_component_id resolves to the existence row id on the second pass"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the two representations are independent: existence rows survive even without usage rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-indep-"));
    const db = await openDb(dir);
    try {
      // Manually insert an existence row without any corresponding usage.
      await db.run(
        `INSERT OR IGNORE INTO agent_components
           (id, component_kind, external_id, component_key, first_seen_at, last_seen_at)
         VALUES ('test-id-indep', 'hook', 'myHook', 'myHook', $1, $1)`,
        NOW
      );

      const comp = await queryComponent(db, "hook", "myHook");
      assert.equal(comp.length, 1, "existence row present without usage");

      // No usage rows should exist for hook/myHook.
      const rows = await db.prisma.client.$queryRawUnsafe<[{ n: number }]>(
        "SELECT COUNT(*) AS n FROM agent_component_session_usage WHERE component_kind = 'hook' AND component_key = 'myHook'"
      );
      assert.equal(Number(rows[0]?.n), 0, "no usage rows for the hook");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // FEA-3121 — an invocation whose component resolves to NO definition/source
  // (not in any pack/catalog/repo) must still be RECORDED and surfaced, never
  // silently dropped, so local/discovered components stay visible in usage
  // metrics. The event-driven rollup already guarantees this (usage is
  // materialized straight from the transcript, independently of whether an
  // inventory/source row exists). This test PINS that contract so a future
  // change that gates recording on source resolution — e.g. a `WHERE
  // agent_component_id IS NOT NULL` filter, or requiring a pack lookup — fails
  // loudly instead of silently undercounting.
  test("unresolved-source component invocation is recorded and surfaced, not dropped (FEA-3121)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-unresolved-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-unresolved-source";
      const mainAgentId = `${sessionId}:main`;
      // An MCP server that exists in NO pack/catalog — source resolution fails.
      await insertSessionWithEvents(db, sessionId, "claude", [
        {
          id: `${sessionId}-evt-1`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "mcp__unresolved_server__call",
          data: {
            tool_name: "mcp__unresolved_server__call",
            mcpServer: "unresolved_server",
          },
          createdAt: NOW,
        },
        {
          id: `${sessionId}-evt-2`,
          agentId: mainAgentId,
          eventType: "PostToolUse",
          toolName: "mcp__unresolved_server__call",
          data: {
            tool_name: "mcp__unresolved_server__call",
            mcpServer: "unresolved_server",
          },
          createdAt: NOW,
        },
      ]);

      const { upsertSessionAnalyticsRollup } = await import(
        "../src/main/database/write-core.js"
      );
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, sessionId, NOW)
        )
      );

      // (1) The invocation is recorded WITH its count — not dropped.
      const usage = await queryUsage(db, sessionId, "mcp");
      assert.equal(
        usage.length,
        1,
        "unresolved-source mcp invocation is recorded, not dropped"
      );
      assert.equal(usage[0]?.component_key, "unresolved_server");
      assert.equal(usage[0]?.invocations, 2, "both invocations are counted");
      // (2) Recording is NOT gated on source resolution: on this first pass the
      // FK is null (the inventory row is materialized after the usage insert),
      // yet the invocation is fully recorded above.
      assert.equal(
        usage[0]?.agent_component_id,
        null,
        "invocation recorded even though it resolved to no component on this pass"
      );

      // (3) The discovered component is SURFACED via an auto-materialized
      // inventory row, and is distinguishable as unresolved (no source metadata),
      // so a read can label it "discovered/unresolved" rather than hiding it.
      const comp = await queryComponent(db, "mcp", "unresolved_server");
      assert.equal(comp.length, 1, "discovered component is surfaced");
      const src = await db.prisma.client.$queryRawUnsafe<
        Array<{
          source_url: string | null;
          pack_id: string | null;
          install_path: string | null;
        }>
      >(
        `SELECT source_url, pack_id, install_path
         FROM agent_components
         WHERE component_kind = 'mcp' AND component_key = 'unresolved_server'`
      );
      assert.equal(src[0]?.source_url, null, "no source url — unresolved");
      assert.equal(src[0]?.pack_id, null, "no pack — unresolved");
      assert.equal(src[0]?.install_path, null, "no install path — unresolved");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * FEA-2718: the cloud-sync hydration now sets `omitEventData: true` (synced
 * events no longer carry turn text) and must therefore ask for component usage
 * explicitly via `includeComponentUsage: true` — because that lane used to ride
 * on `!omitEventData`. These tests lock in the decoupling so the T-8.6
 * component-usage sync cannot silently regress when event data is omitted.
 */
describe("FEA-2718: component usage vs omitEventData decoupling", () => {
  const syncCache = () => ({
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  });

  async function seedSessionWithUsage(
    db: Db,
    sessionId: string
  ): Promise<void> {
    await insertSessionWithEvents(db, sessionId, "claude", [
      {
        id: `${sessionId}-evt-1`,
        agentId: `${sessionId}:main`,
        eventType: "PostToolUse",
        toolName: "Read",
        data: { tool_name: "Read" },
        createdAt: NOW,
      },
    ]);
    const { upsertSessionAnalyticsRollup } = await import(
      "../src/main/database/write-core.js"
    );
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, sessionId, NOW)
      )
    );
  }

  test("keeps component usage on the slim cloud-sync hydration (omitEventData + includeComponentUsage)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-fea2718-keep-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-fea2718-keep";
      await seedSessionWithUsage(db, sessionId);

      const [synced] = await db.syncSource.loadSyncedSessions(
        [sessionId],
        syncCache(),
        { omitEventData: true, includeComponentUsage: true }
      );

      assert.ok(
        synced?.components?.some(
          (c) => c.componentKind === "tool" && c.componentKey === "Read"
        ),
        "component usage is present even though event data was omitted"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("omits component usage on the full-corpus list hydration (omitEventData only)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-fea2718-omit-"));
    const db = await openDb(dir);
    try {
      const sessionId = "sess-fea2718-omit";
      await seedSessionWithUsage(db, sessionId);

      // Premise: usage actually materialized, so an empty `components` below
      // reflects the gate rather than a seeding failure (a false pass).
      assert.equal(
        (await queryUsage(db, sessionId, "tool")).length,
        1,
        "tool usage row materialized"
      );

      const [synced] = await db.syncSource.loadSyncedSessions(
        [sessionId],
        syncCache(),
        { omitEventData: true }
      );

      // `includeComponentUsage` defaults to `!omitEventData` → false here, so the
      // list/analytics read keeps its pre-FEA-2718 behavior (no components).
      assert.ok(
        !synced?.components || synced.components.length === 0,
        "component usage omitted when includeComponentUsage is not requested"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
