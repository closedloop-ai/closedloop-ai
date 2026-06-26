/**
 * @file maintenance-write-txs.test.ts
 * @description FEA-1791 / PLN-886 Phase 3 — electron-free coverage for the
 * first slice of the write-tx core: the standalone maintenance write
 * transaction `sweepOrphanedSessions`, moved off the raw `db.transaction` onto
 * `prisma.write((client) => client.$transaction(...))` on the single client.
 * Built over the shared {@link openTestPrisma} harness so it runs locally as
 * well as in CI. (`deleteSessionRow` — the other tx in this slice — is an inline
 * db method validated end-to-end, incl. the agents FK cascade, by
 * fea1785-data-revision-rebuild.test.ts test 12.)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sweepOrphanedSessions } from "../src/main/database/session-maintenance.js";
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
