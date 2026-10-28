/**
 * @file write-core-import-phases-events-cov-iss11283-arms.test.ts
 * @description ISS-11283: `importPhaseEvents` arms that
 * `write-core-import-phases-events-coverage.test.ts` (ISS-8730) does not reach —
 *   - a parser subagent whose id sanitizes to empty (no row, no events), and a
 *     child whose resolved parent is that unmintable subagent (falls back to
 *     the main agent) and whose own name is empty ("Subagent");
 *   - a delegation with no transcript tool-use id re-pointed to its parser twin
 *     under the array-index discriminator;
 *   - an Agent delegation with no timestamps and no input, whose minted row
 *     takes its span from the session (or the import clock);
 *   - the APIError summary fallback chain and a timestamp-less compaction;
 *   - a session payload missing its derived arrays (the worker-IPC boundary is
 *     not bound by the type), next to a hook row with no `created_at`.
 * Same harness shape as the ISS-8730 suite: spine via the real importer, then
 * the phase against a real transaction.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { Harness } from "../src/main/collectors/types.js";
import { deterministicEventId } from "../src/main/database/deterministic-event-id.js";
import { buildImportSessionContext } from "../src/main/database/import-session-context.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { importPhaseEvents } from "../src/main/database/write-core-import-phases-events.js";
import { mainAgentId } from "../src/main/database/write-core-main-agent-spine.js";
import { effectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-06-07T12:00:00.000Z";
const STARTED_AT = "2026-06-07T10:00:00.000Z";
const ENDED_AT = "2026-06-07T10:30:00.000Z";
const T1 = "2026-06-07T10:01:00.000Z";
const T2 = "2026-06-07T10:02:00.000Z";
const T3 = "2026-06-07T10:03:00.000Z";

type EventRow = {
  id: string;
  agent_id: string | null;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
  created_at: string | null;
};

type AgentRow = {
  id: string;
  name: string | null;
  task: string | null;
  started_at: string | null;
  ended_at: string | null;
  parent_agent_id: string | null;
};

let dir: string;
let db: SqliteAgentDatabase;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "iss11283-events-phase-"));
  db = await openTestDb(dir, { now: () => NOW });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Write the session spine through the real importer, then run the phase. */
async function runPhase(
  session: NormalizedSession
): Promise<{ inserted: number; eventsChanged: boolean | null }> {
  await db.importer.importSession(
    makeSession({
      sessionId: session.sessionId,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    }),
    Harness.Claude
  );
  const ctx = buildImportSessionContext(
    db.tokenUsage,
    { detectBillingMode: () => "unknown", log: () => undefined },
    session,
    Harness.Claude,
    NOW,
    emptyAttributionCache(),
    effectiveParsePolicy()
  );
  return await db.prisma.write((client) =>
    client.$transaction((tx) => importPhaseEvents(tx, ctx))
  );
}

async function events(sessionId: string): Promise<EventRow[]> {
  return await db.prisma.client.$queryRawUnsafe<EventRow[]>(
    `SELECT id, agent_id, event_type, tool_name, summary, created_at
       FROM events WHERE session_id = $1 ORDER BY created_at, event_type`,
    sessionId
  );
}

async function subagents(sessionId: string): Promise<AgentRow[]> {
  return await db.prisma.client.$queryRawUnsafe<AgentRow[]>(
    `SELECT id, name, task, started_at, ended_at, parent_agent_id
       FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id`,
    sessionId
  );
}

describe("importPhaseEvents uncovered arms (ISS-11283)", () => {
  it("mints no row or events for a parser subagent whose id sanitizes to empty, and parents its spawned child to main", async () => {
    const sessionId = "iss11283-empty-subagent-id";
    const session = makeSession({
      sessionId,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      subagents: [
        {
          id: "",
          name: "unmintable",
          toolUses: [{ name: "Agent", id: "toolu_spawn", timestamp: T1 }],
        },
        {
          id: "child",
          name: "",
          startedAt: T1,
          endedAt: T2,
          metadata: { spawnedByToolUseId: "toolu_spawn" },
        },
      ],
    });

    const result = await runPhase(session);

    expect(await subagents(sessionId)).toEqual([
      {
        id: `${sessionId}-parser-sub-child`,
        name: "Subagent",
        task: null,
        started_at: T1,
        ended_at: T2,
        parent_agent_id: mainAgentId(sessionId),
      },
    ]);
    expect(await events(sessionId)).toEqual([]);
    expect(result.inserted).toBe(0);
  });

  it("parents a subagent spawned by another parser subagent to that subagent's row (control for the fallback above)", async () => {
    const sessionId = "iss11283-nested-subagent";
    await runPhase(
      makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        subagents: [
          {
            id: "outer",
            name: "outer",
            startedAt: T1,
            endedAt: T3,
            metadata: { spawnedByToolUseId: "toolu_outer" },
            toolUses: [{ name: "Agent", id: "toolu_inner", timestamp: T2 }],
          },
          {
            id: "inner",
            name: "inner",
            startedAt: T2,
            endedAt: T3,
            metadata: { spawnedByToolUseId: "toolu_inner" },
          },
        ],
        toolUses: [{ name: "Agent", id: "toolu_outer", timestamp: T1 }],
      })
    );

    const parents = (await subagents(sessionId)).map((row) => [
      row.id,
      row.parent_agent_id,
    ]);
    expect(parents).toEqual([
      [`${sessionId}-parser-sub-inner`, `${sessionId}-parser-sub-outer`],
      [`${sessionId}-parser-sub-outer`, mainAgentId(sessionId)],
    ]);
  });

  it("re-points an id-less delegation to its parser twin under the array-index discriminator", async () => {
    const sessionId = "iss11283-idless-delegation";
    const session = makeSession({
      sessionId,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      subagents: [
        {
          id: "worker",
          name: "worker",
          startedAt: T1,
          endedAt: T2,
          metadata: { spawnedByToolUseId: "prov-1" },
        },
      ],
      toolUses: [
        { name: "Read", id: "toolu_read", timestamp: T1 },
        { name: "Task", providerToolUseId: "prov-1", timestamp: T2 },
      ],
    });

    await runPhase(session);

    const spawn = (await events(sessionId)).filter(
      (row) => row.event_type === "PreToolUse"
    );
    expect(spawn).toEqual([
      {
        id: deterministicEventId(sessionId, "PreToolUse", T2, "Task", "1"),
        agent_id: `${sessionId}-parser-sub-worker`,
        event_type: "PreToolUse",
        tool_name: "Task",
        summary: "Spawned subagent",
        created_at: T2,
      },
    ]);
    // The twin retirement means no `-sub-` fallback row was minted.
    expect((await subagents(sessionId)).map((row) => row.id)).toEqual([
      `${sessionId}-parser-sub-worker`,
    ]);
  });

  it("spans a timestamp-less, input-less Agent delegation from session start to session end, and a timed one to its result", async () => {
    const sessionId = "iss11283-timeless-agent";
    await runPhase(
      makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        toolUses: [
          { name: "Agent", id: "toolu_a", timestamp: null },
          // Control: a timed delegation with a result ends at the result.
          {
            name: "Agent",
            id: "toolu_timed",
            timestamp: T1,
            resultTimestamp: T3,
            input: { description: "timed", subagent_type: "general" },
          },
        ],
      })
    );

    expect(await subagents(sessionId)).toEqual([
      {
        id: `${sessionId}-sub-toolu_a`,
        name: "Subagent",
        task: null,
        started_at: STARTED_AT,
        ended_at: ENDED_AT,
        parent_agent_id: mainAgentId(sessionId),
      },
      {
        id: `${sessionId}-sub-toolu_timed`,
        name: "timed",
        task: null,
        started_at: T1,
        ended_at: T3,
        parent_agent_id: mainAgentId(sessionId),
      },
    ]);
    const typed = await db.prisma.client.$queryRawUnsafe<
      { id: string; subagent_type: string | null }[]
    >(
      "SELECT id, subagent_type FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
      sessionId
    );
    expect(typed.map((row) => row.subagent_type)).toEqual([null, "general"]);
    // Only the timed delegation writes a spawn event; the untimed one has no
    // instant to write it at.
    expect(
      (await events(sessionId)).map((row) => [row.agent_id, row.created_at])
    ).toEqual([[`${sessionId}-sub-toolu_timed`, T1]]);
  });

  it("ends a timestamp-less Agent delegation at the import clock when the session has no end", async () => {
    const sessionId = "iss11283-open-session-agent";
    await runPhase(
      makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: null,
        toolUses: [{ name: "Agent", id: "toolu_b", timestamp: null }],
      })
    );

    const [minted] = await subagents(sessionId);
    expect(minted?.id).toBe(`${sessionId}-sub-toolu_b`);
    expect(minted?.started_at).toBe(STARTED_AT);
    expect(minted?.ended_at).toBe(NOW);
  });

  it("summarizes an API error by message, then type, then nothing, and skips a compaction with no timestamp", async () => {
    const sessionId = "iss11283-error-summaries";
    await runPhase(
      makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        apiErrors: [
          {
            type: "overloaded_error",
            message: "Overloaded",
            timestamp: STARTED_AT,
          },
          { type: "overloaded_error", message: null, timestamp: T1 },
          { type: null, message: null, timestamp: T2 },
        ],
        compactions: [
          { uuid: "c-untimed", timestamp: null },
          { uuid: "c-timed", timestamp: T3 },
        ],
      })
    );

    const rows = await events(sessionId);
    expect(
      rows.map((row) => [row.event_type, row.summary, row.created_at])
    ).toEqual([
      ["APIError", "Overloaded", STARTED_AT],
      ["APIError", "overloaded_error", T1],
      ["APIError", null, T2],
      ["Compaction", "Context compaction", T3],
    ]);
  });

  it("imports a session payload missing its derived arrays as zero events, leaving a hook row with no created_at in place", async () => {
    const sessionId = "iss11283-missing-arrays";
    const session = makeSession({ sessionId, startedAt: STARTED_AT });
    // The db-host receives sessions over worker IPC, where a version-skewed
    // producer can omit fields the type marks required. (`toolUses` is not in
    // the list: `buildImportSessionContext` dereferences it before this phase
    // runs, so a payload without it never reaches here.)
    for (const field of [
      "messageTimestamps",
      "turnDurations",
      "apiErrors",
      "toolResultErrors",
    ] as const) {
      Reflect.deleteProperty(session, field);
    }
    await db.importer.importSession(
      makeSession({ sessionId, startedAt: STARTED_AT }),
      Harness.Claude
    );
    await db.run(
      `INSERT INTO events (id, session_id, agent_id, event_type, created_at)
       VALUES ('hook-untimed', $1, $2, 'Notification', NULL)`,
      sessionId,
      mainAgentId(sessionId)
    );
    const ctx = buildImportSessionContext(
      db.tokenUsage,
      { detectBillingMode: () => "unknown", log: () => undefined },
      session,
      Harness.Claude,
      NOW,
      emptyAttributionCache(),
      effectiveParsePolicy()
    );

    const result = await db.prisma.write((client) =>
      client.$transaction((tx) => importPhaseEvents(tx, ctx))
    );

    expect(result).toEqual({ inserted: 0, eventsChanged: null });
    expect(await events(sessionId)).toEqual([
      {
        id: "hook-untimed",
        agent_id: mainAgentId(sessionId),
        event_type: "Notification",
        tool_name: null,
        summary: null,
        created_at: null,
      },
    ]);
  });
});
