/**
 * @file write-core-import-phases-events-coverage.test.ts
 * @description ISS-8730 coverage for `importPhaseEvents`
 * (`write-core-import-phases-events.ts`) — record group 2.
 *
 * `write-core-import-phases.test.ts` in this directory already covers the
 * derived-rollup phase; `incremental-sync-event-content-change.test.ts` already
 * covers the ISS-8757 event-CONTENT change bracket for a plain tool call; and
 * `import-reimport-idempotent.test.ts` covers the main-agent-id collision
 * recovery. None of them exercise the branches this file pins: the FEA-1459
 * purge-then-rederive for TurnDuration/APIError/ToolError/Compaction, the
 * ISS-4592 parser/fallback subagent twin retirement, a dangling `subagentId`
 * falling back to the main agent, a top-level tool-use duplicate of a
 * subagent's own tool use being skipped, and the raw `{inserted, eventsChanged}`
 * contract `importPhaseEvents` returns to its caller.
 *
 * Driven against a real SQLite store (matching the sibling
 * `write-core-import-phases.test.ts` pattern) rather than a mocked transaction:
 * this phase's behavior IS its raw SQL — DELETE-then-groupBy-then-INSERT with
 * ON CONFLICT semantics — which a hand-rolled recording mock cannot faithfully
 * reproduce without reimplementing a SQL engine.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { Harness } from "../src/main/collectors/types.js";
import { buildImportSessionContext } from "../src/main/database/import-session-context.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import type {
  EventContentSignal,
  importPhaseEvents as ImportPhaseEventsFn,
} from "../src/main/database/write-core-import-phases-events.js";
import { importPhaseEvents } from "../src/main/database/write-core-import-phases-events.js";
import { effectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-06-07T12:00:00.000Z";
const STARTED_AT = "2026-06-07T10:00:00.000Z";
const ENDED_AT = "2026-06-07T10:30:00.000Z";
const T1 = "2026-06-07T10:01:00.000Z";
const T2 = "2026-06-07T10:01:05.000Z";
const T3 = "2026-06-07T10:02:00.000Z";
const T4 = "2026-06-07T10:03:00.000Z";

async function withDb(
  label: string,
  run: (db: SqliteAgentDatabase) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), label));
  const db = await openTestDb(dir, { now: () => NOW });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Call `importPhaseEvents` directly against a real transaction, mirroring the
 * `runDerivedRollups` helper in `write-core-import-phases.test.ts`. The
 * session's `sessions`/`agents` spine must already exist (via a prior
 * `db.importer.importSession` call) — `agents.session_id` FKs to `sessions.id`,
 * so a bare call against a session with no spine row would fail closed on the
 * subagent INSERTs.
 */
async function runEventsPhase(
  db: SqliteAgentDatabase,
  session: NormalizedSession,
  now: string,
  contentSignal?: EventContentSignal
): ReturnType<typeof ImportPhaseEventsFn> {
  const ctx = buildImportSessionContext(
    db.tokenUsage,
    { detectBillingMode: () => "unknown", log: () => {} },
    session,
    Harness.Claude,
    now,
    emptyAttributionCache(),
    effectiveParsePolicy()
  );
  return await db.prisma.write((client) =>
    client.$transaction((tx) => importPhaseEvents(tx, ctx, contentSignal))
  );
}

async function eventsOfType(
  db: SqliteAgentDatabase,
  sessionId: string,
  eventType: string
) {
  const rows = await db.events.getBySession(sessionId);
  return rows.filter((row) => row.eventType === eventType);
}

describe("ISS-8730 importPhaseEvents coverage", () => {
  test("TurnDuration/APIError/ToolError/Compaction rows are purged and re-derived, never stacked, on reimport", async () => {
    await withDb("iss8730-purge-rederive-", async (db) => {
      const sessionId = "iss8730-purge-rederive";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        turnDurations: [{ durationMs: 4200, timestamp: T1 }],
        apiErrors: [
          { type: "overloaded_error", message: "boom", timestamp: T2 },
        ],
        toolResultErrors: [{ content: "failed", timestamp: T3 }],
        compactions: [{ uuid: "c1", timestamp: T4 }],
      });

      await db.importer.importSession(session, Harness.Claude);
      await db.importer.importSession(session, Harness.Claude);

      const turnDurations = await eventsOfType(db, sessionId, "TurnDuration");
      const apiErrors = await eventsOfType(db, sessionId, "APIError");
      const toolErrors = await eventsOfType(db, sessionId, "ToolError");
      const compactions = await eventsOfType(db, sessionId, "Compaction");

      assert.equal(
        turnDurations.length,
        1,
        "a reimport must not stack a second TurnDuration row"
      );
      assert.equal(turnDurations[0]?.summary, "4200");
      assert.equal(apiErrors.length, 1, "a reimport must not stack APIError");
      assert.equal(apiErrors[0]?.summary, "boom");
      assert.equal(toolErrors.length, 1, "a reimport must not stack ToolError");
      assert.equal(toolErrors[0]?.summary, "failed");
      assert.equal(
        compactions.length,
        1,
        "a reimport must not stack Compaction"
      );
      assert.equal(compactions[0]?.summary, "Context compaction");

      // The counts above are true through THREE independent mechanisms — the
      // purge, the high-water-mark check that skips re-derivation while the
      // rows are still present, and `deterministicEventId` + ON CONFLICT DO
      // NOTHING — so on their own they say nothing about purge-then-re-derive.
      // A reimport carrying a CHANGED value at the SAME instant is the case
      // only the DELETE can satisfy: the id is derived from the event identity
      // rather than its summary, so without the purge the ON CONFLICT arm
      // keeps the stale "4200" and this assertion fails.
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: STARTED_AT,
          endedAt: ENDED_AT,
          turnDurations: [{ durationMs: 9999, timestamp: T1 }],
          apiErrors: [
            { type: "overloaded_error", message: "boom", timestamp: T2 },
          ],
          toolResultErrors: [{ content: "failed", timestamp: T3 }],
          compactions: [{ uuid: "c1", timestamp: T4 }],
        }),
        Harness.Claude
      );

      const rederived = await eventsOfType(db, sessionId, "TurnDuration");
      assert.equal(rederived.length, 1);
      assert.equal(
        rederived[0]?.summary,
        "9999",
        "the purge must remove the stale row so the changed value re-derives"
      );
    });
  });

  test("ISS-4592: a parser subagent that claims its spawn tool use retires the fallback row and repoints the spawn event", async () => {
    await withDb("iss8730-twin-retired-", async (db) => {
      const sessionId = "iss8730-twin-retired";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        subagents: [
          {
            id: "sub-1",
            name: "Investigate bug",
            metadata: { spawnedByToolUseId: "toolu_1" },
          },
        ],
        toolUses: [
          {
            name: "Task",
            id: "toolu_1",
            timestamp: T1,
            resultTimestamp: T2,
            input: { subagent_type: "general", prompt: "investigate" },
          },
        ],
      });

      await db.importer.importSession(session, Harness.Claude);

      const agents = await db.agents.getBySession(sessionId);
      const fallbackId = `${sessionId}-sub-toolu_1`;
      const parserId = `${sessionId}-parser-sub-sub-1`;
      assert.equal(
        agents.some((a) => a.id === fallbackId),
        false,
        "the fallback -sub-<toolUseId> row must be retired once the parser lane claims the same delegation"
      );
      assert.equal(
        agents.some((a) => a.id === parserId),
        true,
        "the parser-lane subagent row must exist"
      );

      const spawnEvents = await eventsOfType(db, sessionId, "PreToolUse");
      assert.equal(spawnEvents.length, 1);
      assert.equal(
        spawnEvents[0]?.agentId,
        parserId,
        "the spawn event must repoint to the parser-lane subagent, not the retired fallback"
      );
    });
  });

  test("a delegating tool use with no matching parser subagent creates the fallback subagent row", async () => {
    await withDb("iss8730-fallback-sub-", async (db) => {
      const sessionId = "iss8730-fallback-sub";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        toolUses: [
          {
            name: "Agent",
            id: "toolu_2",
            timestamp: T1,
            resultTimestamp: T2,
            input: { description: "run task" },
          },
        ],
      });

      await db.importer.importSession(session, Harness.Claude);

      const fallbackId = `${sessionId}-sub-toolu_2`;
      const agents = await db.agents.getBySession(sessionId);
      const fallback = agents.find((a) => a.id === fallbackId);
      assert.ok(fallback, "the fallback subagent row must be created");
      assert.equal(fallback?.type, "subagent");
      assert.equal(fallback?.status, "completed");

      const spawnEvents = await eventsOfType(db, sessionId, "PreToolUse");
      assert.equal(spawnEvents.length, 1);
      assert.equal(spawnEvents[0]?.agentId, fallbackId);
    });
  });

  test("a top-level tool use with an unresolvable subagentId is still recorded, attributed to the main agent", async () => {
    await withDb("iss8730-dangling-subagent-", async (db) => {
      const sessionId = "iss8730-dangling-subagent";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        toolUses: [
          {
            name: "Read",
            id: "toolu_3",
            timestamp: T1,
            subagentId: "missing-subagent",
          },
        ],
      });

      await db.importer.importSession(session, Harness.Claude);

      const readEvents = await eventsOfType(db, sessionId, "PostToolUse");
      const mainId = `${sessionId}-main`;
      assert.equal(
        readEvents.length,
        1,
        "a tool use whose subagentId cannot be resolved must not be dropped"
      );
      assert.equal(
        readEvents[0]?.agentId,
        mainId,
        "an unresolvable subagentId falls back to the main agent, not a dangling reference"
      );
    });
  });

  test("a top-level duplicate of a subagent's own tool use is skipped, not recorded twice", async () => {
    await withDb("iss8730-toplevel-dup-skip-", async (db) => {
      const sessionId = "iss8730-toplevel-dup-skip";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        subagents: [
          {
            id: "sub-a",
            name: "Sub A",
            toolUses: [{ name: "Bash", id: "toolu_4", timestamp: T1 }],
          },
        ],
        // The SAME tool use also appears in the top-level array, tagged with
        // the subagent it belongs to — the shape a parser emits when a
        // delegate's tool use is echoed at both levels.
        toolUses: [
          {
            name: "Bash",
            id: "toolu_4",
            timestamp: T1,
            subagentId: "sub-a",
          },
        ],
      });

      await db.importer.importSession(session, Harness.Claude);

      const bashEvents = await eventsOfType(db, sessionId, "PostToolUse");
      const parserId = `${sessionId}-parser-sub-sub-a`;
      assert.equal(
        bashEvents.length,
        1,
        "the top-level duplicate must be skipped, not recorded alongside the subagent's own row"
      );
      assert.equal(bashEvents[0]?.agentId, parserId);
    });
  });

  test("importPhaseEvents reports eventsChanged as null with no content signal, and true/false against one", async () => {
    await withDb("iss8730-events-changed-contract-", async (db) => {
      const sessionId = "iss8730-events-changed-contract";
      const baseSession = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        toolUses: [{ name: "Read", id: "toolu_5", timestamp: T1 }],
      });

      // Create the spine (sessions + main agent row) the FK-constrained
      // subagent/event INSERTs below depend on.
      await db.importer.importSession(baseSession, Harness.Claude);

      const noSignal = await runEventsPhase(db, baseSession, NOW);
      assert.equal(
        noSignal.eventsChanged,
        null,
        "no content signal supplied means NOT MEASURED, not unchanged"
      );
      assert.equal(noSignal.inserted, 1);

      const unchanged = await runEventsPhase(db, baseSession, NOW, {
        hasRowDigest: true,
      });
      assert.equal(
        unchanged.eventsChanged,
        false,
        "a byte-identical re-derivation must report no content change"
      );

      const changedSession: NormalizedSession = {
        ...baseSession,
        toolUses: [
          ...baseSession.toolUses,
          { name: "Write", id: "toolu_6", timestamp: T2 },
        ],
      };
      const changed = await runEventsPhase(db, changedSession, NOW, {
        hasRowDigest: true,
      });
      assert.equal(
        changed.eventsChanged,
        true,
        "an added event row must report a content change"
      );
      assert.equal(changed.inserted, 2);
    });
  });
});
