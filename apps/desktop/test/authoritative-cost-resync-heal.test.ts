/**
 * @file authoritative-cost-resync-heal.test.ts
 * @description ISS-7229. Proves the boot pass re-queues sessions whose
 * authoritative cost migration 0074 filled locally without ever offering it to
 * the cloud, that it CONVERGES, and — the property that made this a pass instead
 * of an `UPDATE` in the migration — that it does not collapse the population
 * onto one sync watermark.
 *
 * The convergence case is not decoration. This pass selects on
 * `authoritative_cost_usd IS NOT NULL`, which a re-queue does not change at all,
 * so the obvious implementation re-bumps the same population on every boot
 * forever and churns the durable sync cursor. A single-run fixture cannot
 * observe that, so the claim is made across TWO runs.
 *
 * The FEA-3485 case is the one this file exists for. The first draft of this
 * repair was a one-line `UPDATE … SET updated_at = strftime('now')` in migration
 * 0077_iss7229_authoritative_cost_resync_seen, which stamps ONE identical
 * instant across every affected row; the sync
 * cursor then carries that whole tied-top group as uncapped `id NOT IN (…)`
 * placeholders on every incremental tick. Nothing about a re-queue's OUTCOME
 * distinguishes the two designs — both bump every row — so only an assertion
 * about the SPREAD of the stamps can tell them apart.
 *
 * The durable cursor (`listUpdatedSessionCursorRows`) selects by
 * `sessions.updated_at`, so the bump IS the re-queue; these tests assert on that
 * column and on the marker table, which are the pass's only two writes.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { requeueBackfilledAuthoritativeCosts } from "../src/main/database/authoritative-cost-resync-heal.js";
import type { OpenTestPrisma } from "./prisma-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** Historical rows, already behind any realistic sync cursor. */
const SEEDED_UPDATED_AT = "2026-06-01T00:00:00.000Z";

const BACKFILLED_SESSION = "s-backfilled";
const SECOND_BACKFILLED_SESSION = "s-backfilled-2";
const NO_COST_SESSION = "s-no-cost";

const BACKFILLED_COST = 12.5;
const SECOND_BACKFILLED_COST = 0.000_004;

type Store = OpenTestPrisma["db"];

async function seedSession(
  store: Store,
  id: string,
  costUsd: number | null
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, last_activity_at, authoritative_cost_usd) VALUES ($1, 'inactive', $2, $2, $3)",
    [id, SEEDED_UPDATED_AT, costUsd]
  );
}

async function updatedAt(store: Store, id: string): Promise<string | null> {
  const result = await store.query<{ updated_at: string | null }>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    [id]
  );
  return result.rows[0]?.updated_at ?? null;
}

async function markers(
  store: Store
): Promise<{ session_id: string; cost_usd: number }[]> {
  const result = await store.query<{ session_id: string; cost_usd: number }>(
    "SELECT session_id, cost_usd FROM authoritative_cost_resync_seen ORDER BY session_id",
    []
  );
  return result.rows.map((row) => ({
    session_id: row.session_id,
    cost_usd: Number(row.cost_usd),
  }));
}

test("ISS-7229: re-queues a backfilled session and leaves a costless one alone", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, BACKFILLED_SESSION, BACKFILLED_COST);
    await seedSession(store, NO_COST_SESSION, null);

    const result = await requeueBackfilledAuthoritativeCosts(
      prisma,
      () => undefined
    );

    assert.equal(
      result.requeued,
      1,
      "exactly the backfilled session re-queued"
    );
    assert.equal(result.unusableCosts, 0);

    const bumped = await updatedAt(store, BACKFILLED_SESSION);
    assert.ok(
      bumped !== null && bumped > SEEDED_UPDATED_AT,
      "the backfilled session is bumped past the cursor, which IS the re-queue"
    );

    // The negative's positive sibling is the assertion directly above: a pass
    // that bumped nothing would satisfy this line just as well.
    assert.equal(
      await updatedAt(store, NO_COST_SESSION),
      SEEDED_UPDATED_AT,
      "a session 0074 never filled has nothing to re-deliver and is untouched"
    );

    assert.deepEqual(
      await markers(store),
      [{ session_id: BACKFILLED_SESSION, cost_usd: BACKFILLED_COST }],
      "only the re-queued session is marked, carrying the figure that selected it"
    );
  } finally {
    await close();
  }
});

test("ISS-7229: re-queues a backfilled ZERO, which is a measurement and not an absence", async () => {
  // `0` is falsy and the column is nullable, so any guard written as a
  // truthiness check would drop this session — turning "Claude charged nothing"
  // into "nothing was ever captured" and stranding a real figure locally.
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, BACKFILLED_SESSION, 0);

    const result = await requeueBackfilledAuthoritativeCosts(
      prisma,
      () => undefined
    );

    assert.equal(result.requeued, 1);
    assert.deepEqual(await markers(store), [
      { session_id: BACKFILLED_SESSION, cost_usd: 0 },
    ]);
  } finally {
    await close();
  }
});

test("ISS-7229: a second run is a no-op — the pass cannot churn the sync cursor", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, BACKFILLED_SESSION, BACKFILLED_COST);
    await seedSession(store, SECOND_BACKFILLED_SESSION, SECOND_BACKFILLED_COST);

    const first = await requeueBackfilledAuthoritativeCosts(
      prisma,
      () => undefined
    );
    assert.equal(first.requeued, 2, "both backfilled sessions re-queued once");
    const afterFirst = await Promise.all([
      updatedAt(store, BACKFILLED_SESSION),
      updatedAt(store, SECOND_BACKFILLED_SESSION),
    ]);

    // The costs are UNCHANGED by the first run — which is exactly why a pass
    // keyed on the predicate alone would select them again here.
    const second = await requeueBackfilledAuthoritativeCosts(
      prisma,
      () => undefined
    );

    assert.equal(
      second.requeued,
      0,
      "the second run re-queues nothing: no boot after the first pays for this repair"
    );
    assert.deepEqual(
      await Promise.all([
        updatedAt(store, BACKFILLED_SESSION),
        updatedAt(store, SECOND_BACKFILLED_SESSION),
      ]),
      afterFirst,
      "and it moves no watermark, so the durable cursor sees nothing to re-walk"
    );
  } finally {
    await close();
  }
});

test("ISS-7229: chunks land on DISTINCT watermarks, not one shared instant (FEA-3485)", async () => {
  // The case that separates this pass from the migration it replaced. Both
  // designs re-queue every row; only the spread of the stamps tells them apart.
  // A chunk size of 1 makes every session its own chunk, so a shared-`now`
  // implementation collapses all four onto one value and this fails.
  const { db: store, prisma, close } = await openTestPrisma();
  const ids = ["s-a", "s-b", "s-c", "s-d"];
  try {
    for (const id of ids) {
      await seedSession(store, id, BACKFILLED_COST);
    }

    const result = await requeueBackfilledAuthoritativeCosts(
      prisma,
      () => undefined,
      1
    );
    assert.equal(result.requeued, ids.length);

    const stamps = await Promise.all(ids.map((id) => updatedAt(store, id)));
    assert.equal(
      new Set(stamps).size,
      ids.length,
      "every chunk carries its own watermark, so the tied-top group stays one chunk wide"
    );
    // Strictly increasing, not merely distinct: the cursor orders on this
    // column, so stamps that differed but went backwards would put later chunks
    // behind earlier ones.
    const sorted = [...stamps].sort();
    assert.deepEqual(
      stamps,
      sorted,
      "and they advance in the pass's own order"
    );
  } finally {
    await close();
  }
});

test("ISS-7229: an unstorable stored figure is reported and left unqueued", async () => {
  // The column can hold a row from any past producer. Re-queuing a figure the
  // cloud's own width guard will refuse would ask the lane to ship something
  // that cannot land, and marking it would record the ask as done.
  const { db: store, prisma, close } = await openTestPrisma();
  const logged: string[] = [];
  try {
    await seedSession(store, BACKFILLED_SESSION, 1e9);

    const result = await requeueBackfilledAuthoritativeCosts(
      prisma,
      (message) => logged.push(message),
      1
    );

    assert.equal(result.requeued, 0);
    assert.equal(result.unusableCosts, 1);
    assert.equal(
      await updatedAt(store, BACKFILLED_SESSION),
      SEEDED_UPDATED_AT,
      "left behind the cursor so a later boot can re-examine it"
    );
    assert.deepEqual(await markers(store), [], "and never marked as asked-for");
    assert.ok(
      logged.some((message) => message.includes(BACKFILLED_SESSION)),
      "the condition is reported rather than absorbed"
    );
  } finally {
    await close();
  }
});
