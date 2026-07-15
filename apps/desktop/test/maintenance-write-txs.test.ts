/**
 * @file maintenance-write-txs.test.ts
 * @description Electron-free coverage for the standalone maintenance write
 * transaction `sweepOrphanedSessions`, which runs on
 * `prisma.write((client) => client.$transaction(...))` on the single client.
 * Built over the shared {@link openTestPrisma} harness so it runs locally as
 * well as in CI. (`deleteSessionRow` — the other maintenance tx — is an inline
 * db method validated end-to-end, incl. the agents FK cascade, by
 * data-revision-rebuild.test.ts test 12.)
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  sweepExpiredSessions,
  sweepOrphanedSessions,
} from "../src/main/database/session-maintenance.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-06-22T12:00:00.000Z";
// cutoff = NOW - 180min = 2026-06-22T09:00:00.000Z
const STALE_UPDATED_AT = "2026-06-22T08:00:00.000Z"; // before cutoff → stale
const FRESH_UPDATED_AT = "2026-06-22T11:30:00.000Z"; // after cutoff → fresh

type Store = OpenTestPrisma["db"];

async function seedSession(
  store: Store,
  id: string,
  status: string,
  updatedAt: string
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, data_revision) VALUES ($1, $2, $3, $4)",
    [id, status, updatedAt, 1]
  );
}

async function seedAgent(
  store: Store,
  id: string,
  sessionId: string,
  status: string
): Promise<void> {
  await store.query(
    "INSERT INTO agents (id, session_id, status) VALUES ($1, $2, $3)",
    [id, sessionId, status]
  );
}

async function getSession(store: Store, id: string) {
  const result = await store.query<{
    status: string;
    ended_at: string | null;
    updated_at: string | null;
  }>("SELECT status, ended_at, updated_at FROM sessions WHERE id = $1", [id]);
  return result.rows[0];
}

async function getAgent(store: Store, id: string) {
  const result = await store.query<{
    status: string;
    ended_at: string | null;
    updated_at: string | null;
  }>("SELECT status, ended_at, updated_at FROM agents WHERE id = $1", [id]);
  return result.rows[0];
}

test("sweepOrphanedSessions abandons stale active sessions and completes their running agents", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "stale", "active", STALE_UPDATED_AT);
    await seedAgent(store, "stale-running", "stale", "running");
    await seedAgent(store, "stale-done", "stale", "completed");
    await seedSession(store, "fresh", "active", FRESH_UPDATED_AT);
    await seedAgent(store, "fresh-running", "fresh", "running");
    await seedSession(store, "terminal", "completed", STALE_UPDATED_AT);

    const swept = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);

    // Stale active session → abandoned, stamped at NOW.
    const stale = await getSession(store, "stale");
    assert.equal(stale?.status, "abandoned");
    assert.equal(stale?.ended_at, NOW);
    assert.equal(stale?.updated_at, NOW);

    // Its running agent → completed at NOW; its already-completed agent stays put.
    const staleRunning = await getAgent(store, "stale-running");
    assert.equal(staleRunning?.status, "completed");
    assert.equal(staleRunning?.ended_at, NOW);
    const staleDone = await getAgent(store, "stale-done");
    assert.equal(staleDone?.status, "completed");
    assert.equal(staleDone?.ended_at, null); // untouched (NOT IN guard)

    // Fresh active session (updated after cutoff) is untouched.
    const fresh = await getSession(store, "fresh");
    assert.equal(fresh?.status, "active");
    const freshRunning = await getAgent(store, "fresh-running");
    assert.equal(freshRunning?.status, "running");

    // A terminal session is never a sweep target regardless of staleness.
    const terminal = await getSession(store, "terminal");
    assert.equal(terminal?.status, "completed");
  } finally {
    await close();
  }
});

test("sweepOrphanedSessions returns 0 and writes nothing when no session is stale", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "fresh", "active", FRESH_UPDATED_AT);
    await seedAgent(store, "fresh-running", "fresh", "running");

    const swept = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 0);

    const fresh = await getSession(store, "fresh");
    assert.equal(fresh?.status, "active");
    const freshRunning = await getAgent(store, "fresh-running");
    assert.equal(freshRunning?.status, "running");
  } finally {
    await close();
  }
});

// Retention sweep: default window is 90 days, so anchor activity timestamps
// relative to NOW to land clearly inside/outside that window.
const EXPIRED_ACTIVITY = "2026-01-01T00:00:00.000Z"; // ~176d before NOW → expired
const RECENT_ACTIVITY = "2026-06-20T00:00:00.000Z"; // ~6d before NOW → retained

async function seedSessionWithActivity(
  store: Store,
  id: string,
  status: string,
  lastActivityAt: string
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, last_activity_at, data_revision) VALUES ($1, $2, $3, $4)",
    [id, status, lastActivityAt, 1]
  );
}

async function seedEvent(
  store: Store,
  id: string,
  sessionId: string
): Promise<void> {
  await store.query(
    "INSERT INTO events (id, session_id, event_type, data) VALUES ($1, $2, $3, $4)",
    [id, sessionId, "UserPromptSubmit", "secret transcript"]
  );
}

async function seedTokenUsage(store: Store, sessionId: string): Promise<void> {
  await store.query(
    "INSERT INTO token_usage (session_id, model) VALUES ($1, $2)",
    [sessionId, "claude-opus-4-8"]
  );
}

async function seedTokenEvent(store: Store, sessionId: string): Promise<void> {
  await store.query(
    "INSERT INTO token_events (session_id, model, created_at) VALUES ($1, $2, $3)",
    [sessionId, "claude-opus-4-8", EXPIRED_ACTIVITY]
  );
}

async function seedSessionAnalytics(
  store: Store,
  sessionId: string
): Promise<void> {
  await store.query(
    "INSERT INTO session_analytics (session_id, started_at, est_cost) VALUES ($1, $2, $3)",
    [sessionId, EXPIRED_ACTIVITY, 1.23]
  );
  await store.query(
    "INSERT INTO session_tool_analytics (session_id, tool_name, invocations) VALUES ($1, $2, $3)",
    [sessionId, "Bash", 5]
  );
}

async function seedTurnBucket(store: Store, sessionId: string): Promise<void> {
  await store.query(
    "INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count) VALUES ($1, $2, $3, $4)",
    [sessionId, EXPIRED_ACTIVITY, "human", 3]
  );
}

async function seedPullRequest(
  store: Store,
  id: string,
  sessionId: string
): Promise<void> {
  await store.query(
    "INSERT INTO pull_requests (id, session_id, pr_url, repo_full_name) VALUES ($1, $2, $3, $4)",
    [id, sessionId, "https://github.com/acme/repo/pull/1", "acme/repo"]
  );
  await store.query(
    "INSERT INTO pr_backfill_seen (session_id, scanned_at) VALUES ($1, $2)",
    [sessionId, EXPIRED_ACTIVITY]
  );
}

async function countBySession(
  store: Store,
  table: string,
  sessionId: string
): Promise<number> {
  const result = await store.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = $1`,
    [sessionId]
  );
  return Number(result.rows[0]?.n ?? 0);
}

test("sweepExpiredSessions purges terminal sessions past the retention window and their child rows", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Expired terminal session with a full child fan-out.
    await seedSessionWithActivity(store, "old", "completed", EXPIRED_ACTIVITY);
    await seedAgent(store, "old-agent", "old", "completed");
    await seedEvent(store, "old-event", "old");
    await seedTokenUsage(store, "old");
    await seedTokenEvent(store, "old");
    await seedSessionAnalytics(store, "old");
    await seedTurnBucket(store, "old");
    await seedPullRequest(store, "old-pr", "old");

    // Expired but still active → must survive (only terminal sessions purge).
    await seedSessionWithActivity(
      store,
      "old-active",
      "active",
      EXPIRED_ACTIVITY
    );
    // Terminal but recent → inside the window, must survive.
    await seedSessionWithActivity(store, "recent", "error", RECENT_ACTIVITY);
    await seedEvent(store, "recent-event", "recent");

    const purged = await sweepExpiredSessions(prisma, NOW);
    assert.equal(purged, 1);

    // The expired terminal session and every child row are gone.
    assert.equal(await getSession(store, "old"), undefined);
    assert.equal(await getAgent(store, "old-agent"), undefined);
    assert.equal(await countBySession(store, "events", "old"), 0);
    assert.equal(await countBySession(store, "token_usage", "old"), 0);
    assert.equal(await countBySession(store, "token_events", "old"), 0);
    assert.equal(await countBySession(store, "session_analytics", "old"), 0);
    assert.equal(
      await countBySession(store, "session_tool_analytics", "old"),
      0
    );
    assert.equal(await countBySession(store, "session_turn_bucket", "old"), 0);
    assert.equal(await countBySession(store, "pull_requests", "old"), 0);
    assert.equal(await countBySession(store, "pr_backfill_seen", "old"), 0);

    // Active-but-old and terminal-but-recent sessions are untouched.
    assert.equal((await getSession(store, "old-active"))?.status, "active");
    assert.equal((await getSession(store, "recent"))?.status, "error");
    assert.equal(await countBySession(store, "events", "recent"), 1);
  } finally {
    await close();
  }
});

test("sweepExpiredSessions returns 0 and writes nothing when no session is past the window", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSessionWithActivity(
      store,
      "recent",
      "completed",
      RECENT_ACTIVITY
    );
    await seedEvent(store, "recent-event", "recent");

    const purged = await sweepExpiredSessions(prisma, NOW);
    assert.equal(purged, 0);

    assert.equal((await getSession(store, "recent"))?.status, "completed");
    assert.equal(await countBySession(store, "events", "recent"), 1);
  } finally {
    await close();
  }
});

test("sweepExpiredSessions honors a custom retention window", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // ~6 days old: retained at 90d, purged at a 1-day window.
    await seedSessionWithActivity(
      store,
      "recent",
      "completed",
      RECENT_ACTIVITY
    );

    assert.equal(await sweepExpiredSessions(prisma, NOW, 90), 0);
    assert.equal((await getSession(store, "recent"))?.status, "completed");

    assert.equal(await sweepExpiredSessions(prisma, NOW, 1), 1);
    assert.equal(await getSession(store, "recent"), undefined);
  } finally {
    await close();
  }
});
