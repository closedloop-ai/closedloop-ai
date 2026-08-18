import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Harness } from "@repo/lib/harness/types";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { createSqliteSessionStore } from "../src/main/database/read-stores.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/**
 * `getHistoricalWithDetails` memoizes its rows, and the invalidation that clears
 * that memo is DETACHED from the read: the db-host worker fires
 * `handleSessionMutation(...).catch(...)` without awaiting it
 * (`db-host/db-host-worker.ts`), so an invalidation lands whenever the event loop
 * says it does — including in the middle of an in-flight historical read, which
 * since ISS-6199 awaits a pooled query and then two more pooled reads inside
 * `attachEstimatedCosts`.
 *
 * Two things must hold across that window, and neither is visible in a plain
 * result assertion:
 *
 *  - the read must never PUBLISH rows an invalidation has already retired. The
 *    rows were read from a snapshot taken before the mutation committed, so
 *    caching them re-serves known-stale data until the NEXT mutation happens to
 *    clear it again.
 *  - the read must never RETURN the memo field itself after awaiting, because an
 *    invalidation lands on that field as `null` — from a method whose signature
 *    promises `SessionWithAgents[]`, and whose `getAllWithDetails` caller spreads
 *    the result (`TypeError: … is not iterable`).
 *
 * Both are pinned by driving the invalidation from a `prisma.read` dispatch hook,
 * so the interleaving is deterministic rather than timing-dependent: dispatch 1
 * is the historical CTE query, dispatches 2 and 3 are `attachEstimatedCosts`.
 */

const SESSION_ID = "historical-cache-session";
const STARTED_AT = "2026-06-20T10:00:00.000Z";

type DispatchState = {
  dispatches: number;
  onDispatch: ((dispatch: number) => void | Promise<void>) | null;
};

test("ISS-6199: an invalidation during cost decoration does not make the historical read return null", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedTerminalSession(db);
    const state: DispatchState = { dispatches: 0, onDispatch: null };
    const store = createSqliteSessionStore(withDispatchHook(prisma, state));
    // Dispatch 2 is the first `attachEstimatedCosts` read: the rows have been
    // built into the local array but NOT yet published to the memo, and the
    // generation check that decides whether they ever are has not run.
    state.onDispatch = (dispatch) => {
      if (dispatch === 2) {
        store.invalidateHistoricalDetails();
      }
    };

    const historical = await store.getHistoricalWithDetails();

    assert.ok(
      Array.isArray(historical),
      "getHistoricalWithDetails returns an array, never the nulled memo field"
    );
    assert.equal(
      historical.length,
      1,
      "the rows it already read are still returned to the caller"
    );
  } finally {
    await close();
  }
});

test("ISS-6199: an invalidation during the historical query is not overwritten by the in-flight result", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedTerminalSession(db);
    const state: DispatchState = { dispatches: 0, onDispatch: null };
    const store = createSqliteSessionStore(withDispatchHook(prisma, state));
    // Dispatch 1 is the historical query itself: the invalidation lands while its
    // rows are still in flight, so those rows must not become the new memo.
    state.onDispatch = (dispatch) => {
      if (dispatch === 1) {
        store.invalidateHistoricalDetails();
      }
    };

    await store.getHistoricalWithDetails();
    const afterFirstRead = state.dispatches;
    await store.getHistoricalWithDetails();

    assert.ok(
      state.dispatches > afterFirstRead,
      "the invalidated read did not publish its stale rows, so the next read re-queries"
    );
  } finally {
    await close();
  }
});

test("ISS-6199: the PRODUCTION mutation path's invalidation is not overwritten by the in-flight result", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedTerminalSession(db);
    const state: DispatchState = { dispatches: 0, onDispatch: null };
    const store = createSqliteSessionStore(withDispatchHook(prisma, state));
    // The detached invalidation production actually runs is
    // `handleSessionMutation` (db-host-worker fires it un-awaited), NOT
    // `invalidateHistoricalDetails` — which every other case here drives. Without
    // this case the mutation path could lose its generation bump and stay green.
    // Awaited inside the hook so its own writer-side status read resolves before
    // the cost decoration continues; it reads `prisma.client`, so it does not
    // re-enter this hook.
    state.onDispatch = async (dispatch) => {
      if (dispatch === 2) {
        await store.handleSessionMutation(SESSION_ID);
      }
    };

    const historical = await store.getHistoricalWithDetails();

    assert.ok(
      Array.isArray(historical),
      "the mutation-path invalidation does not make the read return the nulled memo"
    );
    const afterFirstRead = state.dispatches;
    await store.getHistoricalWithDetails();

    assert.ok(
      state.dispatches > afterFirstRead,
      "the mutation-path invalidation was honored, so the stale rows were not published"
    );
  } finally {
    await close();
  }
});

test("ISS-6199: an uninvalidated historical read is served from the memo", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedTerminalSession(db);
    const state: DispatchState = { dispatches: 0, onDispatch: null };
    const store = createSqliteSessionStore(withDispatchHook(prisma, state));

    await store.getHistoricalWithDetails();
    const afterFirstRead = state.dispatches;
    await store.getHistoricalWithDetails();

    assert.ok(
      afterFirstRead > 0,
      "the first read actually dispatched onto the pool"
    );
    assert.equal(
      state.dispatches,
      afterFirstRead,
      "the second read issued no further dispatches — the memo is what the test above proves is skipped"
    );
  } finally {
    await close();
  }
});

/** A terminal session with a token row, so the historical read returns a row AND
 * `attachEstimatedCosts` runs its two pooled reads rather than its empty guard. */
async function seedTerminalSession(db: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, 'Historical Session', $2, $3, $3, $4)`,
    [SESSION_ID, SESSION_STATUS.INACTIVE, STARTED_AT, Harness.Claude]
  );
  await db.query(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, created_at)
       VALUES ($1, 'claude-sonnet-4-5', 300, 100, $2)`,
    [SESSION_ID, STARTED_AT]
  );
}

/** `prisma` with every pooled dispatch counted and a hook AWAITED at dispatch
 * time, before that read is issued — the seam an out-of-band invalidation
 * arrives on. Awaiting the hook is what makes the interleaving deterministic
 * even when the injected invalidation has to await a read of its own. */
function withDispatchHook(
  prisma: DesktopPrisma,
  state: DispatchState
): DesktopPrisma {
  return {
    ...prisma,
    read: async (fn) => {
      state.dispatches += 1;
      await state.onDispatch?.(state.dispatches);
      return await prisma.read(fn);
    },
  };
}
