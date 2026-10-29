/**
 * @file activity-tiling-repair.test.ts
 * @description ISS-7265 AC3 — the strip is a DEFERRAL, not a discard.
 *
 * PR #5456 and the delivery-visibility half of this ticket made a stripped
 * activity tiling legible: a wire flag, a `sync.payload_shaping` value, a count,
 * a persisted cloud column. None of that changed where the data went. A stripped
 * delivery is acked like any other, which clears the durable outbox and dequeues
 * the session, and selection walks `sessions.updated_at` rather than "the
 * delivery was incomplete" — so the tiling never came back. AC3 asked for that
 * judgment to be made rather than inherited; the answer implemented here is
 * strip-and-flag-and-REPAIR, and this suite is what makes the repair half real.
 *
 * Three properties, and each has a sibling that fails independently:
 *
 *   1. A confirmed STRIPPED delivery records a debt; a confirmed INTACT delivery
 *      settles one. An implementation that recorded every delivery satisfies the
 *      first alone, which is why the second is here.
 *   2. The repair CONVERGES. It bumps `sessions.updated_at` once and then stops,
 *      and the case that deletes `requeued_at` proves the stamp is what stops it
 *      rather than some accident of the predicate. A single-run fixture cannot
 *      observe the endless-bump failure, which is the whole hazard.
 *   3. The repair only runs under the capability whose absence forced the strip.
 *      Without that gate the re-delivery strips again and buys nothing but
 *      cursor churn.
 */
import { describe, expect, it } from "vitest";
import {
  createOutboxWriters,
  type OutboxWriteTarget,
} from "../src/main/agent-sync/agent-session-outbox-writers.js";
import {
  type AcceptedAckDeps,
  type AcceptedAckInput,
  processAcceptedAck,
} from "../src/main/agent-sync/agent-session-sync-accepted-ack.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  recordActivityTilingDebt,
  requeueOwedActivityTilings,
  settleActivityTilingDebt,
} from "../src/main/database/activity-tiling-repair-store.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  makeSessionWithLargeTiling,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import type { OpenTestPrisma } from "./prisma-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** The lane fixture needs an identified compute target to reach caught-up. */
const COMPUTE_TARGET_ID = "compute-target-iss7265-repair";

/** Historical, already behind any realistic sync cursor. */
const SEEDED_UPDATED_AT = "2026-06-01T00:00:00.000Z";
/** Later than the pass's own `new Date()` start stamp, so it is out of bounds. */
const FUTURE_UPDATED_AT = "2099-01-01T00:00:00.000Z";
const RECORDED_AT = "2026-06-02T00:00:00.000Z";

const STRIPPED_SESSION = "s-stripped";
const INTACT_SESSION = "s-intact";

type Store = OpenTestPrisma["db"];

async function seedSession(
  store: Store,
  id: string,
  updatedAt: string = SEEDED_UPDATED_AT
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, last_activity_at) VALUES ($1, 'inactive', $2, $2)",
    [id, updatedAt]
  );
}

async function updatedAt(store: Store, id: string): Promise<string | null> {
  const result = await store.query<{ updated_at: string | null }>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    [id]
  );
  return result.rows[0]?.updated_at ?? null;
}

async function debtRows(
  store: Store
): Promise<{ sessionId: string; requeuedAt: string | null }[]> {
  const result = await store.query<{
    session_id: string;
    requeued_at: string | null;
  }>(
    "SELECT session_id, requeued_at FROM activity_tiling_repair_owed ORDER BY session_id",
    []
  );
  return result.rows.map((row) => ({
    sessionId: row.session_id,
    requeuedAt: row.requeued_at ?? null,
  }));
}

/**
 * A `DesktopPrisma` that runs `mutate` once, immediately BEFORE the pass's first
 * write lands — the only way to observe the discovery→write window from outside,
 * since the pass exposes no seam of its own. Mirrors the ISS-6998 sibling's
 * helper, which exists for the identical reason.
 */
function prismaWithMutationBeforeFirstWrite(
  prisma: DesktopPrisma,
  mutate: () => Promise<void>
): DesktopPrisma {
  let pending = true;
  return {
    ...prisma,
    write: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      if (pending) {
        pending = false;
        await mutate();
      }
      return await prisma.write(fn as never);
    },
  } as DesktopPrisma;
}

describe("the durable tiling-debt ledger", () => {
  it("re-queues an owed tiling by bumping the column the sync cursor selects on", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await seedSession(store, STRIPPED_SESSION);
      await seedSession(store, INTACT_SESSION);
      await recordActivityTilingDebt(prisma, [STRIPPED_SESSION], RECORDED_AT);

      const result = await requeueOwedActivityTilings(prisma, () => undefined);

      expect(result.requeued).toBe(1);
      const bumped = await updatedAt(store, STRIPPED_SESSION);
      expect(bumped).not.toBe(SEEDED_UPDATED_AT);
      expect(bumped === null ? "" : bumped > SEEDED_UPDATED_AT).toBe(true);
      // THE SIBLING. A pass that bumped every session would satisfy the lines
      // above just as well; only a session that owes a tiling may be re-queued.
      expect(await updatedAt(store, INTACT_SESSION)).toBe(SEEDED_UPDATED_AT);
    } finally {
      await close();
    }
  });

  it("CONVERGES — the second pass re-queues nothing, and `requeued_at` is why", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await seedSession(store, STRIPPED_SESSION);
      await recordActivityTilingDebt(prisma, [STRIPPED_SESSION], RECORDED_AT);

      expect(
        (await requeueOwedActivityTilings(prisma, () => undefined)).requeued
      ).toBe(1);
      const afterFirst = await updatedAt(store, STRIPPED_SESSION);

      const second = await requeueOwedActivityTilings(prisma, () => undefined);
      expect(second.requeued).toBe(0);
      expect(await updatedAt(store, STRIPPED_SESSION)).toBe(afterFirst);

      // Now prove the STAMP is the reason, not the predicate: clear it and the
      // same pass re-queues again. Without this the convergence above could be
      // satisfied by a pass that simply never selects anything twice.
      await store.query(
        "UPDATE activity_tiling_repair_owed SET requeued_at = NULL WHERE session_id = $1",
        [STRIPPED_SESSION]
      );
      expect(
        (await requeueOwedActivityTilings(prisma, () => undefined)).requeued
      ).toBe(1);
    } finally {
      await close();
    }
  });

  it("does NOT re-open an already-asked debt when the same session strips again", async () => {
    // The endless-bump guard. A re-delivery this pass provoked can itself strip
    // (the tiling still does not fit unchunked), and an upsert that reset
    // `requeued_at` would make the next pass ask again, forever.
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await seedSession(store, STRIPPED_SESSION);
      await recordActivityTilingDebt(prisma, [STRIPPED_SESSION], RECORDED_AT);
      await requeueOwedActivityTilings(prisma, () => undefined);
      const asked = (await debtRows(store))[0]?.requeuedAt;
      expect(asked).not.toBeNull();

      await recordActivityTilingDebt(
        prisma,
        [STRIPPED_SESSION],
        "2026-06-09T00:00:00.000Z"
      );

      expect(await debtRows(store)).toEqual([
        { sessionId: STRIPPED_SESSION, requeuedAt: asked },
      ]);
      expect(
        (await requeueOwedActivityTilings(prisma, () => undefined)).requeued
      ).toBe(0);
    } finally {
      await close();
    }
  });

  it("settles a debt so a LATER strip of the same session is asked for again", async () => {
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await seedSession(store, STRIPPED_SESSION);
      await recordActivityTilingDebt(prisma, [STRIPPED_SESSION], RECORDED_AT);
      await requeueOwedActivityTilings(prisma, () => undefined);

      await settleActivityTilingDebt(prisma, [STRIPPED_SESSION]);
      expect(await debtRows(store)).toEqual([]);

      // Re-armed: the settle deleted the row, so a fresh strip records a fresh
      // unasked debt rather than being swallowed by the old `requeued_at`.
      await recordActivityTilingDebt(
        prisma,
        [STRIPPED_SESSION],
        "2026-06-10T00:00:00.000Z"
      );
      expect(await debtRows(store)).toEqual([
        { sessionId: STRIPPED_SESSION, requeuedAt: null },
      ]);
      expect(
        (await requeueOwedActivityTilings(prisma, () => undefined)).requeued
      ).toBe(1);
    } finally {
      await close();
    }
  });

  it("never drags a session BACKWARD past a live writer, and still stops asking", async () => {
    // ISS-5259 boundary, and it must be entered through the REAL race to be
    // proved: a row seeded in the future is filtered by discovery and never
    // reaches the write at all, which leaves both of the write's deliberate
    // predicates unexercised. So the row is seeded in the PAST — discovery
    // selects it — and a live writer advances it past the pass start in the
    // window between that read and the bump.
    //
    // Two things must then hold, and they kill different mutations. The bump
    // RE-ASSERTS the pass-start bound, so the newer stamp survives; without that
    // clause the row is dragged backwards behind an already-advanced sync cursor
    // and never syncs. And the marker is stamped for EVERY candidate, not only
    // for the ids the bump moved — the opposite of the ISS-6998 sibling, because
    // here a skipped row was skipped precisely BECAUSE it got the re-selection
    // this pass wanted, and deriving the marker from `RETURNING` would leave it
    // unasked and re-select it on every pass forever.
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await seedSession(store, STRIPPED_SESSION);
      await recordActivityTilingDebt(prisma, [STRIPPED_SESSION], RECORDED_AT);

      const result = await requeueOwedActivityTilings(
        prismaWithMutationBeforeFirstWrite(prisma, async () => {
          await store.query(
            "UPDATE sessions SET updated_at = $1 WHERE id = $2",
            [FUTURE_UPDATED_AT, STRIPPED_SESSION]
          );
        }),
        () => undefined
      );

      expect(result.requeued).toBe(0);
      expect(await updatedAt(store, STRIPPED_SESSION)).toBe(FUTURE_UPDATED_AT);
      expect(await debtRows(store)).toEqual([
        { sessionId: STRIPPED_SESSION, requeuedAt: expect.any(String) },
      ]);
      expect(
        (await requeueOwedActivityTilings(prisma, () => undefined)).requeued
      ).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("processAcceptedAck tiling-debt bookkeeping", () => {
  it("records the confirmed stripped sessions as owed and settles the intact ones", async () => {
    const debt = await driveAckDebt({
      ids: [STRIPPED_SESSION, INTACT_SESSION],
      acceptedSessionIds: [STRIPPED_SESSION, INTACT_SESSION],
      tilingStrippedSessionIds: [STRIPPED_SESSION],
    });

    expect(debt).toEqual([
      { owed: [STRIPPED_SESSION], settled: [INTACT_SESSION] },
    ]);
  });

  it("does not owe a tiling for a row the server did NOT confirm", async () => {
    // An omitted row is still queued and will re-send its tiling in full, so
    // recording a debt for it would ask for a re-delivery of data that never
    // left. This is the same confirmed-not-sent rule the count already follows.
    const debt = await driveAckDebt({
      ids: [STRIPPED_SESSION, INTACT_SESSION],
      acceptedSessionIds: [INTACT_SESSION],
      tilingStrippedSessionIds: [STRIPPED_SESSION],
    });

    expect(debt).toEqual([{ owed: [], settled: [INTACT_SESSION] }]);
  });

  it("writes nothing at all when the caller measured no strip state", async () => {
    // Absent is NOT "none stripped". Settling off an unmeasured delivery would
    // clear a real debt on the strength of a payload that never reported — the
    // same false-completeness the wire flag exists to remove.
    const debt = await driveAckDebt({
      ids: [STRIPPED_SESSION],
      acceptedSessionIds: [STRIPPED_SESSION],
      tilingStrippedSessionIds: undefined,
    });

    expect(debt).toEqual([]);
  });

  it("commits the debt BEFORE the durable outbox clear, and records it even when that clear fails", async () => {
    // ORDERING, and it is load-bearing in both halves. The server has already
    // confirmed these rows, so the tiling is owed whatever the local clear does
    // — and once the clear commits there is no other record anywhere that this
    // session shipped without its tiling, so a debt write still in flight at
    // that moment is a debt a kill loses outright. Over-recording costs one
    // redundant re-queue that the next intact delivery settles.
    const order: string[] = [];
    const debt: { owed: string[]; settled: string[] }[] = [];
    await processAcceptedAck(
      {
        syncMode: "incremental",
        ids: [STRIPPED_SESSION],
        sessionCount: 1,
        payloadBytes: 4096,
        latencyMs: 120,
        hasMoreChunks: false,
        remainingChunks: null,
        acceptedSessionIds: [STRIPPED_SESSION],
        tilingStrippedSessionIds: [STRIPPED_SESSION],
      },
      {
        ...inertAckDeps(),
        clearOutboxDurably: () => {
          order.push("clear");
          return Promise.resolve({ cleared: false });
        },
        recordTilingDebt: (write) => {
          debt.push(write);
          // Resolve on a later turn, so a caller that fires without awaiting
          // records AFTER the clear and fails the ordering assertion below.
          return Promise.resolve().then(() => {
            order.push("debt");
          });
        },
      }
    );

    expect(debt).toEqual([{ owed: [STRIPPED_SESSION], settled: [] }]);
    expect(order).toEqual(["debt", "clear"]);
  });

  it("waits for the FINAL chunk, because a non-final chunk has dequeued nothing", async () => {
    const nonFinal = await driveAckDebt({
      ids: [STRIPPED_SESSION],
      acceptedSessionIds: [STRIPPED_SESSION],
      tilingStrippedSessionIds: [STRIPPED_SESSION],
      hasMoreChunks: true,
      remainingChunks: 2,
    });
    expect(nonFinal).toEqual([]);

    // The paired positive, so "never writes" cannot satisfy the case above.
    const final = await driveAckDebt({
      ids: [STRIPPED_SESSION],
      acceptedSessionIds: [STRIPPED_SESSION],
      tilingStrippedSessionIds: [STRIPPED_SESSION],
      hasMoreChunks: false,
    });
    expect(final).toEqual([{ owed: [STRIPPED_SESSION], settled: [] }]);
  });
});

describe("the repair's capability gate", () => {
  it("stays silent until the server can merge a multi-part tiling", () => {
    const { writers, spy } = writersWithRepairSpy();

    writers.repairOwedTilings(false);

    // Without the capability the re-delivery would strip again: the payload
    // builder's fallback fires precisely when merging is unavailable.
    expect(spy.calls).toBe(0);
  });

  it("drains the ledger once, not once per tick", () => {
    const { writers, spy } = writersWithRepairSpy();

    writers.repairOwedTilings(true);
    writers.repairOwedTilings(true);
    writers.repairOwedTilings(true);

    // The paired positive AND the bound: the sweep runs, and a lane that ticks
    // every few seconds does not re-walk the whole ledger each time.
    expect(spy.calls).toBe(1);
  });

  it("re-arms when the capability goes away, so a later debt is still swept", () => {
    // The capability is re-read LIVE every tick and flaps — a reconnect, a
    // server-version rollback, an account switch onto a different backend. A
    // strip can only happen while it is FALSE, so a sweep latched once per lane
    // would sit inert through exactly the window that creates new debts and
    // strand them until the next app start.
    const { writers, spy } = writersWithRepairSpy();

    writers.repairOwedTilings(true);
    expect(spy.calls).toBe(1);
    writers.repairOwedTilings(false);
    writers.repairOwedTilings(false);
    // Still 1: the window where debts are CREATED must not itself sweep.
    expect(spy.calls).toBe(1);

    writers.repairOwedTilings(true);
    writers.repairOwedTilings(true);

    // Exactly one more — the new window sweeps once, not once per tick.
    expect(spy.calls).toBe(2);
  });
});

describe("agent-session sync lane tiling-repair wiring", () => {
  it("records the debt for a session the LANE actually delivered stripped", async () => {
    // The production-path assertion. Every case above drives `processAcceptedAck`
    // or the store directly, so all of them stay green if the service stops
    // passing `recordTilingDebt` at all. This one fails.
    const source = new FakeSyncSource([
      makeSessionWithLargeTiling(STRIPPED_SESSION),
    ]);

    await runLane(source);

    expect(source.tilingDebtOwed).toEqual([STRIPPED_SESSION]);
    expect(source.tilingDebtSettled).toEqual([]);
  });

  it("settles instead for a session the lane delivered with everything it had", async () => {
    // THE SIBLING. A service that recorded every delivery as owed passes the
    // case above and fails here.
    const source = new FakeSyncSource([
      makeSyncedSession(INTACT_SESSION, "2026-06-08T12:00:00.000Z"),
    ]);

    await runLane(source);

    expect(source.tilingDebtOwed).toEqual([]);
    expect(source.tilingDebtSettled).toEqual([INTACT_SESSION]);
  });

  it("sweeps the ledger only once the server advertises activity chunking", async () => {
    const withoutCapability = new FakeSyncSource([
      makeSyncedSession(INTACT_SESSION, "2026-06-08T12:00:00.000Z"),
    ]);
    await runLane(withoutCapability);
    expect(withoutCapability.tilingRepairSweeps).toBe(0);

    const withCapability = new FakeSyncSource([
      makeSyncedSession(INTACT_SESSION, "2026-06-08T12:00:00.000Z"),
    ]);
    await runLane(withCapability, { activityChunking: true });
    expect(withCapability.tilingRepairSweeps).toBe(1);
  });
});

/** Drive the real sync lane end to end against an always-accepting server. */
async function runLane(
  source: FakeSyncSource,
  capabilities: { activityChunking?: boolean } = {}
): Promise<void> {
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET_ID,
    isSyncActivityChunkingSupported: () =>
      capabilities.activityChunking === true,
    sendBatch: () => Promise.resolve({ accepted: true as const }),
  });
  service.start();
  try {
    await settleSelfContinuedDrain(service);
  } finally {
    service.stop();
  }
}

/** Drive the real accepted-ack path and capture only the ledger writes. */
async function driveAckDebt(
  overrides: Partial<AcceptedAckInput>
): Promise<{ owed: string[]; settled: string[] }[]> {
  const debt: { owed: string[]; settled: string[] }[] = [];
  const ids = overrides.ids ?? [STRIPPED_SESSION];
  await processAcceptedAck(
    {
      syncMode: "incremental",
      sessionCount: ids.length,
      payloadBytes: 4096,
      latencyMs: 120,
      hasMoreChunks: false,
      remainingChunks: null,
      acceptedSessionIds: ids,
      ...overrides,
      ids,
    },
    {
      ...inertAckDeps(),
      recordTilingDebt: (write) => {
        debt.push(write);
        return Promise.resolve();
      },
    }
  );
  return debt;
}

/**
 * A writer bound to a source whose repair delegate only counts, so the gate and
 * the once-per-lane bound are observed without a store.
 */
function writersWithRepairSpy(): {
  writers: ReturnType<typeof createOutboxWriters>;
  spy: { calls: number };
} {
  const spy = { calls: 0 };
  const source = {
    requeueOwedActivityTilings: () => {
      spy.calls += 1;
      return 0;
    },
  } as unknown as AgentSessionSyncSource;
  const target: OutboxWriteTarget = { sourceKey: "lane:target", source };
  return { writers: createOutboxWriters(() => target), spy };
}

/** Everything the ack path needs and this suite does not assert on. */
function inertAckDeps(): AcceptedAckDeps {
  return {
    rowState: {
      timeoutCountById: new Map(),
      rateLimitedCountById: new Map(),
      unknownAckReasonCountById: new Map(),
      ingestionFailedCountById: new Map(),
      laneStalledSinceMsById: new Map(),
      validationFailedCountById: new Map(),
      ackOmittedCountById: new Map(),
      validationBisectIds: new Set(),
      transportErrorCountById: new Map(),
      clearTransportTimeoutBudgetFor: () => undefined,
      nextRetryAfterMs: new Map(),
      deadLetterCountById: new Map(),
      chunkValidationCycleById: new Map(),
      ackOmittedCycleById: new Map(),
      deadLetteredIds: new Map(),
    },
    // ISS-7957: models a store in which every acked id still HAD a row, which
    // is what `deleteMany` would report for these fixtures. The absent-row
    // case — where the count and the ack length diverge — is the subject of
    // `agent-session-outbox-cleared-rows.test.ts`.
    clearOutboxDurably: (ids) =>
      Promise.resolve({ cleared: true, deletedRowCount: ids.length }),
    sourceStateGeneration: () => 0,
    isStarted: () => true,
    // ISS-8116: these bags exercise ack folding, not identity; the pass-level
    // switch has its own suite (agent-session-sync-pass-identity-guards).
    isCurrentSourceIdentity: () => true,
    dequeue: () => undefined,
    clearLaneGiveUp: () => undefined,
    persistCursorIfCaughtUp: () => undefined,
    applyBoundedFold: () => undefined,
    deadLetteredCount: () => 0,
    resetDeadLetterRevisitAfterDrainedAck: () => undefined,
    queueSizes: () => ({ incremental: 0, backfill: 0 }),
    discardPendingChunkTail: () => undefined,
    schedulePendingPartDrain: () => undefined,
    scheduleImmediateDrainIfReadyWorkRemains: () => undefined,
    emitTelemetry: () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
  };
}
