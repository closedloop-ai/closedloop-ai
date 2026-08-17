/**
 * ISS-5098 regression: an invocation candidate naming an agent that no `agents`
 * row satisfies must NOT abort the component_invocations import.
 *
 * Root cause: `agent_component_invocations.agent_id` / `.parent_agent_id` carry a
 * FOREIGN KEY to `agents`, but every id reaching the writer is DERIVED, not
 * verified — the parse-derived builder mints `<session>-sub-<toolUseId>` for a
 * delegation it could not pair to a parser-lane subagent (assuming the events
 * phase minted that twin, which ISS-4592 stopped doing), and the stored-event
 * builder copies `events.agent_id`, a column that deliberately carries NO foreign
 * key. Either way SQLite rejected the WHOLE batched insert with
 * `SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` (code 787); the import phase
 * caught it, marked the session incomplete, and re-imported it forever — the
 * session never sealed and its invocation rows never landed.
 *
 * These assert the boundary fix behaviorally:
 *  (1) an unsatisfiable `agentId` imports without throwing and persists the row
 *      with `agent_id IS NULL` (the column is nullable and its relation declares
 *      onDelete: SetNull, so "agent unknown" is a supported state);
 *  (2) the same for `parentAgentId`;
 *  (3) a RESOLVABLE agent id is preserved — the guard must not over-null real
 *      attribution;
 *  (4) the drop is REPORTED, not swallowed. The reporting is the contract here:
 *      the whole point is that a mint/insert divergence stays visible instead of
 *      degrading into silent attribution loss; and
 *  (5) BOTH stored-row entry points report it (wongk, #4355). The legacy
 *      bootstrap (`ensureStoredAgentComponentInvocations`) and the stored-row
 *      rebuild (`rebuildAgentComponentInvocationsFromStoredRows`) build their
 *      candidates straight off `events.agent_id` — the very column with no FK —
 *      so they are the paths MOST likely to drop a reference. While the writer's
 *      reporter was optional they both called it without one and committed the
 *      drop in silence; these two cases fail if that ever regresses.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { AgentComponentInvocationCandidate } from "../src/main/database/component-invocation-row-writer.js";
import { insertInvocationRows } from "../src/main/database/component-invocation-row-writer.js";
import {
  deriveAgentComponentInvocationCandidates,
  ensureStoredAgentComponentInvocations,
  rebuildAgentComponentInvocationsFromStoredRows,
} from "../src/main/database/component-invocations.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-04T17:00:00.000Z";
const MAIN_AGENT_ID = "main-agent";
const MISSING_AGENT_ID = "session-orphan-sub-toolu_never_inserted";
const DROPPED_AGENT_REPORT = /dropped 1 agent_id/;
const MISSING_AGENT_IN_REPORT = new RegExp(MISSING_AGENT_ID);
/** A rebuild targets a revision; the value is irrelevant to this suite. */
const TARGET_DATA_REVISION = 1;

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

function toolSession(sessionId: string): ReturnType<typeof makeSession> {
  return makeSession({
    sessionId,
    startedAt: NOW,
    endedAt: "2026-08-04T17:05:00.000Z",
    toolUses: [
      {
        id: "toolu_read_1",
        providerToolUseId: "toolu_read_1",
        name: "Read",
        kind: "builtin",
        timestamp: "2026-08-04T17:00:01.000Z",
      },
    ],
  });
}

function agentColumns(
  db: Db,
  sessionId: string
): Promise<{ agent_id: string | null; parent_agent_id: string | null }[]> {
  return db.prisma.client.$queryRawUnsafe<
    { agent_id: string | null; parent_agent_id: string | null }[]
  >(
    `SELECT agent_id, parent_agent_id
       FROM agent_component_invocations
      WHERE session_id = $1
      ORDER BY sequence`,
    sessionId
  );
}

/**
 * Import the session (so its `sessions` row and real agents exist), then clear the
 * derived invocation rows so the raw writer boundary can be driven with a
 * hand-built candidate — the same shape the FEA-4160 suite uses.
 */
async function seedSession(
  db: Db,
  sessionId: string
): Promise<AgentComponentInvocationCandidate> {
  await db.importer.importSession(toolSession(sessionId), "claude");
  await db.run(
    "DELETE FROM agent_component_invocations WHERE session_id = $1",
    sessionId
  );
  const candidates = deriveAgentComponentInvocationCandidates(
    toolSession(sessionId),
    MAIN_AGENT_ID,
    NOW
  );
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error("expected one derived candidate for the Read tool use");
  }
  return candidate;
}

/**
 * Reproduce the STORED-row hazard the two legacy entry points face: import the
 * session, clear its invocation rows, then repoint its tool `events.agent_id` at
 * an id no `agents` row satisfies. `events.agent_id` carries an index but no
 * foreign key, so this is a state the real store genuinely reaches; both stored
 * builders copy that column straight onto their candidates.
 */
async function seedOrphanStoredEvent(db: Db, sessionId: string): Promise<void> {
  await db.importer.importSession(toolSession(sessionId), "claude");
  await db.run(
    "DELETE FROM agent_component_invocations WHERE session_id = $1",
    sessionId
  );
  await db.run(
    "UPDATE events SET agent_id = $1 WHERE session_id = $2 AND tool_name IS NOT NULL",
    MISSING_AGENT_ID,
    sessionId
  );
  const orphaned = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM events
      WHERE session_id = $1 AND agent_id = $2`,
    sessionId,
    MISSING_AGENT_ID
  );
  if (Number(orphaned[0]?.n ?? 0) !== 1) {
    throw new Error(
      "the stored path must see exactly one orphan-referencing tool event"
    );
  }
}

describe("ISS-5098 orphan agent reference does not abort the invocation insert", () => {
  test("an agent_id with no agents row is nulled, not thrown", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-5098-agent-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-5098-orphan-agent";
      const candidate = await seedSession(db, sessionId);
      // Precondition: nothing satisfies this id, so binding it would fail the FK.
      const existing = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agents WHERE id = $1",
        MISSING_AGENT_ID
      );
      assert.equal(existing.length, 0, "the orphan id must not exist");
      const messages: string[] = [];

      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          insertInvocationRows(
            tx,
            sessionId,
            [
              {
                ...candidate,
                agentId: MISSING_AGENT_ID,
                parentAgentId: null,
                localComponentId: null,
                localComponentVersionId: null,
              },
            ],
            (message) => messages.push(message)
          )
        )
      );

      const rows = await agentColumns(db, sessionId);
      assert.equal(rows.length, 1, "the invocation row still lands");
      assert.equal(rows[0]?.agent_id, null, "the unsatisfiable id is nulled");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a parent_agent_id with no agents row is nulled, not thrown", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-5098-parent-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-5098-orphan-parent";
      const candidate = await seedSession(db, sessionId);
      const messages: string[] = [];

      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          insertInvocationRows(
            tx,
            sessionId,
            [
              {
                ...candidate,
                agentId: null,
                parentAgentId: MISSING_AGENT_ID,
                localComponentId: null,
                localComponentVersionId: null,
              },
            ],
            (message) => messages.push(message)
          )
        )
      );

      const rows = await agentColumns(db, sessionId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.parent_agent_id, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a resolvable agent id is preserved — the guard must not over-null", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-5098-keep-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-5098-real-agent";
      const candidate = await seedSession(db, sessionId);
      // The import above wrote a real main-agent row; bind THAT id.
      const agents = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agents WHERE session_id = $1 ORDER BY id LIMIT 1",
        sessionId
      );
      const realAgentId = agents[0]?.id;
      assert.ok(realAgentId, "the imported session must have an agents row");
      const messages: string[] = [];

      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          insertInvocationRows(
            tx,
            sessionId,
            [
              {
                ...candidate,
                agentId: realAgentId,
                parentAgentId: null,
                localComponentId: null,
                localComponentVersionId: null,
              },
            ],
            (message) => messages.push(message)
          )
        )
      );

      const rows = await agentColumns(db, sessionId);
      assert.equal(rows[0]?.agent_id, realAgentId, "real attribution survives");
      assert.deepEqual(messages, [], "a preserved reference reports nothing");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the dropped reference is reported, not swallowed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-5098-report-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-5098-report";
      const candidate = await seedSession(db, sessionId);
      const messages: string[] = [];

      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          insertInvocationRows(
            tx,
            sessionId,
            [
              {
                ...candidate,
                agentId: MISSING_AGENT_ID,
                parentAgentId: null,
                localComponentId: null,
                localComponentVersionId: null,
              },
            ],
            (message) => messages.push(message)
          )
        )
      );

      assert.equal(messages.length, 1, "exactly one report per insert");
      assert.match(messages[0] ?? "", DROPPED_AGENT_REPORT);
      assert.match(messages[0] ?? "", MISSING_AGENT_IN_REPORT);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the legacy stored bootstrap reports the drop it commits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-5098-bootstrap-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-5098-bootstrap";
      await seedOrphanStoredEvent(db, sessionId);
      const messages: string[] = [];

      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          ensureStoredAgentComponentInvocations(tx, [sessionId], NOW, (m) =>
            messages.push(m)
          )
        )
      );

      const rows = await agentColumns(db, sessionId);
      assert.equal(rows.length, 1, "the bootstrapped row still lands");
      assert.equal(rows[0]?.agent_id, null, "the orphan reference is dropped");
      // The point of the case: the drop above is committed, so it MUST be
      // reported. Before #4355 this path passed no reporter at all.
      assert.equal(messages.length, 1, "the bootstrap reports its drop");
      assert.match(messages[0] ?? "", DROPPED_AGENT_REPORT);
      assert.match(messages[0] ?? "", MISSING_AGENT_IN_REPORT);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the stored-row rebuild reports the drop it commits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-5098-rebuild-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-5098-rebuild";
      await seedOrphanStoredEvent(db, sessionId);
      const messages: string[] = [];

      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          rebuildAgentComponentInvocationsFromStoredRows(
            tx,
            sessionId,
            TARGET_DATA_REVISION,
            NOW,
            (m) => messages.push(m)
          )
        )
      );

      const rows = await agentColumns(db, sessionId);
      assert.equal(rows.length, 1, "the rebuilt row still lands");
      assert.equal(rows[0]?.agent_id, null, "the orphan reference is dropped");
      assert.equal(messages.length, 1, "the rebuild reports its drop");
      assert.match(messages[0] ?? "", DROPPED_AGENT_REPORT);
      assert.match(messages[0] ?? "", MISSING_AGENT_IN_REPORT);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
