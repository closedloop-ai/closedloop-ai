/**
 * @file claude-subagent-row-dedup.test.ts
 * @description ISS-4592 (review follow-up): the `agents` write path must not
 * write two rows for one real delegation.
 *
 * Both lanes had always written a row per invocation — a `-parser-sub-*` row
 * from `session.subagents` and a `-sub-<toolUseId>` fallback row from the
 * `Agent`/`Task` tool use. Before the kickoff join the parser row carried null
 * `subagent_type`/`task`, so the pair was at least distinguishable; populating
 * those fields made the fallback row a byte-identical twin, which inflated
 * every NAMED `subagent_type` bucket to roughly 2x its true value. The write
 * path now retires the twin using `metadata.spawnedByToolUseId` — the same
 * exact-spawn correlation `agent_component_invocations` uses.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession as makeSession } from "./normalized-session-test-utils.js";

const SPAWN_TOOL_USE_ID = "toolu_spawn_1";
const NESTED_SPAWN_TOOL_USE_ID = "toolu_spawn_nested_1";
const CHILD_ID = "agent-a7bb59fb";
/**
 * `NormalizedSubagent.name` is REQUIRED, so a fixture that omits it describes a
 * record the collector cannot emit. The dedup under test never reads it (it keys
 * on the row id and `metadata.spawnedByToolUseId`), so a stable label per id is
 * enough — this deliberately does NOT re-derive `createSidecarSubagent`'s
 * format, which would be an unasserted copy of production logic.
 */
function subagentDisplayName(nativeSubagentId: string): string {
  return `subagent ${nativeSubagentId}`;
}

/** A delegation present in BOTH lanes: a subagent record and its Agent call. */
function delegatedSession(sessionId: string, spawnedByToolUseId?: string) {
  return makeSession({
    sessionId,
    subagents: [
      {
        id: CHILD_ID,
        name: subagentDisplayName(CHILD_ID),
        type: "code-review:code-review-worker",
        task: "Review the diff",
        startedAt: "2026-06-07T10:00:30.000Z",
        endedAt: "2026-06-07T10:00:40.000Z",
        ...(spawnedByToolUseId ? { metadata: { spawnedByToolUseId } } : {}),
      },
    ],
    toolUses: [
      {
        name: "Agent",
        timestamp: "2026-06-07T10:00:30.000Z",
        id: SPAWN_TOOL_USE_ID,
        input: {
          prompt: "Review the diff",
          subagent_type: "code-review:code-review-worker",
        },
        resultTimestamp: "2026-06-07T10:00:40.000Z",
      },
    ],
  });
}

test("one delegation writes ONE subagent row, not a parser/fallback pair", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4592-dedup-"));
  const db = await openTestDb(dir);
  try {
    const result = await db.importer.importSession(
      delegatedSession("dedup-1", SPAWN_TOOL_USE_ID),
      "claude"
    );
    assert.equal(result.incomplete, undefined);

    const rows = await db.prisma.client.$queryRawUnsafe<
      { id: string; subagent_type: string | null }[]
    >(
      "SELECT id, subagent_type FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
      "dedup-1"
    );

    assert.equal(
      rows.length,
      1,
      `expected exactly one subagent row, got ${rows.map((r) => r.id).join(", ")}`
    );
    assert.equal(rows[0].id, `dedup-1-parser-sub-${CHILD_ID}`);
    assert.equal(rows[0].subagent_type, "code-review:code-review-worker");
    assert.ok(
      !rows.some((r) => r.id === `dedup-1-sub-${SPAWN_TOOL_USE_ID}`),
      "the duplicate fallback row must not be written"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the spawn event survives, re-pointed at the row that remains", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4592-dedup-"));
  const db = await openTestDb(dir);
  try {
    const result = await db.importer.importSession(
      delegatedSession("dedup-2", SPAWN_TOOL_USE_ID),
      "claude"
    );
    assert.equal(result.incomplete, undefined);

    // Retiring the row must not lose its spawn event: addEvent keys identity on
    // (type, ts, tool, discriminator), never the agent id, so the event is the
    // same row with a different agent_id.
    const events = await db.prisma.client.$queryRawUnsafe<
      { agent_id: string; tool_name: string | null }[]
    >(
      "SELECT agent_id, tool_name FROM events WHERE session_id = $1 AND event_type = 'PreToolUse' AND tool_name = 'Agent'",
      "dedup-2"
    );

    assert.equal(events.length, 1, "exactly one spawn event");
    assert.equal(events[0].agent_id, `dedup-2-parser-sub-${CHILD_ID}`);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a NESTED delegation recovers its span from the parent subagent's transcript", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4592-dedup-"));
  const db = await openTestDb(dir);
  try {
    // A subagent spawning another subagent: the Agent call lives in the PARENT
    // SUBAGENT's transcript, so it lands on `subagent.toolUses` and never on
    // `session.toolUses`. Indexing only the session's tool uses left the
    // child's degenerate span unrepaired and persisted a 0-second delegation —
    // 16 of the 68 subagents in the golden corpus, all in dossier f216298d.
    const result = await db.importer.importSession(
      makeSession({
        sessionId: "dedup-nested",
        subagents: [
          {
            id: "agent-parent01",
            name: subagentDisplayName("agent-parent01"),
            type: "general-purpose",
            startedAt: "2026-06-07T10:00:00.000Z",
            endedAt: "2026-06-07T10:05:00.000Z",
            toolUses: [
              {
                name: "Agent",
                timestamp: "2026-06-07T10:01:00.000Z",
                id: NESTED_SPAWN_TOOL_USE_ID,
                input: { prompt: "Nested", subagent_type: "general-purpose" },
                resultTimestamp: "2026-06-07T10:03:00.000Z",
              },
            ],
          },
          {
            id: "agent-child001",
            name: subagentDisplayName("agent-child001"),
            type: "general-purpose",
            // Degenerate: a folded sidecar collapses to a single instant.
            startedAt: "2026-06-07T10:01:00.000Z",
            endedAt: "2026-06-07T10:01:00.000Z",
            metadata: { spawnedByToolUseId: NESTED_SPAWN_TOOL_USE_ID },
          },
        ],
        toolUses: [],
      }),
      "claude"
    );
    assert.equal(result.incomplete, undefined);

    const rows = await db.prisma.client.$queryRawUnsafe<
      { started_at: string | null; ended_at: string | null }[]
    >(
      "SELECT started_at, ended_at FROM agents WHERE id = $1",
      "dedup-nested-parser-sub-agent-child001"
    );

    assert.equal(rows.length, 1);
    assert.notEqual(
      rows[0].started_at,
      rows[0].ended_at,
      "the nested delegation must not persist as a 0-second span"
    );
    assert.equal(
      new Date(rows[0].ended_at ?? "").toISOString(),
      "2026-06-07T10:03:00.000Z",
      "it adopts the delegation's call → tool_result window"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unmeasurable span persists as NULL, not a fabricated zero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4592-dedup-"));
  const db = await openTestDb(dir);
  try {
    // A degenerate own span with no spawn tool use to repair it. The insights
    // average skips an absent timestamp but counts `startedAt == endedAt` as a
    // real zero, so persisting the equal pair would drag the per-type average
    // down with a delegation that was never actually timed.
    const result = await db.importer.importSession(
      makeSession({
        sessionId: "dedup-unmeasured",
        subagents: [
          {
            id: "agent-nospan1",
            name: subagentDisplayName("agent-nospan1"),
            type: "general-purpose",
            startedAt: "2026-06-07T10:00:30.000Z",
            endedAt: "2026-06-07T10:00:30.000Z",
          },
        ],
        toolUses: [],
      }),
      "claude"
    );
    assert.equal(result.incomplete, undefined);

    const rows = await db.prisma.client.$queryRawUnsafe<
      { started_at: string | null }[]
    >(
      "SELECT started_at FROM agents WHERE id = $1",
      "dedup-unmeasured-parser-sub-agent-nospan1"
    );

    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].started_at,
      null,
      "an unmeasured delegation must read as unknown, not as a 0-second run"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two children claiming ONE delegation is treated as unresolved", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4592-dedup-"));
  const db = await openTestDb(dir);
  try {
    // `spawnedByToolUseId` crosses a trust boundary (a sidecar .meta.json, a
    // tool_result payload), so two children CAN claim the same delegation.
    // Last-write-wins here would resolve it differently than
    // matchSpawnedSubagent's first-match find — pointing the spawn event at one
    // child and the invocation at another while still suppressing the fallback
    // row. Ambiguous input must retire nothing.
    const result = await db.importer.importSession(
      makeSession({
        sessionId: "dedup-dup",
        subagents: [
          {
            id: "agent-claimant1",
            name: subagentDisplayName("agent-claimant1"),
            type: "general-purpose",
            metadata: { spawnedByToolUseId: SPAWN_TOOL_USE_ID },
          },
          {
            id: "agent-claimant2",
            name: subagentDisplayName("agent-claimant2"),
            type: "general-purpose",
            metadata: { spawnedByToolUseId: SPAWN_TOOL_USE_ID },
          },
        ],
        toolUses: [
          {
            name: "Agent",
            timestamp: "2026-06-07T10:00:30.000Z",
            id: SPAWN_TOOL_USE_ID,
            input: { prompt: "Ambiguous", subagent_type: "general-purpose" },
            resultTimestamp: "2026-06-07T10:00:40.000Z",
          },
        ],
      }),
      "claude"
    );
    assert.equal(result.incomplete, undefined);

    const ids = (
      await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
        "dedup-dup"
      )
    ).map((r) => r.id);

    assert.ok(
      ids.includes(`dedup-dup-sub-${SPAWN_TOOL_USE_ID}`),
      "an ambiguous claim must NOT retire the fallback row"
    );
    assert.ok(ids.includes("dedup-dup-parser-sub-agent-claimant1"));
    assert.ok(ids.includes("dedup-dup-parser-sub-agent-claimant2"));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delegation the parser lane never claimed still writes the fallback row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4592-dedup-"));
  const db = await openTestDb(dir);
  try {
    // No spawnedByToolUseId — other harnesses, and Claude parses predating the
    // kickoff join, must keep the pre-ISS-4592 behavior rather than silently
    // losing the delegation.
    const result = await db.importer.importSession(
      delegatedSession("dedup-3"),
      "claude"
    );
    assert.equal(result.incomplete, undefined);

    const rows = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
      "dedup-3"
    );
    const ids = rows.map((r) => r.id);

    assert.ok(
      ids.includes(`dedup-3-sub-${SPAWN_TOOL_USE_ID}`),
      "unclaimed delegation keeps its fallback row"
    );
    assert.ok(ids.includes(`dedup-3-parser-sub-${CHILD_ID}`));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
