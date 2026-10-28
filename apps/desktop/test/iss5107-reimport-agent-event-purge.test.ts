/**
 * @file iss5107-reimport-agent-event-purge.test.ts
 * @description ISS-5107: `importPhaseEvents` derives its `events` sweep from the
 * SAME purged-subagent set its `agents` DELETE uses, minus the ids the reparse
 * re-minted, so a reimport can no longer drop a subagent row while leaving
 * `events` that still name it — nor take the rows of one it kept.
 *
 * The two DELETEs used to disagree: `agents` was scoped to the terminal `-sub-`
 * namespace, `events` to a fixed `event_type` list. A reimport whose
 * re-derivation yields a DIFFERENT subagent id set therefore dropped the old
 * `agents` row and kept every event on it whose type was outside that list —
 * the hook-only types (`Notification`, `SessionStart`/`SessionEnd`,
 * `UserPromptSubmit`, …). `events.agent_id` is indexed but carries no foreign
 * key (`prisma/schema.prisma`), so nothing in the engine refuses the strand and
 * `openTestDb`'s teardown `PRAGMA foreign_key_check` provably cannot see it —
 * which is why the dangle is asserted here by an explicit anti-join instead.
 *
 * FIXTURE DISCIPLINE, because a purge test is easy to make vacuously green:
 *
 *  - The dangling row is seeded at a type the importer NEVER re-derives. Seeded
 *    at `PostToolUse` it would be swept by the old `event_type` arm and the
 *    test would pass against the unfixed code.
 *  - The second import moves the subagent to a new id, so the first agent row
 *    is dropped and NOT re-created. Re-importing the same bytes re-creates the
 *    same id and strands nothing, which is why the plain idempotence suites
 *    (`iss5385-reimport-idempotence.test.ts`) never caught this.
 *  - A NEGATIVE SIBLING rides in the same corpus: an identical hook-only row on
 *    the MAIN agent, which the agents predicate never matches. Without it, a
 *    "fix" that deleted the session's events wholesale would pass every
 *    dangle assertion here.
 *  - The ISS-5098 log capture is a SECONDARY guard and does NOT pin this defect.
 *    That report (`component-invocation-row-writer.ts`) fires on
 *    `component_invocations.agent_id`, a different table whose column carries a
 *    real FK and is nulled-and-logged; the subject here is `events.agent_id`,
 *    which has none. Both imports re-derive `component_invocations` for the
 *    CURRENT subagent id, so the report reads ZERO against fixed and unfixed
 *    code alike. What it still catches is this purge deleting more than it
 *    should and stranding that table too. The anti-join and the negative
 *    sibling are what actually kill the mutation (@marisolashgrove, #7397).
 *  - A RETENTION case rides alongside the drop case, because the cheap fix for
 *    the drop — sweeping every event keyed to a purged subagent at purge time —
 *    is wrong in the far more common direction. A subagent whose derived id is
 *    STABLE across the reparse is deleted and re-created by that same phase, so
 *    such a sweep took its hook-only rows on EVERY reimport, while the `agents`
 *    row they name survived. Nothing in the drop case can see that: it moves
 *    the id on purpose. `whitlockk` on #7397.
 *
 * Seeding the hook rows by raw INSERT is deliberate: FEA-3729 set
 * `CLAUDE_LIVE_HOOK_ENABLED = false`, so the live-hook lane — the only producer
 * of these types — cannot be driven from a test any more. The rows stand for
 * what a pre-FEA-3729 build left in a store that has since been upgraded.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss5107-session";
const MAIN_AGENT_ID = `${SESSION_ID}-main`;
const FIRST_SPAWN_TOOL_USE_ID = "toolu_first_delegation";
const SECOND_SPAWN_TOOL_USE_ID = "toolu_second_delegation";
const FIRST_SUBAGENT_ID = `${SESSION_ID}-sub-${FIRST_SPAWN_TOOL_USE_ID}`;
const SECOND_SUBAGENT_ID = `${SESSION_ID}-sub-${SECOND_SPAWN_TOOL_USE_ID}`;

/**
 * A type this importer never re-derives, so it survives the `event_type` DELETE
 * and can only be reached by the end-of-phase sweep ISS-5107 added.
 */
const HOOK_ONLY_EVENT_TYPE = "Notification";

/** The ISS-5098 field signal that this defect strands a reference. */
const DROP_REPORT_RE = /reference\(s\) with no agents row/;

type DanglingRow = { id: string; agent_id: string };
type IdRow = { id: string };

/**
 * A session whose single `Task` tool use spawns one subagent, keyed by
 * `spawnToolUseId`. Changing that id between imports is what moves the derived
 * subagent id and drops the previous `agents` row.
 */
function sessionSpawning(spawnToolUseId: string): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    toolUses: [
      {
        name: "Task",
        timestamp: "2026-06-07T10:00:10.000Z",
        resultTimestamp: "2026-06-07T10:00:20.000Z",
        id: spawnToolUseId,
        input: { subagent_type: "explorer", prompt: "look around" },
      },
    ],
  });
}

/**
 * Insert one hook-shaped event, matching the column list `live-hook.ts` writes.
 * `agentId` is the whole point of the row, so it is always explicit.
 */
async function seedHookEvent(
  db: SqliteAgentDatabase,
  eventId: string,
  agentId: string
): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5)`,
      eventId,
      SESSION_ID,
      agentId,
      HOOK_ONLY_EVENT_TYPE,
      "2026-06-07T10:00:15.000Z"
    )
  );
}

/** Every event in the session naming an `agents` row that no longer exists. */
function danglingEventRows(db: SqliteAgentDatabase): Promise<DanglingRow[]> {
  return db.prisma.client.$queryRawUnsafe<DanglingRow[]>(
    `SELECT e.id, e.agent_id FROM events e
       WHERE e.session_id = $1 AND e.agent_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = e.agent_id)`,
    SESSION_ID
  );
}

function agentIds(db: SqliteAgentDatabase): Promise<IdRow[]> {
  return db.prisma.client.$queryRawUnsafe<IdRow[]>(
    "SELECT id FROM agents WHERE session_id = $1 ORDER BY id",
    SESSION_ID
  );
}

function eventIds(db: SqliteAgentDatabase): Promise<IdRow[]> {
  return db.prisma.client.$queryRawUnsafe<IdRow[]>(
    "SELECT id FROM events WHERE session_id = $1 ORDER BY id",
    SESSION_ID
  );
}

test("ISS-5107: a reimport that drops a subagent takes its events with it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5107-"));
  const logLines: string[] = [];
  const db = await openTestDb(dir, { log: (line) => logLines.push(line) });
  try {
    await db.importer.importSession(
      sessionSpawning(FIRST_SPAWN_TOOL_USE_ID),
      "claude"
    );

    // The fixture is only meaningful if the first import really minted the
    // subagent row the second one will drop.
    assert.deepEqual(
      (await agentIds(db)).map((row) => row.id),
      [MAIN_AGENT_ID, FIRST_SUBAGENT_ID]
    );

    await seedHookEvent(db, "hook-on-subagent", FIRST_SUBAGENT_ID);
    await seedHookEvent(db, "hook-on-main", MAIN_AGENT_ID);

    await db.importer.importSession(
      sessionSpawning(SECOND_SPAWN_TOOL_USE_ID),
      "claude"
    );

    // The reimport did re-derive: the old subagent is gone and a new one took
    // its place. Without this, every assertion below would also hold for an
    // import that did nothing at all.
    assert.deepEqual(
      (await agentIds(db)).map((row) => row.id),
      [MAIN_AGENT_ID, SECOND_SUBAGENT_ID]
    );

    assert.deepEqual(
      await danglingEventRows(db),
      [],
      "an events.agent_id points at a deleted agents row"
    );

    // The negative sibling: the purge is scoped to the dropped agent, not to
    // the session. A hook row on the main agent must survive untouched.
    const survivors = (await eventIds(db)).map((row) => row.id);
    assert.ok(
      survivors.includes("hook-on-main"),
      `main-agent hook event was swept: ${survivors.join(", ")}`
    );
    assert.ok(
      !survivors.includes("hook-on-subagent"),
      "the dropped subagent's hook event outlived its agents row"
    );

    assert.deepEqual(
      logLines.filter((line) => DROP_REPORT_RE.test(line)),
      [],
      "ISS-5098 drop report fired during the scenario"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5107: a reimport that RETAINS a subagent keeps that agent's hook rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5107-retain-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(
      sessionSpawning(FIRST_SPAWN_TOOL_USE_ID),
      "claude"
    );
    await seedHookEvent(db, "hook-on-retained", FIRST_SUBAGENT_ID);

    // The SAME spawn tool-use id, so the reparse re-derives the SAME subagent
    // id: the purge deletes that `agents` row and this phase re-creates it.
    await db.importer.importSession(
      sessionSpawning(FIRST_SPAWN_TOOL_USE_ID),
      "claude"
    );

    // Premise: the row really did survive the rewrite. Without this the
    // retention assertion below would also hold if the agent had been dropped
    // and its event correctly swept.
    assert.deepEqual(
      (await agentIds(db)).map((row) => row.id),
      [MAIN_AGENT_ID, FIRST_SUBAGENT_ID]
    );

    assert.ok(
      (await eventIds(db)).map((row) => row.id).includes("hook-on-retained"),
      "a retained subagent's hook row was swept by the reimport"
    );
    assert.deepEqual(
      await danglingEventRows(db),
      [],
      "an events.agent_id points at a deleted agents row"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
