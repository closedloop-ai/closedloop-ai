/**
 * @file sync-source-session-presence-contract.test.ts
 * @description ISS-6031: the `sessions`-row existence probe, against a real
 * libSQL store.
 *
 * This is the read the sync lane's disposal decision now rests on, so it is
 * pinned at the SQLite boundary rather than only through a test double. The
 * property that matters is asymmetric: reporting a present row as absent
 * destroys the only copy of the data, while the reverse costs one retry. So the
 * cases below are chosen to break the "absent" answer if it can be broken —
 * across the internal chunk boundary, on an empty request, and on ids that were
 * never in the table at all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_INSERT_PARAM_CAP } from "../src/main/database/db-constants.js";
import { findSqliteExistingSessionIds } from "../src/main/database/sync-source-session-rows.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { type SeedSessionRow, seedSessions } from "./session-sweep-fixtures.js";

const ACTIVITY = "2026-06-20T00:00:00.000Z";

function seedRow(id: string): SeedSessionRow {
  return {
    id,
    status: "inactive",
    updatedAt: ACTIVITY,
    lastActivityAt: ACTIVITY,
    startedAt: ACTIVITY,
    endsWithError: null,
  };
}

test("ISS-6031: the presence probe returns every existing id across the internal chunk boundary", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Straddle `EVENT_INSERT_PARAM_CAP` so the probe's chunk loop runs more than
    // once. Sized from the REAL constant, not a hardcoded number, so it keeps
    // crossing the boundary if the cap ever moves — the same discipline
    // `retention-sweep-chunking.test.ts` uses for the purge loop.
    const total = EVENT_INSERT_PARAM_CAP + 5;
    const ids = Array.from(
      { length: total },
      (_, index) => `s${String(index).padStart(4, "0")}`
    );
    await seedSessions(store, ids.map(seedRow));

    const present = await findSqliteExistingSessionIds(prisma, ids);

    assert.equal(
      present.length,
      total,
      "asking for N existing ids returns N — a short answer here is a deletion"
    );
    assert.deepEqual(
      [...present].sort(),
      [...ids].sort(),
      "every requested id comes back, including the ids past the chunk boundary"
    );
  } finally {
    await close();
  }
});

test("ISS-6031: the presence probe reports only the ids that are genuinely absent", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSessions(store, [seedRow("kept-a"), seedRow("kept-b")]);

    const present = await findSqliteExistingSessionIds(prisma, [
      "kept-a",
      "never-existed",
      "kept-b",
    ]);

    assert.deepEqual(
      [...present].sort(),
      ["kept-a", "kept-b"],
      "a mixed request separates present from absent rather than answering all-or-nothing"
    );
    assert.deepEqual(
      await findSqliteExistingSessionIds(prisma, []),
      [],
      "an empty request short-circuits without issuing a read"
    );
  } finally {
    await close();
  }
});
