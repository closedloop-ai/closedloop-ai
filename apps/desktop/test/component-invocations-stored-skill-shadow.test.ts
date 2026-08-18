import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-22T17:00:00.000Z";
const FIRST = "2026-07-22T17:00:01.000Z";
const ESCAPED = "2026-07-22T17:00:02.000Z";
const SECOND = "2026-07-22T17:00:03.000Z";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

/**
 * The invocation set the STORED-ROW rebuild bridge reconstructs for a session
 * whose source transcript is gone: import it, drop the materialized rows, then
 * rebuild from the stored `sessions.metadata` + `events` rows alone.
 */
async function rebuildFromStoredRows(
  db: Db,
  sessionId: string
): Promise<{
  rebuilt: boolean;
  invocations: { kind: string; key: string; invokedAt: string | null }[];
}> {
  await db.run(
    "DELETE FROM agent_component_invocations WHERE session_id = $1",
    sessionId
  );
  // Production only ever hands this bridge sessions the stale sweep selected,
  // i.e. rows whose `data_revision` differs from the current one — and the
  // bridge re-checks that in its own transaction (wongk, #4255). Import stamps
  // the CURRENT revision, so the shared helper stales the row explicitly instead
  // of relying on the guard being absent.
  const rebuild = await staleRebuildFromStoredRows(db, sessionId);
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      component_kind: string;
      component_key: string;
      invoked_at: string | null;
    }[]
  >(
    `SELECT component_kind, component_key, invoked_at
       FROM agent_component_invocations
      WHERE session_id = $1
      ORDER BY invoked_at, component_kind`,
    sessionId
  );
  return {
    rebuilt: rebuild.rebuilt,
    invocations: rows.map((row) => ({
      kind: row.component_kind,
      key: row.component_key,
      invokedAt: row.invoked_at,
    })),
  };
}

// ISS-4811 (codex + closedloop-ai-stage, PR #4193): sessions whose transcript is
// missing or whose reparse output is rejected are reconstructed through the
// stored-row bridge, not `commandCandidates`. Without the shared suppression
// they retained the phantom Command and were then stamped at the current
// DATA_REVISION, so two sessions that invoked the same skill showed different
// Skill/Command splits purely by whether their transcript survived.
describe("ISS-4811 stored-row rebuild skill/command shadow suppression", () => {
  test("a slash-invoked skill reconstructs with no phantom Command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-stored-shadow-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-slash-skill";
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: SECOND,
          messages: [{ role: "human", timestamp: FIRST, text: "/review" }],
          slashCommands: [{ name: "/review", timestamp: FIRST }],
          skills: [
            { name: "review", timestamp: FIRST, providerToolUseId: "toolu_r1" },
          ],
          toolUses: [
            {
              name: "Skill",
              kind: "harness" as const,
              skillName: "review",
              timestamp: FIRST,
              providerToolUseId: "toolu_r1",
            },
          ],
        }),
        "claude"
      );

      const rebuilt = await rebuildFromStoredRows(db, sessionId);
      assert.equal(rebuilt.rebuilt, true);
      assert.deepEqual(rebuilt.invocations, [
        {
          kind: AgentComponentInvocationKind.Skill,
          key: "review",
          invokedAt: FIRST,
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unpaired slash invocation survives the stored-row rebuild", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "aci-stored-shadow-pair-")
    );
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-escaped-slash-skill";
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: SECOND,
          messages: [
            { role: "human", timestamp: FIRST, text: "/review" },
            { role: "human", timestamp: ESCAPED, text: "/review" },
            { role: "human", timestamp: SECOND, text: "/review" },
          ],
          slashCommands: [
            { name: "/review", timestamp: FIRST },
            { name: "/review", timestamp: ESCAPED },
            { name: "/review", timestamp: SECOND },
          ],
          skills: [
            { name: "review", timestamp: FIRST, providerToolUseId: "toolu_r1" },
            {
              name: "review",
              timestamp: SECOND,
              providerToolUseId: "toolu_r2",
            },
          ],
          toolUses: [
            {
              name: "Skill",
              kind: "harness" as const,
              skillName: "review",
              timestamp: FIRST,
              providerToolUseId: "toolu_r1",
            },
            {
              name: "Skill",
              kind: "harness" as const,
              skillName: "review",
              timestamp: SECOND,
              providerToolUseId: "toolu_r2",
            },
          ],
        }),
        "claude"
      );

      const rebuilt = await rebuildFromStoredRows(db, sessionId);
      assert.equal(rebuilt.rebuilt, true);
      assert.deepEqual(
        rebuilt.invocations.filter(
          (row) => row.kind === AgentComponentInvocationKind.Command
        ),
        [
          {
            kind: AgentComponentInvocationKind.Command,
            key: "/review",
            invokedAt: ESCAPED,
          },
        ]
      );
      assert.equal(
        rebuilt.invocations.filter(
          (row) => row.kind === AgentComponentInvocationKind.Skill
        ).length,
        2
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a genuine non-skill command still reconstructs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-stored-shadow-cmd-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-plain-command";
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: SECOND,
          messages: [{ role: "human", timestamp: FIRST, text: "/deploy" }],
          slashCommands: [{ name: "/deploy", timestamp: FIRST }],
        }),
        "claude"
      );

      const rebuilt = await rebuildFromStoredRows(db, sessionId);
      assert.equal(rebuilt.rebuilt, true);
      assert.deepEqual(rebuilt.invocations, [
        {
          kind: AgentComponentInvocationKind.Command,
          key: "/deploy",
          invokedAt: FIRST,
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // wongk (#4255): the boot-time stale list is advisory. If an ordinary import
  // seals the session at the CURRENT revision between listing and this
  // transaction, rebuilding anyway would delete a fully-derived invocation set
  // and reconstruct it from stored rows (which cannot emit Hooks), then stamp
  // the same revision so nothing selects it again.
  test("an already-current session is left untouched by the stale fallback", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-stored-shadow-cur-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-already-current";
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: SECOND,
          messages: [{ role: "human", timestamp: FIRST, text: "/deploy" }],
          slashCommands: [{ name: "/deploy", timestamp: FIRST }],
        }),
        "claude"
      );
      // Import stamps the CURRENT revision, so the session is already fresh.
      const rebuild = await db.rebuildComponentInvocationsFromStoredRows(
        sessionId,
        DATA_REVISION
      );
      assert.equal(rebuild.rebuilt, false);
      assert.equal(rebuild.activeRace, false);
      // The originally-derived rows must still be there, untouched.
      const rows = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );
      assert.equal(Number(rows[0]?.n ?? 0) > 0, true);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // closedloop-ai-stage (#4255): the live hook writes a SEPARATE PreToolUse and
  // PostToolUse row for one tool call, both carrying `tool_name` and the same
  // `tool_use_id`. The shadow population is built from raw `events`, so counting
  // both would let ONE skill invocation claim TWO slash turns.
  test("Pre+PostToolUse rows for one Skill call claim only ONE slash turn", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-stored-shadow-dup-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-dup-tool-events";
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: SECOND,
          messages: [
            { role: "human", timestamp: FIRST, text: "/review" },
            { role: "human", timestamp: SECOND, text: "/review" },
          ],
          slashCommands: [
            { name: "/review", timestamp: FIRST },
            { name: "/review", timestamp: SECOND },
          ],
          skills: [
            { name: "review", timestamp: FIRST, providerToolUseId: "toolu_d1" },
          ],
          toolUses: [
            {
              name: "Skill",
              kind: "harness" as const,
              skillName: "review",
              timestamp: FIRST,
              providerToolUseId: "toolu_d1",
            },
          ],
        }),
        "claude"
      );
      // Second physical events row for the SAME tool call, as the live hook
      // writes it (different event_type, same tool_use_id).
      await db.run(
        `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, data, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
        "evt-dup-pretooluse",
        sessionId,
        "PreToolUse",
        "Skill",
        JSON.stringify({ tool_use_id: "toolu_d1", skillName: "review" }),
        FIRST
      );

      const rebuilt = await rebuildFromStoredRows(db, sessionId);
      assert.equal(rebuilt.rebuilt, true);
      // ONE skill invocation, so exactly ONE of the two `/review` turns is
      // claimed and the other survives.
      assert.deepEqual(
        rebuilt.invocations.filter(
          (row) => row.kind === AgentComponentInvocationKind.Command
        ),
        [
          {
            kind: AgentComponentInvocationKind.Command,
            key: "/review",
            invokedAt: SECOND,
          },
        ]
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
