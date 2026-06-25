import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * FEA-1791 Phase 3 contract test for the session + agent store reads after their
 * conversion onto typed Prisma delegates. Seeds rows with raw SQL (independent of
 * the typed write path) and asserts the converted reads preserve ordering, the
 * `status NOT IN (terminal)` active filter, and the in-memory parent/child agent
 * hierarchy (which replaced the dropped, never-read `children_count` subquery).
 * The CTE-backed detail reads (getPage/getActiveWithDetails/...) are unchanged by
 * this PR and stay covered by sqlite-agent-dashboard-database.test.ts.
 */

async function openDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-agent-contract-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  return { db, dir };
}

async function seedSession(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  row: { id: string; name: string; status: string; startedAt: string }
) {
  await db.run(
    "INSERT INTO sessions (id, name, status, started_at) VALUES ($1, $2, $3, $4)",
    row.id,
    row.name,
    row.status,
    row.startedAt
  );
}

async function seedAgent(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  row: {
    id: string;
    sessionId: string;
    parentAgentId: string | null;
    startedAt: string;
  }
) {
  await db.run(
    "INSERT INTO agents (id, session_id, parent_agent_id, started_at) VALUES ($1, $2, $3, $4)",
    row.id,
    row.sessionId,
    row.parentAgentId,
    row.startedAt
  );
}

test("FEA-1791: session store reads convert onto typed Prisma delegates", async () => {
  const { db, dir } = await openDb();
  try {
    await seedSession(db, {
      id: "s-done",
      name: "Done",
      status: "completed",
      startedAt: "2026-06-01T00:00:01.000Z",
    });
    await seedSession(db, {
      id: "s-waiting",
      name: "Waiting",
      status: "waiting",
      startedAt: "2026-06-01T00:00:02.000Z",
    });
    await seedSession(db, {
      id: "s-active",
      name: "Active",
      status: "active",
      startedAt: "2026-06-01T00:00:03.000Z",
    });
    await seedSession(db, {
      id: "s-abandoned",
      name: "Abandoned",
      status: "abandoned",
      startedAt: "2026-06-01T00:00:04.000Z",
    });
    await seedSession(db, {
      id: "s-error",
      name: "Error",
      status: "error",
      startedAt: "2026-06-01T00:00:05.000Z",
    });

    // getById: hydrates a SessionRow; missing -> undefined.
    const active = await db.sessions.getById("s-active");
    assert.equal(active?.id, "s-active");
    assert.equal(active?.name, "Active");
    assert.equal(active?.status, "active");
    assert.equal(await db.sessions.getById("ghost"), undefined);

    // getAll: every session, newest first by started_at.
    const all = await db.sessions.getAll();
    assert.deepEqual(
      all.map((s) => s.id),
      ["s-error", "s-abandoned", "s-active", "s-waiting", "s-done"]
    );

    // getActive: excludes terminal statuses (completed/abandoned/error), newest
    // first.
    const activeSessions = await db.sessions.getActive();
    assert.deepEqual(
      activeSessions.map((s) => s.id),
      ["s-active", "s-waiting"]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-1791: agent store reads convert onto typed Prisma delegates and build the hierarchy", async () => {
  const { db, dir } = await openDb();
  try {
    await seedSession(db, {
      id: "sess",
      name: "Sess",
      status: "active",
      startedAt: "2026-06-01T00:00:00.000Z",
    });
    await seedAgent(db, {
      id: "a-root",
      sessionId: "sess",
      parentAgentId: null,
      startedAt: "2026-06-01T00:00:01.000Z",
    });
    await seedAgent(db, {
      id: "a-child1",
      sessionId: "sess",
      parentAgentId: "a-root",
      startedAt: "2026-06-01T00:00:02.000Z",
    });
    await seedAgent(db, {
      id: "a-child2",
      sessionId: "sess",
      parentAgentId: "a-root",
      startedAt: "2026-06-01T00:00:03.000Z",
    });
    await seedAgent(db, {
      id: "a-grandchild",
      sessionId: "sess",
      parentAgentId: "a-child1",
      startedAt: "2026-06-01T00:00:04.000Z",
    });
    // An event attributed to a-child1 must surface on that node.
    await db.run(
      "INSERT INTO events (id, session_id, agent_id, event_type, created_at) VALUES ($1, $2, $3, $4, $5)",
      "e1",
      "sess",
      "a-child1",
      "PreToolUse",
      "2026-06-01T00:00:05.000Z"
    );

    // getBySession: ascending by started_at.
    const agents = await db.agents.getBySession("sess");
    assert.deepEqual(
      agents.map((a) => a.id),
      ["a-root", "a-child1", "a-child2", "a-grandchild"]
    );
    assert.equal(agents[1].parentAgentId, "a-root");

    // getBySessionWithChildren: parent/child tree from parentAgentId.
    const roots = await db.agents.getBySessionWithChildren("sess");
    assert.deepEqual(
      roots.map((n) => n.agentId),
      ["a-root"]
    );
    const root = roots[0];
    assert.deepEqual(
      root.children.map((c) => c.agentId),
      ["a-child1", "a-child2"]
    );
    const child1 = root.children[0];
    assert.deepEqual(
      child1.children.map((c) => c.agentId),
      ["a-grandchild"]
    );
    // Event attached to the right node.
    assert.deepEqual(
      child1.events.map((e) => e.eventType),
      ["PreToolUse"]
    );
    assert.equal(root.events.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
