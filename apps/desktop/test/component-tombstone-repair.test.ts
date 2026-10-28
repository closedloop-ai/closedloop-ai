/**
 * @file component-tombstone-repair.test.ts
 * @description ISS-6906 regression coverage: the one-time repair that re-enters
 * PRE-ISS-6881 tombstones into the component-sync keyset lane.
 *
 * ISS-6881 made new tombstones advance the lane's ordering key. It could not repair
 * the rows the old writers had already tombstoned — their key still sits where the
 * row was when it was INSTALLED, behind the persisted cursor, and every tombstone
 * writer is guarded by `uninstalled_at IS NULL`, so no scan can restamp them. Those
 * uninstalls never reach the cloud, and org inventory/search keep presenting a
 * removed component as installed. PR #5201 pinned that as an explicit KNOWN
 * LIMITATION test; this suite is what retires it.
 *
 * Four properties are load-bearing, and each case below is written so that
 * removing the production line it covers turns it RED:
 *
 *  1. a stranded uninstall re-enters the lane, and is delivered EXACTLY once;
 *  2. running the repair twice does not double-emit — the second run is a no-op,
 *     asserted by its return value and by the lane, not by "it did not throw";
 *  3. a tombstone that was already delivered correctly is NOT re-emitted. This is
 *     what makes the pass safe to ship rather than merely convergent, so its
 *     fixture is built by the REAL post-fix writer and never by hand;
 *  4. the ordering key is the repair's OWN scan instant — never the row's
 *     historical `uninstalled_at`, which would re-file the tombstone at a position
 *     the cursor has already passed and assert the lane saw it when it did not.
 *
 * All THREE pre-fix writer shapes are represented, because they do not agree: the MCP
 * and pack-projected writers left `last_seen_at < uninstalled_at`, the installed-plugin
 * writer bound one `now` to both columns and left them EQUAL, and a pre-column row has
 * no key at all. Covering only the first would let the predicate's `<=` weaken to `<`
 * with the suite still green while every stranded installed-plugin row stayed stranded.
 *
 * Every lane assertion drives the REAL cursor query through the shared lane
 * simulator from a DRAINED position, and each case asserts that drained precondition
 * before it asserts anything else — a fixture whose cursor sits behind the row passes
 * with or without the repair.
 */

import assert from "node:assert/strict";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { test } from "vitest";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { startBootMaintenance } from "../src/main/database/boot-maintenance.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { applyComponentTombstone } from "../src/main/packs/component-tombstone.js";
import {
  type ComponentTombstoneRepairDb,
  repairStrandedComponentTombstones,
} from "../src/main/packs/component-tombstone-repair.js";
import {
  createSyncLaneSimulator,
  idsFromCursor,
  readRow,
} from "./component-sync-lane-fixture.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const INSTALLED_AT = "2026-01-01T00:00:00.000Z";
const UNINSTALLED_AT = "2026-01-02T00:00:00.000Z";
/** A later scan instant, for the post-fix writer's fixture. */
const LATER_SCAN = "2026-01-03T00:00:00.000Z";

const INSERT_COMPONENT_SQL = `INSERT INTO agent_components
     (id, component_kind, external_id, component_key, name, resolved_state,
      first_seen_at, last_seen_at, uninstalled_at)
   VALUES ($1, $2, $3, $3, $3, 'unresolved', $4, $5, $6)`;

/**
 * Seed one `agent_components` row with an EXPLICIT ordering key and tombstone state.
 *
 * `lastSeenAt` is passed through including `null`, because a legacy row predating the
 * ordering-key column is one of the two stranded shapes and a helper that defaulted
 * it would make that case unreachable.
 */
async function seedComponent(
  prisma: DesktopPrisma,
  input: {
    id: string;
    externalId: string;
    lastSeenAt: string | null;
    uninstalledAt: string | null;
  }
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      INSERT_COMPONENT_SQL,
      input.id,
      AgentComponentKind.Mcp,
      input.externalId,
      INSTALLED_AT,
      input.lastSeenAt,
      input.uninstalledAt
    )
  );
}

/**
 * Tombstone a row the way the PRE-ISS-6881 MCP and pack-projected writers did: stamp
 * `uninstalled_at` and leave the ordering key exactly where it was.
 *
 * Deliberately raw SQL rather than a production helper — the production writer no
 * longer HAS this shape, which is the whole point of the ticket, so the only honest
 * fixture for the legacy population is the statement the old writer issued
 * (`git show 6abc720b4~1:apps/desktop/src/main/packs/component-scanner.ts`).
 */
async function tombstoneWithoutAdvancingKey(
  prisma: DesktopPrisma,
  id: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE agent_components SET uninstalled_at = $1 WHERE id = $2",
      UNINSTALLED_AT,
      id
    )
  );
}

/**
 * Tombstone a row the way the PRE-ISS-6881 INSTALLED-PLUGIN writer did: bind ONE
 * `now` to both columns, leaving `last_seen_at` exactly EQUAL to `uninstalled_at`.
 *
 * A separate helper because it is a separate legacy statement, and it produces the
 * third stranded shape — the TIE. That shape is what makes the repair predicate's
 * `<=` load-bearing rather than decorative: under `<` these rows match neither
 * disjunct and stay stranded forever, and every other fixture in this file is
 * strictly-less-than and would stay green.
 */
async function tombstoneAtTheSameInstant(
  prisma: DesktopPrisma,
  id: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE agent_components
          SET uninstalled_at = $1,
              last_seen_at = $1
        WHERE id = $2`,
      UNINSTALLED_AT,
      id
    )
  );
}

test("a pre-fix tombstone re-enters the lane exactly once, and the repair is idempotent", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedComponent(prisma, {
      id: "stranded-a",
      externalId: "stranded-a",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: null,
    });
    await seedComponent(prisma, {
      id: "stranded-b",
      externalId: "stranded-b",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: null,
    });

    // The lane is fully caught up on the INSTALLED state, exactly as a real device
    // is before it removes anything: the cursor now sits on the last of these rows.
    const lane = createSyncLaneSimulator(prisma);
    await lane.drain();
    assert.deepEqual(
      lane.uninstallsDelivered,
      [],
      "nothing is uninstalled yet, so the lane must have delivered no uninstalls"
    );

    await tombstoneWithoutAdvancingKey(prisma, "stranded-a");
    await tombstoneWithoutAdvancingKey(prisma, "stranded-b");
    await lane.drain();
    // The adversarial precondition AND the defect itself: the uninstalls exist
    // locally and the lane cannot see them. Without this the case below would pass
    // whether or not the repair moved anything.
    assert.deepEqual(
      lane.uninstallsDelivered,
      [],
      "fixture must be genuinely stranded — the lane must not already have these uninstalls"
    );

    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      2,
      "the repair must re-enter both stranded uninstalls"
    );
    await lane.drain();
    assert.deepEqual(
      [...lane.uninstallsDelivered].sort(),
      ["stranded-a", "stranded-b"],
      "both stranded uninstalls must now reach the lane"
    );

    const afterFirst = await readRow(prisma, "stranded-a");
    // Idempotence, asserted on the second run's EFFECT: a repair that re-keyed the
    // rows it had already repaired would return 2 again and the lane would take the
    // same two uninstalls a second time.
    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      0,
      "a second run must select nothing — a repaired row no longer matches the predicate"
    );
    assert.equal(
      (await readRow(prisma, "stranded-a")).lastSeenAt,
      afterFirst.lastSeenAt,
      "a second run must not churn an already-repaired row's ordering key"
    );
    await lane.drain();
    assert.equal(
      lane.uninstallsDelivered.length,
      2,
      "each stranded uninstall must be delivered EXACTLY once across every drain"
    );
  } finally {
    await close();
  }
});

test("a tombstone the lane already received correctly is never re-emitted", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedComponent(prisma, {
      id: "delivered-1",
      externalId: "delivered-1",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: null,
    });
    const lane = createSyncLaneSimulator(prisma);
    await lane.drain();

    // Built by the REAL post-fix writer, so this fixture cannot drift from what
    // production actually stores for a correctly-delivered uninstall.
    assert.equal(
      await applyComponentTombstone(prisma, {
        uninstalledAt: UNINSTALLED_AT,
        scanInstant: LATER_SCAN,
        whereSql: "id = $3 AND uninstalled_at IS NULL",
        whereParams: ["delivered-1"],
      }),
      1
    );
    await lane.drain();
    assert.deepEqual(
      lane.uninstallsDelivered,
      ["delivered-1"],
      "precondition: the post-fix tombstone reaches the lane on its own"
    );
    const delivered = await readRow(prisma, "delivered-1");

    // THE safety property. A sweep that re-keyed every tombstoned row would be
    // convergent and still wrong: it would re-upload uninstalls the cloud already
    // holds, on a lane whose entire contract is that it carries only what changed.
    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      0,
      "the repair must not select a tombstone whose ordering key already cleared its uninstall instant"
    );
    assert.equal(
      (await readRow(prisma, "delivered-1")).lastSeenAt,
      delivered.lastSeenAt,
      "an already-delivered tombstone must keep its ordering key"
    );
    await lane.drain();
    assert.equal(
      lane.uninstallsDelivered.length,
      1,
      "an already-delivered uninstall must not be sent to the cloud a second time"
    );
  } finally {
    await close();
  }
});

test("the repair keys a row at its OWN scan instant, not the row's historical one", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedComponent(prisma, {
      id: "historical-1",
      externalId: "historical-1",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: UNINSTALLED_AT,
    });

    // Captured before the pass runs. Every instant in this fixture is historical, so
    // only a key derived from the repair's own clock can clear this bound — a key
    // taken from `uninstalled_at`, from the stale `last_seen_at`, or from the table
    // maximum alone all sort below it.
    const beforeRepair = new Date().toISOString();
    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      1
    );

    const repaired = await readRow(prisma, "historical-1");
    assert.ok(
      repaired.lastSeenAt !== null && repaired.lastSeenAt > beforeRepair,
      `the ordering key must come from the repair's own scan instant; got ${repaired.lastSeenAt}`
    );
    assert.equal(
      repaired.uninstalledAt,
      UNINSTALLED_AT,
      "the repair must not rewrite WHEN the component stopped being installed"
    );
  } finally {
    await close();
  }
});

test("a legacy NULL ordering key is repaired, and an installed row is left alone", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // A row predating the ordering-key column. `NULL` normalizes to '' in the
    // cursor, so it sorts before EVERY live row and is invisible to any advanced
    // cursor. A predicate written as `last_seen_at <= uninstalled_at` alone would
    // never match it, because SQL `NULL <= x` is NULL, not true.
    await seedComponent(prisma, {
      id: "legacy-null",
      externalId: "legacy-null",
      lastSeenAt: null,
      uninstalledAt: UNINSTALLED_AT,
    });
    // Still installed, and ALSO NULL-keyed. A dated installed row would not guard
    // the `uninstalled_at IS NOT NULL` conjunct at all: `LATER_SCAN <= NULL` is NULL,
    // so the remaining clauses would exclude it anyway and dropping the conjunct
    // would stay green. With both columns NULL — a real pre-column legacy state —
    // only that conjunct keeps the live inventory out of the repair, and dropping it
    // re-keys and re-uploads every installed component on the device.
    await seedComponent(prisma, {
      id: "live-null",
      externalId: "live-null",
      lastSeenAt: null,
      uninstalledAt: null,
    });

    assert.deepEqual(
      await idsFromCursor(prisma, LATER_SCAN, "zzz"),
      [],
      "precondition: the cursor is drained past both rows"
    );

    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      1,
      "exactly the NULL-keyed tombstone is repaired; the installed row is not"
    );
    assert.deepEqual(
      await idsFromCursor(prisma, LATER_SCAN, "zzz"),
      ["legacy-null"],
      "the NULL-keyed uninstall must re-enter the lane, and nothing else may"
    );
    assert.equal(
      (await readRow(prisma, "live-null")).lastSeenAt,
      null,
      "an installed row's ordering key must not move"
    );
  } finally {
    await close();
  }
});

test("a legacy TIE between last_seen_at and uninstalled_at is repaired", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedComponent(prisma, {
      id: "tied-1",
      externalId: "tied-1",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: null,
    });
    // A live sibling seen LATER than the tie instant. It is what makes this fixture
    // adversarial: the installed-plugin writer did stamp `now` on `last_seen_at`, so
    // a tie row only strands once the cursor has advanced past that instant — which
    // is the ordinary case on any device that scanned anything afterwards.
    await seedComponent(prisma, {
      id: "zz-anchor",
      externalId: "zz-anchor",
      lastSeenAt: LATER_SCAN,
      uninstalledAt: null,
    });
    const lane = createSyncLaneSimulator(prisma);
    await lane.drain();

    // The PRE-ISS-6881 installed-plugin writer bound one `now` to both columns, so
    // every installed-plugin row stranded before that build has `last_seen_at`
    // EXACTLY equal to `uninstalled_at`. Under a `<` predicate such a row matches
    // neither disjunct and stays stranded forever.
    await tombstoneAtTheSameInstant(prisma, "tied-1");
    const tied = await readRow(prisma, "tied-1");
    assert.equal(
      tied.lastSeenAt,
      tied.uninstalledAt,
      "fixture must actually TIE, or it does not cover the `<=` boundary"
    );
    await lane.drain();
    assert.deepEqual(
      lane.uninstallsDelivered,
      [],
      "precondition: a tied tombstone is behind the drained cursor"
    );

    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      1,
      "a tied tombstone is stranded and must be repaired"
    );
    await lane.drain();
    assert.deepEqual(lane.uninstallsDelivered, ["tied-1"]);
  } finally {
    await close();
  }
});

test("a tombstone no current key can clear is reported, not churned, and blocks nothing", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Corrupt data: an `uninstalled_at` in the far future. No key this pass can
    // reserve sorts above it, so re-keying the row would leave it STILL matching the
    // predicate and the pass would ship the same uninstall on every boot forever.
    await seedComponent(prisma, {
      id: "corrupt-1",
      externalId: "corrupt-1",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: "2099-01-01T00:00:00.000Z",
    });
    // Sorts AFTER the corrupt row, so it is only reached if the drain steps past a
    // row it could not repair instead of re-selecting it forever.
    await seedComponent(prisma, {
      id: "good-2",
      externalId: "good-2",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: UNINSTALLED_AT,
    });

    const logs: string[] = [];
    assert.equal(
      await repairStrandedComponentTombstones(prisma, (m) => logs.push(m), 1),
      1,
      "only the repairable row counts as repaired"
    );
    assert.equal(
      (await readRow(prisma, "corrupt-1")).lastSeenAt,
      INSTALLED_AT,
      "a row the pass cannot converge must be left untouched, never half-repaired"
    );
    assert.ok(
      (await readRow(prisma, "good-2")).lastSeenAt !== INSTALLED_AT,
      "the healthy row behind it must still be repaired"
    );
    assert.ok(
      logs.some((line) => line.includes("could not be re-entered")),
      `the unrepairable row must be reported, not silently dropped; got ${JSON.stringify(logs)}`
    );

    const secondLogs: string[] = [];
    assert.equal(
      await repairStrandedComponentTombstones(
        prisma,
        (m) => secondLogs.push(m),
        1
      ),
      0,
      "a second run must not re-key the corrupt row — that would re-emit it every boot"
    );
  } finally {
    await close();
  }
});

test("a non-canonical timestamp is not silently misclassified, it is reported", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The byte order LIES about this row. A whole-second `…:00Z` sorts ABOVE
    // `…:00.500Z` (`Z` is 0x5A, `.` is 0x2E) while being the EARLIER instant, so an
    // unguarded `last_seen_at <= uninstalled_at` reads a genuinely stranded row as
    // already-delivered and skips it — with no trace at all, which is the part that
    // matters.
    await seedComponent(prisma, {
      id: "noncanonical-skipped",
      externalId: "noncanonical-skipped",
      lastSeenAt: "2026-01-02T00:00:00Z",
      uninstalledAt: "2026-01-02T00:00:00.500Z",
    });
    // The other direction, and the one that makes the GLOB guard itself falsifiable:
    // this row's bytes DO order the way its instants do, so an unguarded predicate
    // selects and re-keys it. Only the guard keeps a value the pass cannot order out
    // of a classification it then acts on.
    await seedComponent(prisma, {
      id: "noncanonical-taken",
      externalId: "noncanonical-taken",
      lastSeenAt: "2026-01-01T00:00:00Z",
      uninstalledAt: UNINSTALLED_AT,
    });

    const logs: string[] = [];
    assert.equal(
      await repairStrandedComponentTombstones(prisma, (m) => logs.push(m)),
      0,
      "a row whose stored form cannot be ordered must not be re-keyed on a guess"
    );
    assert.equal(
      (await readRow(prisma, "noncanonical-skipped")).lastSeenAt,
      "2026-01-02T00:00:00Z",
      "the unclassifiable row must be left exactly as found"
    );
    assert.equal(
      (await readRow(prisma, "noncanonical-taken")).lastSeenAt,
      "2026-01-01T00:00:00Z",
      "an unguarded predicate would have re-keyed this row on a byte comparison"
    );
    assert.ok(
      logs.some((line) => line.includes("were not classified")),
      `an unclassifiable tombstone must be reported, never silently skipped; got ${JSON.stringify(logs)}`
    );
  } finally {
    await close();
  }
});

test("a right-width timestamp that is not a real instant is rejected, not repaired", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Every field of the canonical glob is a bare `[0-9]` class, so this value has
    // the expected WIDTH and is not a date. Its bytes also order below the ordering
    // key, so the stranded predicate selects it on shape alone — and repairing it
    // would ship the unchanged `uninstalled_at` to a cloud whose `isoDateSchema`
    // rejects it (`Date.parse` is non-finite), dead-lettering the batch and leaving
    // inventory stale. It belongs in the unreadable population, not the repaired one.
    await seedComponent(prisma, {
      id: "impossible-month",
      externalId: "impossible-month",
      lastSeenAt: "2025-01-01T00:00:00.000Z",
      uninstalledAt: "2025-13-01T00:00:00.000Z",
    });

    const logs: string[] = [];
    assert.equal(
      await repairStrandedComponentTombstones(prisma, (m) => logs.push(m)),
      0,
      "a timestamp that is not a real instant must not be re-keyed as repaired"
    );
    assert.equal(
      (await readRow(prisma, "impossible-month")).lastSeenAt,
      "2025-01-01T00:00:00.000Z",
      "the row must be left exactly as found"
    );
    assert.ok(
      logs.some((line) => line.includes("were not classified")),
      `an unreadable tombstone must be reported, never silently skipped; got ${JSON.stringify(logs)}`
    );
  } finally {
    await close();
  }
});

test("an out-of-range day still repairs — both engines roll it to the same instant", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The guard rejects values that are not real instants, NOT every value whose
    // fields look surprising. SQLite and `Date.parse` both roll `2026-06-31` to
    // July 1, so the cloud accepts it and the repair must still run — otherwise the
    // fix for the invalid case would silently strand a repairable population.
    await seedComponent(prisma, {
      id: "rolling-day",
      externalId: "rolling-day",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: "2026-06-31T00:00:00.000Z",
    });

    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => {
        // no-op: this case asserts the repair COUNT and the row, not the report
      }),
      1,
      "a rollover date is a real instant to both engines and must still be repaired"
    );
    assert.notEqual(
      (await readRow(prisma, "rolling-day")).lastSeenAt,
      INSTALLED_AT,
      "the repaired row must have been re-keyed above the lane"
    );
  } finally {
    await close();
  }
});

test("chunking repairs the whole population, with strictly ordered keys per chunk", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const ids = ["chunk-1", "chunk-2", "chunk-3"];
    for (const id of ids) {
      await seedComponent(prisma, {
        id,
        externalId: id,
        lastSeenAt: INSTALLED_AT,
        uninstalledAt: null,
      });
    }

    const lane = createSyncLaneSimulator(prisma);
    // Drain onto the LAST of these rows while they are still installed, then strand
    // them the way the old writer did — so every one is behind the cursor.
    await lane.drain();
    for (const id of ids) {
      await tombstoneWithoutAdvancingKey(prisma, id);
    }
    await lane.drain();
    assert.deepEqual(
      lane.uninstallsDelivered,
      [],
      "fixture must be genuinely stranded before the repair runs"
    );

    // One row per statement: the drain loop has to make progress across chunks, and
    // each chunk reserves its own key. A shared key across chunks would leave the
    // later chunks tied with the earlier ones on the composite `(key, id)` cursor.
    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined, 1),
      3,
      "the drain must repair every stranded row, not just the first chunk"
    );

    const keys = await Promise.all(
      ids.map(async (id) => (await readRow(prisma, id)).lastSeenAt)
    );
    const sorted = [...keys].sort();
    assert.equal(
      new Set(keys).size,
      3,
      `each chunk must reserve its own ordering key; got ${JSON.stringify(keys)}`
    );
    assert.deepEqual(
      keys,
      sorted,
      `keys must advance monotonically in repair order; got ${JSON.stringify(keys)}`
    );

    await lane.drain();
    assert.deepEqual([...lane.uninstallsDelivered].sort(), ids);
  } finally {
    await close();
  }
});

test("a non-positive chunk size is clamped rather than silently repairing nothing", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedComponent(prisma, {
      id: "clamped-1",
      externalId: "clamped-1",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: UNINSTALLED_AT,
    });

    // `LIMIT 0` selects nothing, so an unclamped size makes the pass a silent no-op
    // that reports success — the shape this repo's "clamp at both ends" rule exists
    // to stop.
    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined, 0),
      1
    );
  } finally {
    await close();
  }
});

/** Ids for the scripted-failure drain, ordered so chunk N takes `fail-N`. */
const FAILURE_DRAIN_IDS = [
  "fail-1",
  "fail-2",
  "fail-3",
  "fail-4",
  "fail-5",
  "fail-6",
];

/**
 * Chunk outcomes for the scripted-failure drain, one per chunk at `chunkSize: 1`.
 *
 * `F F S F F F` is chosen to discriminate the consecutive-failure RESET. With the
 * reset the cap is only reached at the sixth write; without it the counter still
 * stands at 2 after the success and the fourth write trips it, stopping the pass two
 * chunks early. A `F F F` script would be satisfied by both.
 */
const FAILURE_DRAIN_SCRIPT = [false, false, true, false, false, false];

test("a failing chunk steps aside for the healthy tail, and the cap counts CONSECUTIVE failures", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    for (const id of FAILURE_DRAIN_IDS) {
      await seedComponent(prisma, {
        id,
        externalId: id,
        lastSeenAt: INSTALLED_AT,
        uninstalledAt: UNINSTALLED_AT,
      });
    }

    let writes = 0;
    const scripted: ComponentTombstoneRepairDb = {
      read: (fn) => prisma.read(fn),
      write: (fn, token, opts) => {
        const succeeds = FAILURE_DRAIN_SCRIPT[writes] === true;
        writes += 1;
        return succeeds
          ? prisma.write(fn, token, opts)
          : Promise.reject(new Error("database is locked"));
      },
    };
    const logs: string[] = [];

    // The pass runs on the boot chain, so a store that is locked for the whole boot
    // must not become an unbounded walk of failing writes — and must not reject into
    // the chain, which is how a `.catch`-less future edit takes db open down.
    assert.equal(
      await repairStrandedComponentTombstones(scripted, (m) => logs.push(m), 1),
      1,
      "only the chunk whose write landed may be counted as repaired"
    );
    assert.equal(
      writes,
      6,
      "an interceding success must reset the consecutive-failure counter; the cap must not fire early"
    );
    assert.equal(
      logs.filter((line) => line.includes("database is locked")).length,
      5,
      `every failed chunk must be logged; got ${JSON.stringify(logs)}`
    );

    // Exactly the scripted-success row moved. Every other row is untouched, so it is
    // still eligible next boot — a failed pass must never record a row it could not
    // repair as repaired.
    const keys = await Promise.all(
      FAILURE_DRAIN_IDS.map(
        async (id) => (await readRow(prisma, id)).lastSeenAt
      )
    );
    assert.deepEqual(
      keys.map((key) => key === INSTALLED_AT),
      FAILURE_DRAIN_SCRIPT.map((succeeded) => !succeeded),
      `only the succeeding chunk's row may have moved; got ${JSON.stringify(keys)}`
    );
  } finally {
    await close();
  }
});

/**
 * The ISS-10027 fixture, in the shape the ISS-6906 consumer meets it: the component
 * lane's durable cursor sits AHEAD of the clock, and the `agent_components` row that
 * carried that position has been physically deleted.
 *
 * The delete is issued directly rather than through the skill-shadow phantom-command
 * sweep or migration `0045_iss4778_phantom_command_backfill` — both are real
 * producers of this state and neither is driveable from a test — so this MODELS those
 * deletes. What it pins is that the repair pass inherits the cursor floor from the
 * shared ordering-key owner rather than carrying its own derivation.
 */
const REPAIR_CURSOR_AHEAD = "2030-01-01T00:00:00.000Z";
const REPAIR_DELETED_CURSOR_ROW_ID = "iss10027-repair-deleted-row";

async function seedDurableCursorAheadOfClock(
  prisma: DesktopPrisma
): Promise<void> {
  await seedComponent(prisma, {
    id: REPAIR_DELETED_CURSOR_ROW_ID,
    externalId: REPAIR_DELETED_CURSOR_ROW_ID,
    lastSeenAt: REPAIR_CURSOR_AHEAD,
    uninstalledAt: null,
  });
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sync_state
         (source_key, observed_top_updated_at, observed_ids_at_top_updated_at, updated_at)
       VALUES ($1, $2, '[]', $3)`,
      buildAgentComponentSyncSourceKey("compute-target-iss10027"),
      REPAIR_CURSOR_AHEAD,
      INSTALLED_AT
    )
  );
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      "DELETE FROM agent_components WHERE id = $1",
      REPAIR_DELETED_CURSOR_ROW_ID
    )
  );
}

test("the repair clears a durable cursor whose row was deleted", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedComponent(prisma, {
      id: "cursor-stranded-1",
      externalId: "cursor-stranded-1",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: UNINSTALLED_AT,
    });
    await seedDurableCursorAheadOfClock(prisma);

    assert.deepEqual(
      await idsFromCursor(prisma, REPAIR_CURSOR_AHEAD, ""),
      [],
      "precondition: the durable cursor sits past every surviving row"
    );

    assert.equal(
      await repairStrandedComponentTombstones(prisma, () => undefined),
      1
    );

    const repaired = await readRow(prisma, "cursor-stranded-1");
    assert.ok(
      repaired.lastSeenAt !== null && repaired.lastSeenAt > REPAIR_CURSOR_AHEAD,
      `the repair must key the row above the DURABLE cursor, not just the surviving table maximum; got ${repaired.lastSeenAt}`
    );
    assert.deepEqual(
      await idsFromCursor(prisma, REPAIR_CURSOR_AHEAD, ""),
      ["cursor-stranded-1"],
      "the repaired uninstall must re-enter the lane from the durable cursor position"
    );
  } finally {
    await close();
  }
});

test("the boot-maintenance chain actually runs the repair", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedComponent(prisma, {
      id: "boot-wired-1",
      externalId: "boot-wired-1",
      lastSeenAt: INSTALLED_AT,
      uninstalledAt: UNINSTALLED_AT,
    });

    // Drives the PRODUCTION chain, not the pass in isolation: dropping the
    // `repairStrandedComponentTombstones` step from `boot-maintenance.ts` leaves
    // every other case in this file green while shipping a repair that never runs.
    await startBootMaintenance(prisma, () => undefined);

    const repaired = await readRow(prisma, "boot-wired-1");
    assert.ok(
      repaired.lastSeenAt !== null && repaired.lastSeenAt > UNINSTALLED_AT,
      `the boot chain must repair the stranded row; got ${repaired.lastSeenAt}`
    );
  } finally {
    await close();
  }
});
