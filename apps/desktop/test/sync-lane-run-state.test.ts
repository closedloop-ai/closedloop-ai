/**
 * @file sync-lane-run-state.test.ts
 * @description PLN-2028 M1 (ISS-10053): the durable lane run's STORE contract,
 * against a real libSQL database built by the production migration runner.
 *
 * The property the whole milestone rests on is where a lane-run value comes BACK
 * from. The session lane's key flips between its revision and short spellings
 * whenever a hello ack moves the negotiated revision, so each case below writes
 * under one spelling and reads under the other; a store that keyed the run by the
 * whole key passes every same-spelling round trip and fails these.
 *
 * Reason and source values are deliberately opaque strings: the store persists
 * whatever it is handed, and narrowing them is the adopting lane's job.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  type AgentSessionSyncSource,
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
  type PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { readPersistedSyncState } from "../src/main/agent-sync/persisted-sync-state-reply-boundary.js";
import type { PersistedLaneRun } from "../src/main/agent-sync/sync-cursor-state-source.js";
import { buildLaneRunSourceKey } from "../src/main/agent-sync/sync-lane-run-key.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { sqliteLoadSyncState } from "../src/main/database/sync-cursor-state.js";
import { createSyncCursorStateDelegates } from "../src/main/database/sync-cursor-state-delegates.js";
import {
  DB_HOST_REPLY_REJECTED_CATEGORY,
  resetDbHostReplyRejectionThrottle,
} from "../src/main/telemetry/db-host-reply-rejection.js";
import {
  DbHostRejectedReplyOp,
  type TelemetryEventPayload,
} from "../src/main/telemetry/telemetry-protocol.js";
import { armTelemetry } from "./agent-session-sync-service-fixture.js";
import {
  recordDesktopCalls,
  WIDE_READ_METHODS,
} from "./discarded-write-narrowing-utils.js";
import { FakeSyncSource } from "./fake-sync-source.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const TARGET = "target-iss10053";
const SHORT_KEY = buildAgentSessionSyncSourceKey(TARGET);
const REVISION_KEY = buildAgentSessionSyncSourceKey(TARGET, true);
const COMPONENT_KEY = buildAgentComponentSyncSourceKey(TARGET);

const OPENED_AT = "2026-09-14T00:00:00.000Z";
const GAVE_UP_AT = "2026-09-15T00:00:00.000Z";
const LATER_AT = "2026-09-15T06:00:00.000Z";
const REASON = "reason-under-test";
const SOURCE = "producer-under-test";
const REFUSED_WRITE = /refused a lane-run write/;

const RUN: PersistedLaneRun = {
  laneStalledSince: OPENED_AT,
  laneGaveUpAt: GAVE_UP_AT,
  laneGaveUpReason: REASON,
  laneGaveUpSource: SOURCE,
};
const CLEARED_RUN: PersistedLaneRun = {
  laneStalledSince: null,
  laneGaveUpAt: null,
  laneGaveUpReason: null,
  laneGaveUpSource: null,
};
/** {@link RUN} as a loaded cursor carries it. */
const RUN_FIELDS = {
  laneStalledSince: OPENED_AT,
  laneGaveUpAt: GAVE_UP_AT,
  laneGaveUpReason: REASON,
  laneGaveUpSource: SOURCE,
};

const CURSOR: PersistedSyncState = {
  observedTopUpdatedAt: "2026-09-13T12:00:00.000Z",
  observedIdsAtTopUpdatedAt: ["session-a"],
  deadLetteredIds: [],
};
const EMPTY_CURSOR: PersistedSyncState = {
  observedTopUpdatedAt: null,
  observedIdsAtTopUpdatedAt: [],
  deadLetteredIds: [],
};

/** Every contract rung the connected server can advertise. */
const CAPABLE_SERVER = {
  spanExtent: true,
  humanTurnTimestamps: true,
  agentTurnTimestamps: true,
  tokenEventOwner: true,
};

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

type SyncStateOps = Pick<
  AgentSessionSyncSource,
  "loadSyncState" | "advanceSyncState" | "recordLaneGiveUp" | "recordLaneRun"
>;

test("buildLaneRunSourceKey maps a session revision key to its target's short key and leaves every other key alone", () => {
  assert.equal(buildLaneRunSourceKey(REVISION_KEY), SHORT_KEY);
  assert.equal(buildLaneRunSourceKey(SHORT_KEY), SHORT_KEY);
  assert.equal(buildLaneRunSourceKey(COMPONENT_KEY), COMPONENT_KEY);
  // An outbox partition under either session spelling is not a lane identity.
  for (const parked of [
    `${buildAgentSessionSyncSourceKey("parked")}:org-a`,
    `${buildAgentSessionSyncSourceKey("parked", true)}:org-a`,
  ]) {
    assert.equal(buildLaneRunSourceKey(parked), parked);
  }
});

test("KEY FLIP: a give-up written under one session spelling reads back under the other, through the real source", async () => {
  await withDatabase(async (db) => {
    const source = db.syncSource;
    await source.advanceSyncState?.(REVISION_KEY, CURSOR);

    // Connected process stamps; a disconnected relaunch reads.
    await source.recordLaneGiveUp?.(REVISION_KEY, GAVE_UP_AT);
    assert.equal(
      (await source.loadSyncState?.(SHORT_KEY))?.laneGaveUpAt,
      GAVE_UP_AT,
      "the short spelling reads the stamp the revision spelling wrote"
    );
    assert.equal(
      (await source.loadSyncState?.(REVISION_KEY))?.laneGaveUpAt,
      GAVE_UP_AT
    );

    // Disconnected process clears; a connected relaunch reads.
    await source.recordLaneGiveUp?.(SHORT_KEY, null);
    assert.equal(
      (await source.loadSyncState?.(REVISION_KEY))?.laneGaveUpAt,
      undefined,
      "a clear under the short spelling reaches the row the revision spelling reads"
    );

    await source.recordLaneRun?.(SHORT_KEY, RUN);
    assert.deepEqual(
      await source.loadSyncState?.(REVISION_KEY),
      { ...CURSOR, ...RUN_FIELDS },
      "the whole run loads beside the revision key's own cursor"
    );

    // The component lane's key is its own lane-run key.
    await source.recordLaneGiveUp?.(COMPONENT_KEY, GAVE_UP_AT);
    assert.equal(
      (await source.loadSyncState?.(COMPONENT_KEY))?.laneGaveUpAt,
      GAVE_UP_AT
    );
  });
});

test("recordLaneRun writes its four columns and no other, and a cursor advance never writes them", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delegates = createSyncCursorStateDelegates(prisma);
    await delegates.advanceSyncState(SHORT_KEY, CURSOR);
    const before = splitStoredRow(await storedRow(prisma, SHORT_KEY));

    await delegates.recordLaneRun(SHORT_KEY, RUN);
    const afterRun = splitStoredRow(await storedRow(prisma, SHORT_KEY));
    assert.deepEqual(afterRun.cursor, before.cursor, "no cursor column moved");
    assert.deepEqual(afterRun.laneRun, RUN);

    await delegates.advanceSyncState(SHORT_KEY, {
      ...CURSOR,
      observedTopUpdatedAt: LATER_AT,
    });
    const afterAdvance = splitStoredRow(await storedRow(prisma, SHORT_KEY));
    assert.equal(afterAdvance.cursor.observedTopUpdatedAt, LATER_AT);
    assert.deepEqual(
      afterAdvance.laneRun,
      RUN,
      "the advance left the run where it was"
    );
  } finally {
    await close();
  }
});

test("the recordLaneGiveUp alias writes the stamp alone, on the lane-run row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delegates = createSyncCursorStateDelegates(prisma);
    await delegates.recordLaneRun(SHORT_KEY, RUN);
    await delegates.recordLaneGiveUp(REVISION_KEY, LATER_AT);

    assert.deepEqual(
      splitStoredRow(await storedRow(prisma, SHORT_KEY)).laneRun,
      { ...RUN, laneGaveUpAt: LATER_AT },
      "origin, reason and producer are untouched"
    );
    assert.equal(
      await storedRow(prisma, REVISION_KEY),
      null,
      "and no row was created under the revision spelling"
    );
  } finally {
    await close();
  }
});

test("a revision-key cursor loads its run from the short-key row and ignores a stamp left on its own row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delegates = createSyncCursorStateDelegates(prisma);
    await delegates.advanceSyncState(REVISION_KEY, CURSOR);
    // A stamp written under the revision row before PLN-2028 D2: not migrated.
    await prisma.write((client) =>
      client.syncState.update({
        where: { sourceKey: REVISION_KEY },
        data: { laneGaveUpAt: LATER_AT },
      })
    );
    await delegates.recordLaneRun(SHORT_KEY, RUN);

    assert.deepEqual(await sqliteLoadSyncState(prisma, REVISION_KEY), {
      ...CURSOR,
      ...RUN_FIELDS,
    });
  } finally {
    await close();
  }
});

test("a full re-walk clears the watermark and keeps the lane run", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delegates = createSyncCursorStateDelegates(prisma);
    // Stamped for a pre-extent server, loaded by a capable one: a re-walk.
    await delegates.advanceSyncState(SHORT_KEY, CURSOR);
    await delegates.recordLaneRun(SHORT_KEY, RUN);

    assert.deepEqual(
      await sqliteLoadSyncState(prisma, SHORT_KEY, CAPABLE_SERVER),
      { ...EMPTY_CURSOR, ...RUN_FIELDS }
    );
  } finally {
    await close();
  }
});

test("no cursor row plus a lane run loads the empty cursor; with no run either it loads nothing", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delegates = createSyncCursorStateDelegates(prisma);
    await delegates.recordLaneRun(SHORT_KEY, RUN);
    assert.deepEqual(await sqliteLoadSyncState(prisma, REVISION_KEY), {
      ...EMPTY_CURSOR,
      ...RUN_FIELDS,
    });

    await delegates.recordLaneRun(SHORT_KEY, CLEARED_RUN);
    assert.equal(await sqliteLoadSyncState(prisma, REVISION_KEY), null);
    assert.deepEqual(
      await sqliteLoadSyncState(prisma, SHORT_KEY),
      EMPTY_CURSOR,
      "the lane-run row itself still exists, as an empty cursor"
    );
  } finally {
    await close();
  }
});

test("NARROWING: a revision-key load reads the cursor projection from its own row and the lane-run projection from the short-key row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delegates = createSyncCursorStateDelegates(prisma);
    await delegates.advanceSyncState(REVISION_KEY, CURSOR);
    await delegates.recordLaneRun(SHORT_KEY, RUN);
    const recorded = recordDesktopCalls(prisma, WIDE_READ_METHODS);

    await sqliteLoadSyncState(recorded.prisma, REVISION_KEY);

    assert.deepEqual(
      recorded.callsFor("syncState", "findUnique").map((call) => ({
        where: call.args.where,
        select: Object.keys(call.args.select ?? {}).sort(),
      })),
      [
        {
          where: { sourceKey: REVISION_KEY },
          select: [
            "autonomyFormulaVersion",
            "deadLetterAttempts",
            "deadLetteredIds",
            "observedIdsAtTopUpdatedAt",
            "observedTopUpdatedAt",
            "syncIntegrityVersion",
          ],
        },
        {
          where: { sourceKey: SHORT_KEY },
          select: [
            "laneGaveUpAt",
            "laneGaveUpReason",
            "laneGaveUpSource",
            "laneStalledSince",
          ],
        },
      ]
    );
  } finally {
    await close();
  }
});

test("BOUNDARY: a stored lane run survives the reply boundary, and an unreadable lane-run field costs only itself", async () => {
  const { prisma, close } = await openTestPrisma();
  const telemetry = armTelemetry();
  try {
    resetDbHostReplyRejectionThrottle();
    const delegates = createSyncCursorStateDelegates(prisma);
    await delegates.advanceSyncState(SHORT_KEY, CURSOR);
    await delegates.recordLaneRun(SHORT_KEY, RUN);
    const full = { ...CURSOR, ...RUN_FIELDS };

    assert.deepEqual(
      readPersistedSyncState(
        structuredClone(await sqliteLoadSyncState(prisma, SHORT_KEY))
      ),
      full
    );
    assert.equal(rejectedLoads(telemetry.events), 0);

    const malformed: readonly [string, unknown][] = [
      ["laneStalledSince", "not-an-instant"],
      ["laneStalledSince", 1_757_894_400_000],
      ["laneGaveUpReason", ""],
      ["laneGaveUpReason", 7],
      ["laneGaveUpSource", null],
      ["laneGaveUpSource", {}],
    ];
    for (const [field, value] of malformed) {
      resetDbHostReplyRejectionThrottle();
      assert.deepEqual(
        readPersistedSyncState({ ...full, [field]: value }),
        Object.fromEntries(
          Object.entries(full).filter(([key]) => key !== field)
        ),
        `${field}=${JSON.stringify(value)} drops that field and keeps the cursor`
      );
    }
    assert.equal(
      rejectedLoads(telemetry.events),
      malformed.length,
      "every degraded reply is still reported"
    );

    resetDbHostReplyRejectionThrottle();
    assert.deepEqual(
      readPersistedSyncState(CURSOR),
      CURSOR,
      "a peer that predates the lane run reads as legacy"
    );
    assert.equal(
      readPersistedSyncState({ ...full, observedTopUpdatedAt: 42 }),
      null,
      "a malformed cursor field still refuses the whole cursor"
    );
    assert.equal(rejectedLoads(telemetry.events), malformed.length + 1);
  } finally {
    telemetry.restore();
    await close();
  }
});

test("a stored EMPTY origin, reason or producer reaches the reply boundary, which drops each and reports it", async () => {
  const { prisma, close } = await openTestPrisma();
  const telemetry = armTelemetry();
  try {
    resetDbHostReplyRejectionThrottle();
    const delegates = createSyncCursorStateDelegates(prisma);
    await delegates.advanceSyncState(SHORT_KEY, CURSOR);
    await delegates.recordLaneRun(SHORT_KEY, RUN);
    // The store's writes refuse these, so only a row changed outside them holds one.
    await prisma.write((client) =>
      client.syncState.update({
        where: { sourceKey: SHORT_KEY },
        data: {
          laneStalledSince: "",
          laneGaveUpReason: "",
          laneGaveUpSource: "",
        },
      })
    );

    const loaded = await sqliteLoadSyncState(prisma, SHORT_KEY);
    assert.deepEqual(
      loaded,
      {
        ...CURSOR,
        ...RUN_FIELDS,
        laneStalledSince: "",
        laneGaveUpReason: "",
        laneGaveUpSource: "",
      },
      "the load hands each stored value to the boundary instead of reading it as no run"
    );
    assert.deepEqual(readPersistedSyncState(structuredClone(loaded)), {
      ...CURSOR,
      laneGaveUpAt: GAVE_UP_AT,
    });
    assert.equal(rejectedLoads(telemetry.events), 1, "and it is reported");
  } finally {
    telemetry.restore();
    await close();
  }
});

test("WRITE REFUSAL: a lane-run value the load would reject refuses the whole write and stores nothing, in the real store and the fake alike", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const delegates = createSyncCursorStateDelegates(prisma);
    const fake = new FakeSyncSource([]);
    await delegates.recordLaneRun(SHORT_KEY, RUN);
    fake.recordLaneRun(SHORT_KEY, RUN);

    const refusedRuns: PersistedLaneRun[] = [
      { ...RUN, laneGaveUpAt: "" },
      { ...RUN, laneGaveUpAt: "not-an-instant" },
      { ...RUN, laneStalledSince: "" },
      { ...CLEARED_RUN, laneGaveUpReason: "" },
      { ...CLEARED_RUN, laneGaveUpSource: "" },
    ];
    for (const run of refusedRuns) {
      await assert.rejects(
        delegates.recordLaneRun(REVISION_KEY, run),
        REFUSED_WRITE
      );
      assert.throws(() => fake.recordLaneRun(REVISION_KEY, run), REFUSED_WRITE);
    }
    for (const gaveUpAt of ["", "not-an-instant"]) {
      await assert.rejects(
        delegates.recordLaneGiveUp(REVISION_KEY, gaveUpAt),
        REFUSED_WRITE
      );
      assert.throws(
        () => fake.recordLaneGiveUp(REVISION_KEY, gaveUpAt),
        REFUSED_WRITE
      );
    }

    assert.deepEqual(
      splitStoredRow(await storedRow(prisma, SHORT_KEY)).laneRun,
      RUN,
      "no refused write moved a column, not even a valid one beside the bad value"
    );
    assert.deepEqual(await fake.loadSyncState(SHORT_KEY), {
      ...EMPTY_CURSOR,
      ...RUN_FIELDS,
    });

    await assert.rejects(
      delegates.recordLaneGiveUp(COMPONENT_KEY, ""),
      REFUSED_WRITE
    );
    assert.equal(
      await storedRow(prisma, COMPONENT_KEY),
      null,
      "and a refused write creates no row"
    );
  } finally {
    await close();
  }
});

test("FakeSyncSource answers the same key-flip sequence the real store does", async () => {
  await withDatabase(async (db) => {
    const real = await runKeyFlipSequence(db.syncSource);
    const fake = await runKeyFlipSequence(new FakeSyncSource([]));

    assert.equal(
      (real[0] as PersistedSyncState | null)?.laneGaveUpAt,
      GAVE_UP_AT,
      "not vacuous: the real store answered the flip with the stamp"
    );
    assert.deepEqual(fake, real);
  });
});

/** Drive one source through writes and reads that alternate the session spellings. */
async function runKeyFlipSequence(source: SyncStateOps): Promise<unknown[]> {
  const answers: unknown[] = [];
  await source.advanceSyncState?.(REVISION_KEY, CURSOR);
  await source.recordLaneGiveUp?.(REVISION_KEY, GAVE_UP_AT);
  answers.push(
    await source.loadSyncState?.(SHORT_KEY),
    await source.loadSyncState?.(REVISION_KEY)
  );
  await source.recordLaneRun?.(SHORT_KEY, RUN);
  await source.advanceSyncState?.(REVISION_KEY, {
    ...CURSOR,
    observedTopUpdatedAt: LATER_AT,
  });
  answers.push(await source.loadSyncState?.(REVISION_KEY));
  await source.recordLaneRun?.(REVISION_KEY, CLEARED_RUN);
  answers.push(
    await source.loadSyncState?.(SHORT_KEY),
    await source.loadSyncState?.(REVISION_KEY),
    await source.loadSyncState?.(COMPONENT_KEY)
  );
  return answers;
}

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lane-run-state-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => GAVE_UP_AT,
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function storedRow(prisma: DesktopPrisma, sourceKey: string) {
  return prisma.client.syncState.findUnique({ where: { sourceKey } });
}

/** A stored row as its cursor half (minus write bookkeeping) and its lane run. */
function splitStoredRow(row: Awaited<ReturnType<typeof storedRow>>) {
  if (!row) {
    throw new Error("fixture: the row must exist");
  }
  const {
    laneStalledSince,
    laneGaveUpAt,
    laneGaveUpReason,
    laneGaveUpSource,
    updatedAt: _updatedAt,
    ...cursor
  } = row;
  const laneRun: PersistedLaneRun = {
    laneStalledSince,
    laneGaveUpAt,
    laneGaveUpReason,
    laneGaveUpSource,
  };
  return { cursor, laneRun };
}

function rejectedLoads(events: TelemetryEventPayload[]): number {
  return events.filter(
    (event) =>
      event.category === DB_HOST_REPLY_REJECTED_CATEGORY &&
      event.diagnostics?.dbHostReplyRejected?.op ===
        DbHostRejectedReplyOp.LoadSyncState
  ).length;
}
