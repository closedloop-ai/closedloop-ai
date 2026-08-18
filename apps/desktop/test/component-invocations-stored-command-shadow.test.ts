/**
 * @file component-invocations-stored-command-shadow.test.ts
 * @description ISS-4778: skill-shadow suppression on the STORED-ROW rebuild.
 *
 * Migration `0045_iss4778_phantom_command_backfill` stamps `data_revision = 0`
 * on every phantom-bearing session, which hands it to the boot rebuild. A
 * session whose transcript is gone takes the stored-row fallback, and that
 * fallback re-emits every entry in `sessions.metadata.slashCommands`. Without
 * the same suppression the parse path applies (ISS-4775 Part 1), it re-mints the
 * `/review` component the migration just deleted, re-inserts its invocation, and
 * rebuilds the usage rollup off it — undoing the repair on the next boot.
 *
 * Split out of `component-invocations-materialization.test.ts`, which is a
 * grandfathered shrink-only file (root AGENTS.md → File Size and Organization).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-22T17:00:00.000Z";
const INVOKED_AT = "2026-07-22T17:00:01.000Z";
const SKILL_KEY = "review";
const COMMAND_KEY = "/review";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

describe("ISS-4778 stored-row skill/command shadow suppression", () => {
  test("the stored-row rebuild suppresses a slash-invoked skill's phantom command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-stored-shadow-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-shadow";
      await db.importer.importSession(
        slashInvokedSkillSession(sessionId),
        "claude"
      );
      // The fallback's actual input: the slash entry IS still on the session
      // metadata, so suppression has to happen on the stored-row path itself.
      assert.deepEqual(await storedSlashCommandNames(db, sessionId), [
        COMMAND_KEY,
      ]);

      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);

      assert.equal(rebuilt.rebuilt, true);
      assert.deepEqual(await commandInvocationKeys(db, sessionId), []);
      assert.deepEqual(await commandComponentKeys(db), []);
      assert.deepEqual(await commandUsageKeys(db, sessionId), []);
      // The real skill is still materialized — suppression drops the shadow,
      // not the invocation evidence.
      assert.deepEqual(await skillInvocationKeys(db, sessionId), [SKILL_KEY]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The carve-out, on the stored-row path: a `/review` that DID resolve against
  // a real `.claude/commands/review.md` is a genuine command even though a
  // `review` skill also ran. The stored path has no `definitionSnapshot`, so it
  // reads that fact from the durable inventory's `resolved_state` instead.
  test("the stored-row rebuild keeps a RESOLVED command that shares a skill's bare name", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-stored-resolved-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-resolved";
      await db.importer.importSession(
        slashInvokedSkillSession(sessionId),
        "claude"
      );
      await db.run(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, resolved_state,
            content, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $3, $4, '# Review', $5, $5)`,
        "component-command-review",
        AgentComponentInvocationKind.Command,
        COMMAND_KEY,
        ComponentResolvedState.Resolved,
        NOW
      );

      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);

      assert.equal(rebuilt.rebuilt, true);
      assert.deepEqual(await commandInvocationKeys(db, sessionId), [
        COMMAND_KEY,
      ]);
      assert.deepEqual(await commandUsageKeys(db, sessionId), [COMMAND_KEY]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

/**
 * A session that fired the SKILL `review` by typing `/review` — the exact shape
 * that minted the ISS-4775 phantom: a slash entry AND a `Skill` tool use.
 */
function slashInvokedSkillSession(
  sessionId: string
): ReturnType<typeof makeSession> {
  return makeSession({
    sessionId,
    startedAt: NOW,
    endedAt: "2026-07-22T17:05:00.000Z",
    messages: [{ role: "human", timestamp: INVOKED_AT, text: COMMAND_KEY }],
    slashCommands: [{ name: COMMAND_KEY, timestamp: INVOKED_AT }],
    skills: [
      {
        name: SKILL_KEY,
        timestamp: INVOKED_AT,
        providerToolUseId: "toolu_review",
      },
    ],
    toolUses: [
      {
        name: "Skill",
        kind: "harness" as const,
        id: "toolu_review",
        providerToolUseId: "toolu_review",
        skillName: SKILL_KEY,
        timestamp: INVOKED_AT,
      },
    ],
  });
}

async function storedSlashCommandNames(
  db: Db,
  sessionId: string
): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { metadata: string | null }[]
  >("SELECT metadata FROM sessions WHERE id = $1", sessionId);
  const parsed: unknown = JSON.parse(rows[0]?.metadata ?? "{}");
  const commands =
    parsed && typeof parsed === "object" && "slashCommands" in parsed
      ? parsed.slashCommands
      : null;
  return Array.isArray(commands)
    ? commands.map((command) => String((command as { name: string }).name))
    : [];
}

function invocationKeysOfKind(
  db: Db,
  sessionId: string,
  componentKind: string
): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      "SELECT component_key FROM agent_component_invocations WHERE session_id = $1 AND component_kind = $2 ORDER BY component_key",
      sessionId,
      componentKind
    )
    .then((rows) => rows.map((row) => row.component_key));
}

function commandInvocationKeys(db: Db, sessionId: string): Promise<string[]> {
  return invocationKeysOfKind(
    db,
    sessionId,
    AgentComponentInvocationKind.Command
  );
}

function skillInvocationKeys(db: Db, sessionId: string): Promise<string[]> {
  return invocationKeysOfKind(
    db,
    sessionId,
    AgentComponentInvocationKind.Skill
  );
}

function commandComponentKeys(db: Db): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      "SELECT component_key FROM agent_components WHERE component_kind = $1 ORDER BY component_key",
      AgentComponentInvocationKind.Command
    )
    .then((rows) => rows.map((row) => row.component_key));
}

function commandUsageKeys(db: Db, sessionId: string): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ component_key: string }[]>(
      "SELECT component_key FROM agent_component_session_usage WHERE session_id = $1 AND component_kind = $2 ORDER BY component_key",
      sessionId,
      AgentComponentInvocationKind.Command
    )
    .then((rows) => rows.map((row) => row.component_key));
}
