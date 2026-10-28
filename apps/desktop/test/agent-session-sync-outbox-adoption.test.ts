/**
 * ISS-6031 follow-up: outbox rows stranded under a RETIRED compute target — a
 * partition nothing addresses, because the compute-target id is the trailing
 * segment of every source key. Driven against a real libSQL database through the
 * production migration runner.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildParkedOutboxKey,
  sqliteMaintainOutboxEnvironmentPartition,
} from "../src/main/database/outbox-environment-partition.js";
import { claimUnownedSessionIdentity } from "../src/main/database/session-owner-identity.js";
import { sqliteLoadPendingOutboxIds } from "../src/main/database/sync-outbox-store.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const LIVE_TARGET = "01a0107d-0855-70ca-8f76-858cb9abec28";
const RETIRED_TARGET = "019cd8c9-45cb-707f-8a8e-0d9a741dae08";
const LIVE_KEY = `agent_sessions:${LIVE_TARGET}`;
const RETIRED_KEY = `agent_sessions:${RETIRED_TARGET}`;
const SECOND_RETIRED_TARGET = "019a1b2c-3d4e-70ff-8899-aabbccddeeff";
const SECOND_RETIRED_KEY = `agent_sessions:${SECOND_RETIRED_TARGET}`;
const RETIRED_REVISION_KEY = `agent_sessions:monitored_activity_v2:${RETIRED_TARGET}`;
const LIVE_REVISION_KEY = `agent_sessions:monitored_activity_v2:${LIVE_TARGET}`;
const IDENTITY = {
  organizationId: "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
  userId: "019c2a66-37e4-7221-9c3b-e159549f4c93",
};
const ADOPTION_TARGET = "target-iss-6031-adoption";
const ADOPTION_SOURCE_KEY = `agent_sessions:${ADOPTION_TARGET}`;
const OTHER_IDENTITY = {
  organizationId: "019bec6e-0000-0000-0000-000000000000",
  userId: "019bec6e-1111-0000-0000-000000000000",
};

type Prisma = Awaited<ReturnType<typeof openTestPrisma>>["prisma"];

async function seedSession(
  prisma: Prisma,
  id: string,
  owner: { organizationId: string; userId: string } | null,
  startedAt = "2026-08-01T00:00:00.000Z"
): Promise<void> {
  await prisma.write((client) =>
    client.session.create({
      data: {
        id,
        name: id,
        status: "inactive",
        startedAt,
        updatedAt: "2026-08-01T00:00:00.000Z",
        organizationId: owner?.organizationId ?? null,
        userId: owner?.userId ?? null,
      },
    })
  );
}

async function seedOutboxRow(
  prisma: Prisma,
  sourceKey: string,
  externalSessionId: string,
  overrides: { status?: string; attemptCount?: number } = {}
): Promise<void> {
  await prisma.write((client) =>
    client.agentSessionSyncOutbox.create({
      data: {
        sourceKey,
        externalSessionId,
        status: overrides.status ?? "pending",
        syncClass: "backfill",
        attemptCount: overrides.attemptCount ?? 0,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    })
  );
}

test("ISS-6031: a retired target's pending rows become reachable under the live key", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "owned-1", IDENTITY);
    await seedSession(opened.prisma, "owned-2", IDENTITY);
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "owned-1");
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "owned-2");

    // The defect: before adoption the live key cannot see a single one of them.
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_KEY),
      []
    );

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );

    assert.deepEqual(adoption.adoptedIds.sort(), ["owned-1", "owned-2"]);
    assert.equal(adoption.declined, 0);
    assert.equal(adoption.retiredSourceKeys, 1);
    assert.deepEqual(
      (await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_KEY)).sort(),
      ["owned-1", "owned-2"]
    );
    // The retired partition is emptied, so the sweep converges instead of
    // re-migrating the same rows on every hydration.
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
      []
    );
  } finally {
    await opened.close();
  }
});

test("ISS-7096: a foreign account's stranded rows park under that account's org; unclaimed rows decline", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "mine", IDENTITY);
    await seedSession(opened.prisma, "theirs", OTHER_IDENTITY);
    await seedSession(opened.prisma, "unclaimed", null);
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "mine");
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "theirs");
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "unclaimed");

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );

    assert.deepEqual(adoption.adoptedIds, ["mine"]);
    assert.equal(adoption.declined, 1);
    assert.equal(adoption.parkedRows, 1);
    // The decisive assertion: uploading a foreign row under the signed-in
    // account is the cross-tenant write the identity guard exists to refuse —
    // it must never reach the live lane. ISS-7096 parks it under its OWNING
    // org instead of re-declining it every boot; the unclaimed row (no owner
    // to prove) stays exactly where it was.
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_KEY),
      ["mine"]
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
      ["unclaimed"]
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(
        opened.prisma,
        buildParkedOutboxKey("agent_sessions", OTHER_IDENTITY.organizationId)
      ),
      ["theirs"]
    );
  } finally {
    await opened.close();
  }
});

test("ISS-6031: adoption never crosses a payload revision or resurrects a dead-letter", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "revision-scoped", IDENTITY);
    await seedSession(opened.prisma, "already-dead", IDENTITY);
    // The other payload revision: a cursor-invalidation lever, so a row must
    // never migrate across it.
    await seedOutboxRow(opened.prisma, RETIRED_REVISION_KEY, "revision-scoped");
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "already-dead");
    await seedOutboxRow(opened.prisma, LIVE_KEY, "already-dead", {
      status: "dead_lettered",
      attemptCount: 5,
    });

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );

    // Nothing MOVED: the live lane already knew this id, so reporting it as
    // adopted would claim a row became reachable that did not.
    assert.deepEqual(adoption.adoptedIds, []);
    assert.equal(adoption.skippedAlreadyLive, 1);
    assert.equal(adoption.retiredSourceKeys, 1);
    // The dead-lettered decision this lane already made survives: the id is NOT
    // pending under the live key, and the retired duplicate is gone.
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_KEY),
      []
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
      []
    );
    // The other revision's row is untouched, and is still reachable from its own
    // live key.
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_REVISION_KEY),
      ["revision-scoped"]
    );
    const revisionAdoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_REVISION_KEY,
      IDENTITY,
      null
    );
    assert.deepEqual(revisionAdoption.adoptedIds, ["revision-scoped"]);
  } finally {
    await opened.close();
  }
});

test("ISS-6031: a session stranded under two retired targets adopts once", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "double-stranded", IDENTITY);
    await seedSession(opened.prisma, "bystander", IDENTITY);
    // A lane re-keyed twice leaves the SAME id under two retired keys, and the
    // live key is `@@id([sourceKey, externalSessionId])` — inserting both aborts
    // the write, taking the delete and every other adoptable row with it.
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "double-stranded");
    await seedOutboxRow(opened.prisma, SECOND_RETIRED_KEY, "double-stranded");
    await seedOutboxRow(opened.prisma, SECOND_RETIRED_KEY, "bystander");

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );

    assert.deepEqual(adoption.adoptedIds.sort(), [
      "bystander",
      "double-stranded",
    ]);
    assert.equal(adoption.retiredSourceKeys, 2);
    assert.deepEqual(
      (await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_KEY)).sort(),
      ["bystander", "double-stranded"]
    );
    // Both retired copies are gone, so a second pass has nothing left to do.
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
      []
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, SECOND_RETIRED_KEY),
      []
    );
  } finally {
    await opened.close();
  }
});

test("ISS-6031: the adopted row restarts its retry budget", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "spent-budget", IDENTITY);
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "spent-budget", {
      attemptCount: 4,
    });

    await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );

    // Carrying 4 spent attempts across would dead-letter the row on arrival for
    // failures charged against a different device.
    const row = await opened.prisma.client.agentSessionSyncOutbox.findFirst({
      where: { sourceKey: LIVE_KEY, externalSessionId: "spent-budget" },
      select: { attemptCount: true, nextAttemptAt: true, lastError: true },
    });
    assert.equal(row?.attemptCount, 0);
    assert.equal(row?.nextAttemptAt, null);
    assert.equal(row?.lastError, null);
  } finally {
    await opened.close();
  }
});

/**
 * Production wiring: the store operation above is only worth anything if the
 * service actually calls it, and calls it BEFORE the resume that reads the live
 * key. Without this assertion, deleting the call site leaves the suite green.
 */
test("ISS-6031: hydration adopts stranded rows before the outbox resume reads the live key", async () => {
  const calls: Array<{ sourceKey: string; identity: unknown }> = [];
  const source = new FakeSyncSource([
    makeSyncedSession("adopted-by-hydration", "2026-08-12T03:29:06.102Z"),
  ]);
  const readsAtCallTime: string[][] = [];
  const adopting = Object.assign(source, {
    adoptOutboxRowsFromRetiredComputeTargets(
      sourceKey: string,
      identity: unknown,
      _environmentKey: string | null
    ) {
      calls.push({ sourceKey, identity });
      // Simulate the re-key landing: the row becomes visible under the live key.
      source.seedOutbox(sourceKey, "adopted-by-hydration");
      return Promise.resolve({
        adoptedIds: ["adopted-by-hydration"],
        declined: 0,
        skippedAlreadyLive: 0,
        retiredSourceKeys: 1,
        parkedRows: 0,
      });
    },
  });
  const originalLoadPending = source.loadPendingOutboxIds.bind(source);
  adopting.loadPendingOutboxIds = async (sourceKey: string) => {
    const ids = await originalLoadPending(sourceKey);
    readsAtCallTime.push(ids);
    return ids;
  };

  const service = makeServiceWithIdentity(
    adopting,
    () => Promise.resolve({ accepted: true as const }),
    ADOPTION_TARGET,
    undefined,
    IDENTITY
  );
  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(calls.length, 1, "adoption runs once per identity");
  assert.equal(calls[0]?.sourceKey, ADOPTION_SOURCE_KEY);
  assert.deepEqual(calls[0]?.identity, IDENTITY);
  // The ordering assertion: the resume's read already sees the adopted row, so
  // it is re-queued by this pass rather than waiting for another restart.
  assert.ok(
    readsAtCallTime.some((ids) => ids.includes("adopted-by-hydration")),
    "the pending-outbox resume observes the adopted row"
  );
});

test("ISS-7096: foreign-owned rows polluting the ACTIVE key are parked, owned and unclaimed rows stay", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "mine-live", IDENTITY);
    await seedSession(opened.prisma, "theirs-live", OTHER_IDENTITY);
    await seedSession(opened.prisma, "unclaimed-live", null);
    await seedOutboxRow(opened.prisma, LIVE_KEY, "mine-live");
    await seedOutboxRow(opened.prisma, LIVE_KEY, "theirs-live");
    await seedOutboxRow(opened.prisma, LIVE_KEY, "unclaimed-live");

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );

    assert.equal(adoption.parkedRows, 1);
    // The live key's own unstamped rows are normal work, never "declined".
    assert.equal(adoption.declined, 0);
    assert.deepEqual(
      (await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_KEY)).sort(),
      ["mine-live", "unclaimed-live"]
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(
        opened.prisma,
        buildParkedOutboxKey("agent_sessions", OTHER_IDENTITY.organizationId)
      ),
      ["theirs-live"]
    );
  } finally {
    await opened.close();
  }
});

test("ISS-7096: a parked row adopts onto the live key once its own identity signs in", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "round-trip", OTHER_IDENTITY);
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "round-trip", {
      attemptCount: 3,
    });

    // Pass 1, signed in as IDENTITY: the row parks under OTHER's org with its
    // budget preserved — parking is storage, not a verdict.
    await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );
    const parkedKey = buildParkedOutboxKey(
      "agent_sessions",
      OTHER_IDENTITY.organizationId
    );
    const parkedRow =
      await opened.prisma.client.agentSessionSyncOutbox.findFirst({
        where: { sourceKey: parkedKey, externalSessionId: "round-trip" },
        select: { attemptCount: true },
      });
    assert.equal(parkedRow?.attemptCount, 3);

    // Pass 2, signed in as OTHER_IDENTITY on its own live key: the parked row
    // adopts, budget restarted, parked copy gone.
    const otherLiveKey = "agent_sessions:target-other-env";
    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      otherLiveKey,
      OTHER_IDENTITY,
      null
    );
    assert.deepEqual(adoption.adoptedIds, ["round-trip"]);
    const adopted = await opened.prisma.client.agentSessionSyncOutbox.findFirst(
      {
        where: { sourceKey: otherLiveKey, externalSessionId: "round-trip" },
        select: { attemptCount: true },
      }
    );
    assert.equal(adopted?.attemptCount, 0);
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, parkedKey),
      []
    );
  } finally {
    await opened.close();
  }
});

test("ISS-7096: the live compute target's environment binding is recorded at maintenance", async () => {
  const opened = await openTestPrisma();
  try {
    await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      "https://api.stage.example"
    );
    const row = await opened.prisma.client.computeTargetEnvironment.findUnique({
      where: { computeTargetId: LIVE_TARGET },
    });
    assert.equal(row?.environmentKey, "https://api.stage.example");

    // Null records nothing — unknown is never a default environment.
    await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      "agent_sessions:never-bound-target",
      IDENTITY,
      null
    );
    const unmapped =
      await opened.prisma.client.computeTargetEnvironment.findUnique({
        where: { computeTargetId: "never-bound-target" },
      });
    assert.equal(unmapped, null);
  } finally {
    await opened.close();
  }
});

test("ISS-7096 M5: a legacy-revision row is deleted when the active revision covers its session", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "covered", IDENTITY);
    // Legacy v1 copy AND an active-revision copy (dead-lettered — a verdict
    // still counts as coverage; the legacy duplicate must not resurrect it).
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "covered");
    await seedOutboxRow(opened.prisma, LIVE_REVISION_KEY, "covered", {
      status: "dead_lettered",
    });

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_REVISION_KEY,
      IDENTITY,
      null
    );

    assert.deepEqual(adoption.adoptedIds, []);
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
      [],
      "the superseded legacy copy is deleted"
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_REVISION_KEY),
      [],
      "the dead-letter verdict is not resurrected"
    );
  } finally {
    await opened.close();
  }
});

test("ISS-7096 M5: an uncovered legacy row adopts (owned) or parks (foreign)", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "legacy-owned", IDENTITY);
    await seedSession(opened.prisma, "legacy-foreign", OTHER_IDENTITY);
    await seedSession(opened.prisma, "legacy-unclaimed", null);
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "legacy-owned");
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "legacy-foreign");
    await seedOutboxRow(opened.prisma, RETIRED_KEY, "legacy-unclaimed");

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_REVISION_KEY,
      IDENTITY,
      null
    );

    assert.deepEqual(adoption.adoptedIds, ["legacy-owned"]);
    assert.equal(adoption.parkedRows, 1);
    assert.equal(adoption.declined, 1);
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_REVISION_KEY),
      ["legacy-owned"],
      "an uncovered owned legacy row is re-enqueued under the active revision"
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(
        opened.prisma,
        `agent_sessions:monitored_activity_v2:parked:${OTHER_IDENTITY.organizationId}`
      ),
      ["legacy-foreign"]
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
      ["legacy-unclaimed"],
      "an unclaimed legacy row stays exactly where it was"
    );
  } finally {
    await opened.close();
  }
});

test("cr PR #5377: a foreign backlog wider than one bind chunk parks completely", async () => {
  const opened = await openTestPrisma();
  try {
    const count = 450; // > the module's 400-id bind chunk
    const now = "2026-08-01T00:00:00.000Z";
    await opened.prisma.write((client) =>
      client.session.createMany({
        data: Array.from({ length: count }, (_, index) => ({
          id: `bulk-${String(index).padStart(3, "0")}`,
          name: `bulk-${index}`,
          status: "inactive",
          startedAt: now,
          updatedAt: now,
          organizationId: OTHER_IDENTITY.organizationId,
          userId: OTHER_IDENTITY.userId,
        })),
      })
    );
    await opened.prisma.write((client) =>
      client.agentSessionSyncOutbox.createMany({
        data: Array.from({ length: count }, (_, index) => ({
          sourceKey: RETIRED_KEY,
          externalSessionId: `bulk-${String(index).padStart(3, "0")}`,
          status: "pending",
          syncClass: "backfill",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        })),
      })
    );

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_KEY,
      IDENTITY,
      null
    );

    // The chunked owner reads, parks, and source deletes must compose across
    // the 400-id boundary: every row lands parked, none is left behind.
    assert.equal(adoption.parkedRows, count);
    assert.equal(
      (
        await sqliteLoadPendingOutboxIds(
          opened.prisma,
          buildParkedOutboxKey("agent_sessions", OTHER_IDENTITY.organizationId)
        )
      ).length,
      count
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
      []
    );
  } finally {
    await opened.close();
  }
});

test("cr-81036: a superseded revision's parked partitions are swept forward on the revision bump", async () => {
  const opened = await openTestPrisma();
  try {
    await seedSession(opened.prisma, "parked-mine", IDENTITY);
    await seedSession(opened.prisma, "parked-theirs", OTHER_IDENTITY);
    await seedSession(opened.prisma, "parked-covered", OTHER_IDENTITY);
    const legacyMineParked = buildParkedOutboxKey(
      "agent_sessions",
      IDENTITY.organizationId
    );
    const legacyTheirsParked = buildParkedOutboxKey(
      "agent_sessions",
      OTHER_IDENTITY.organizationId
    );
    const activeTheirsParked = buildParkedOutboxKey(
      "agent_sessions:monitored_activity_v2",
      OTHER_IDENTITY.organizationId
    );
    await seedOutboxRow(opened.prisma, legacyMineParked, "parked-mine");
    await seedOutboxRow(opened.prisma, legacyTheirsParked, "parked-theirs");
    await seedOutboxRow(opened.prisma, legacyTheirsParked, "parked-covered");
    // The active revision already accounts for this session.
    await seedOutboxRow(opened.prisma, activeTheirsParked, "parked-covered");

    const adoption = await sqliteMaintainOutboxEnvironmentPartition(
      opened.prisma,
      LIVE_REVISION_KEY,
      IDENTITY,
      null
    );

    // A parked key parses with `:parked` folded into its lane prefix, so the
    // naive prefix-extension check excluded it from every candidate walk —
    // stranding these rows forever once the revision bumped. Owned rows are
    // adopted, foreign rows re-park under the ACTIVE prefix, covered rows are
    // superseded duplicates, and both legacy partitions end empty.
    assert.deepEqual(adoption.adoptedIds, ["parked-mine"]);
    assert.equal(adoption.parkedRows, 1);
    assert.equal(adoption.declined, 0);
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_REVISION_KEY),
      ["parked-mine"]
    );
    assert.deepEqual(
      (
        await sqliteLoadPendingOutboxIds(opened.prisma, activeTheirsParked)
      ).sort(),
      ["parked-covered", "parked-theirs"]
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, legacyMineParked),
      []
    );
    assert.deepEqual(
      await sqliteLoadPendingOutboxIds(opened.prisma, legacyTheirsParked),
      []
    );
  } finally {
    await opened.close();
  }
});

// ISS-11843 (operator ruling, Marisol Ashgrove 2026-10-05): after Connect only
// sessions generated in guest mode with no org stamped may move to the newly
// connected org; parked sessions owned by another org stay parked. Two orgs, so
// a partition that adopted by key rather than by owner fails here.
test("ISS-11843: Connect adopts claimed guest sessions and leaves another org's rows parked", async () => {
  const opened = await openTestPrisma();
  const otherOrgParkedKey = buildParkedOutboxKey(
    "agent_sessions",
    OTHER_IDENTITY.organizationId
  );
  try {
    await seedSession(
      opened.prisma,
      "guest-before",
      null,
      "2026-08-01T00:00:00.000Z"
    );
    await seedSession(
      opened.prisma,
      "org-a",
      OTHER_IDENTITY,
      "2026-08-02T00:00:00.000Z"
    );
    await seedSession(
      opened.prisma,
      "org-a-parked",
      OTHER_IDENTITY,
      "2026-08-02T00:00:00.000Z"
    );
    await seedSession(
      opened.prisma,
      "guest-after",
      null,
      "2026-08-03T00:00:00.000Z"
    );
    for (const id of ["guest-before", "org-a", "guest-after"]) {
      await seedOutboxRow(opened.prisma, RETIRED_KEY, id);
    }
    await seedOutboxRow(opened.prisma, otherOrgParkedKey, "org-a-parked");

    // The sign-in claim stamps the guest window, then the partition runs. One
    // pass is asserted on its own: a drain can read the live key between
    // passes, so a foreign row that is parked only on the next pass has
    // already been offered to the wrong org.
    await claimUnownedSessionIdentity(opened.prisma, IDENTITY);
    const maintain = () =>
      sqliteMaintainOutboxEnvironmentPartition(
        opened.prisma,
        LIVE_KEY,
        IDENTITY,
        null
      );
    for (const pass of ["first", "second"]) {
      await maintain();
      assert.deepEqual(
        await sqliteLoadPendingOutboxIds(opened.prisma, LIVE_KEY),
        ["guest-after"],
        `${pass} pass: only the claimed guest session reaches the live key`
      );
      assert.deepEqual(
        (
          await sqliteLoadPendingOutboxIds(opened.prisma, otherOrgParkedKey)
        ).sort(),
        ["org-a", "org-a-parked"],
        `${pass} pass: the other org's sessions stay parked for that org`
      );
      assert.deepEqual(
        await sqliteLoadPendingOutboxIds(opened.prisma, RETIRED_KEY),
        ["guest-before"],
        `${pass} pass: an unowned row the claim cannot place as guest work stays put`
      );
    }
  } finally {
    await opened.close();
  }
});
