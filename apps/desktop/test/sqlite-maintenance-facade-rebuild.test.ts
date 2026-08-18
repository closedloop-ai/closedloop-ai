/**
 * @file sqlite-maintenance-facade-rebuild.test.ts
 * @description ISS-5400: branch coverage for the two most complex bodies that
 * moved into the maintenance facade —
 * `rebuildComponentInvocationsFromStoredRows` and `rebuildSessionFromParse`.
 *
 * The methods themselves were already reached by existing suites, but their
 * GUARD and FAILURE branches were not: the facade sat at 79.4% branch coverage
 * with the uncovered ranges inside exactly these two. Each guard encodes a
 * decision the DATA_REVISION rebuild depends on, and each returns the same
 * `{ rebuilt: false }` shape, so a broken guard is silent — the sweep simply
 * stops rebuilding, or rebuilds something it should have left alone, and no test
 * notices.
 *
 * The four decisions pinned here, per `staleRebuildSkip`'s contract:
 *
 *  - falsy id / malformed session ⇒ refuse without touching the store
 *  - session row absent           ⇒ `{ rebuilt: false, activeRace: false }`
 *  - session NON-TERMINAL         ⇒ `{ rebuilt: false, activeRace: true }` (heals via import)
 *  - session already at revision  ⇒ `{ rebuilt: false, activeRace: false }` (a no-op, not a rebuild)
 *
 * Plus the isolation contract that makes the boot sweep survivable: a rebuild
 * that THROWS must be logged and reported as not-rebuilt, never propagated —
 * the sweep re-derives thousands of sessions and one poisoned row must not abort
 * the rest.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createMaintenanceFacade } from "../src/main/database/sqlite-maintenance-facade.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

type Store = OpenTestPrisma["db"];

const NOW = "2026-06-22T12:00:00.000Z";
const CURRENT_REVISION = 42;

function facadeFor(
  prisma: OpenTestPrisma["prisma"],
  log: (message: string) => void = () => {
    /* most tests assert return values, not logs */
  }
) {
  return createMaintenanceFacade({
    prisma,
    log,
    nowFn: () => NOW,
    detectBillingMode: () => "unknown",
    supportsRowDigest: () => Promise.resolve(false),
    tokenUsage: {} as Parameters<
      typeof createMaintenanceFacade
    >[0]["tokenUsage"],
  });
}

async function seedSession(
  store: Store,
  id: string,
  status: string,
  dataRevision: number
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, last_activity_at, data_revision) VALUES ($1, $2, $3, $3, $4)",
    [id, status, NOW, dataRevision]
  );
}

async function countAgentComponentInvocations(store: Store): Promise<number> {
  const result = await store.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_component_invocations"
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * A falsy id short-circuits to the SAME `{ rebuilt: false, activeRace: false }`
 * an absent session produces (`findUnique` → null → `staleRebuildSkip`), so the
 * return value cannot distinguish the guard from its absence — verified by
 * mutation: deleting the guard leaves a return-value-only assertion green.
 *
 * What the guard actually buys is not opening a write transaction at all. On the
 * DATA_REVISION sweep that is thousands of needless trips through the single
 * serialized writer. So the assertion has to be on `prisma.write` never being
 * reached, which is what this spy records.
 */
function writeCountingPrisma(prisma: OpenTestPrisma["prisma"]): {
  spied: OpenTestPrisma["prisma"];
  writes: () => number;
} {
  let writes = 0;
  const spied = Object.create(
    Object.getPrototypeOf(prisma) as object
  ) as OpenTestPrisma["prisma"];
  Object.assign(spied, prisma, {
    write: (...args: Parameters<OpenTestPrisma["prisma"]["write"]>) => {
      writes += 1;
      return prisma.write(...args);
    },
  });
  return { spied, writes: () => writes };
}

test("ISS-5400: a falsy sessionId short-circuits BEFORE the write transaction opens", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "s1", SESSION_STATUS.INACTIVE, 1);
    const before = await countAgentComponentInvocations(store);
    const { spied, writes } = writeCountingPrisma(prisma);
    const facade = facadeFor(spied);

    const result = await facade.rebuildComponentInvocationsFromStoredRows(
      "",
      CURRENT_REVISION
    );

    assert.deepEqual(result, { rebuilt: false, activeRace: false });
    assert.equal(
      writes(),
      0,
      "the falsy-id guard must refuse before enqueuing on the single writer"
    );
    assert.equal(await countAgentComponentInvocations(store), before);

    // Control: a real id DOES reach the writer, so the assertion above is
    // measuring the guard rather than a spy that never records anything.
    await facade.rebuildComponentInvocationsFromStoredRows(
      "s1",
      CURRENT_REVISION
    );
    assert.equal(writes(), 1);
  } finally {
    await close();
  }
});

test("ISS-5400: an absent session is not a rebuild and not an active race", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const result = await facadeFor(
      prisma
    ).rebuildComponentInvocationsFromStoredRows(
      "never-imported",
      CURRENT_REVISION
    );

    assert.deepEqual(result, { rebuilt: false, activeRace: false });
  } finally {
    await close();
  }
});

test("ISS-5400: a NON-TERMINAL session reports an active race so import heals it instead", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Stale by revision, but still running — the boot list is a pre-drain
    // snapshot, so the writer tx re-checks and defers to ordinary import.
    await seedSession(store, "still-running", "active", 1);

    const result = await facadeFor(
      prisma
    ).rebuildComponentInvocationsFromStoredRows(
      "still-running",
      CURRENT_REVISION
    );

    assert.deepEqual(
      result,
      { rebuilt: false, activeRace: true },
      "a non-terminal session must be reported as an active race, not a plain skip"
    );
  } finally {
    await close();
  }
});

test("ISS-5400: a terminal session ALREADY at the current revision is a no-op, not a rebuild (wongk #4255)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // A watcher import sealed this session at the current revision after the
    // snapshot was taken. Rebuilding would delete a fully-derived invocation set
    // and replace it with one reconstructed from stored rows, which cannot emit
    // Hook candidates — and re-stamp the same revision, so nothing would ever
    // select it again.
    await seedSession(
      store,
      "already-fresh",
      SESSION_STATUS.INACTIVE,
      CURRENT_REVISION
    );

    const result = await facadeFor(
      prisma
    ).rebuildComponentInvocationsFromStoredRows(
      "already-fresh",
      CURRENT_REVISION
    );

    assert.deepEqual(result, { rebuilt: false, activeRace: false });
  } finally {
    await close();
  }
});

test("ISS-5400: a terminal, stale session IS rebuilt", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "stale-terminal", SESSION_STATUS.INACTIVE, 1);

    const result = await facadeFor(
      prisma
    ).rebuildComponentInvocationsFromStoredRows(
      "stale-terminal",
      CURRENT_REVISION
    );

    // Proves the guards above are selective rather than refusing everything —
    // without this, all four skip assertions would pass on a method that never
    // rebuilds at all.
    assert.equal(result.rebuilt, true);
    assert.equal(result.activeRace, false);
  } finally {
    await close();
  }
});

test("ISS-5400: a throwing rebuild is logged and reported, never propagated (the boot sweep must survive one bad session)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const logged: string[] = [];
    // Close the store out from under the facade so the write transaction raises.
    await close();

    const result = await facadeFor(prisma, (message) =>
      logged.push(message)
    ).rebuildComponentInvocationsFromStoredRows(
      "any-session",
      CURRENT_REVISION
    );

    assert.deepEqual(
      result,
      { rebuilt: false, activeRace: false },
      "a failed rebuild must report not-rebuilt rather than throwing into the sweep"
    );
    assert.equal(
      logged.some((m) =>
        m.includes("rebuildComponentInvocationsFromStoredRows failed")
      ),
      true,
      "the swallowed error must be logged — it is the only trace the sweep leaves"
    );
  } finally {
    // `close()` already ran above; a second call would target a disposed handle.
  }
});

test("ISS-5400: rebuildSessionFromParse refuses a session missing its id or startedAt", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const facade = facadeFor(prisma);
    const bare = { sessionId: "", startedAt: NOW } as Parameters<
      typeof facade.rebuildSessionFromParse
    >[0];
    const undated = { sessionId: "s1", startedAt: "" } as Parameters<
      typeof facade.rebuildSessionFromParse
    >[0];

    assert.deepEqual(await facade.rebuildSessionFromParse(bare, "claude"), {
      rebuilt: false,
      activeRace: false,
    });
    assert.deepEqual(await facade.rebuildSessionFromParse(undated, "claude"), {
      rebuilt: false,
      activeRace: false,
    });
  } finally {
    await close();
  }
});
