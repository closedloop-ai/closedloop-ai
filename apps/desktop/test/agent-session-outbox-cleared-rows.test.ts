/**
 * @file agent-session-outbox-cleared-rows.test.ts
 * @description ISS-7957 — `durablyClearedRows` must report the rows the outbox
 * delete ACTUALLY removed, not the number of ids the ack named.
 *
 * The discriminating case is a clear whose ids no longer correspond to rows: the
 * two numbers agree everywhere else, and disagree exactly where the field was
 * reporting progress that did not happen. Every refusal below therefore names
 * ids with no surviving row, and every one has a positive sibling on the same
 * subject where the rows DO exist — so none can pass by simply never measuring.
 *
 * Three layers, because the defect could be reintroduced at any of them:
 *  1. the store (`sqliteClearOutboxEntries`, against a real libSQL database),
 *  2. the db-host IPC boundary (`readClearedRowCount`), and
 *  3. the emitted batch event (`processAcceptedAck`), which is what the ISS-5387
 *     burn-down actually publishes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import { clearOutboxOnAck } from "../src/main/agent-sync/agent-session-outbox-writers.js";
import { processAcceptedAck } from "../src/main/agent-sync/agent-session-sync-accepted-ack.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { OutboxClearResult } from "../src/main/agent-sync/outbox-clear-result.js";
import {
  OutboxClearCountKind,
  readClearedRowCount,
} from "../src/main/agent-sync/outbox-clear-result.js";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  callDbHostOp,
  type DbHostInvokeDeps,
  dispatchDbHostInvoke,
} from "../src/main/database/db-host/db-host-invoke-dispatch.js";
import { createDbHostOpLanes } from "../src/main/database/db-host/db-host-op-lanes.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { WriteDispatchState } from "../src/main/database/write-queue.js";
import type { DbHostChildListenerArgs } from "./db-host-fake-child-support.js";
import { FakeSyncSource } from "./fake-sync-source.js";

const SOURCE_KEY = "agent_sessions:target-iss-7957";

async function withDb(
  body: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7957-outbox-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-24T00:00:00.000Z",
    });
    try {
      await body(db);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A peer on the pre-ISS-7957 delegate shape: it performs the delete and reports
 * NOTHING about it, which is exactly what a version-skewed db-host child
 * answers. The interface allows this by construction (the return is optional);
 * only this fixture's default narrows it.
 */
class VersionSkewedClearSource extends FakeSyncSource {
  // ISS-8116 widened the base to the interface's own `| Promise<…>` union, so
  // the super call is awaited here; the fake's body is still synchronous.
  override async clearOutboxEntries(
    sourceKey: string,
    ids: string[]
  ): Promise<OutboxClearResult | undefined> {
    await super.clearOutboxEntries(sourceKey, ids);
    return undefined;
  }
}

/**
 * LAYER 1 REFUSAL — the store. `sqliteClearOutboxEntries` already held
 * `deleteMany`'s `count` and discarded it.
 */
test("ISS-7957: the store reports rows removed, not ids asked about", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "present-1", syncClass: "backfill" },
      { externalSessionId: "present-2", syncClass: "backfill" },
    ]);

    // Three ids, two rows: the divergence the field exists to stop reporting.
    const partial = await src.clearOutboxEntries?.(SOURCE_KEY, [
      "present-1",
      "present-2",
      "never-enqueued",
    ]);
    assert.equal(
      countOf(partial),
      2,
      "a clear over three ids that removed two rows must report 2, not 3"
    );

    // And the case that matters most: an ack for ids that no longer correspond
    // to rows removed NOTHING, however many ids it named.
    const none = await src.clearOutboxEntries?.(SOURCE_KEY, [
      "present-1",
      "present-2",
    ]);
    assert.equal(
      countOf(none),
      0,
      "a re-ack of already-cleared ids must report 0, not the ack length"
    );
  });
});

/**
 * LAYER 1 ALLOW — the positive sibling. Every id has a row, so the count and the
 * ack length coincide; without this the refusal above could be satisfied by a
 * store that always answered 0.
 */
test("ISS-7957: the store reports the full count when every acked id has a row", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "a", syncClass: "backfill" },
      { externalSessionId: "b", syncClass: "incremental" },
      { externalSessionId: "c", syncClass: "backfill" },
    ]);

    const cleared = await src.clearOutboxEntries?.(SOURCE_KEY, ["a", "b", "c"]);
    assert.equal(countOf(cleared), 3, "three rows removed must report 3");
    assert.deepEqual(
      [...((await src.loadPendingOutboxIds?.(SOURCE_KEY)) ?? [])],
      [],
      "and the rows really are gone"
    );
  });
});

/**
 * LAYER 2 — the db-host `utilityProcess` boundary.
 *
 * `syncSource.clearOutboxEntries` is the FEA-2038 forwarding Proxy in that
 * build: the reply is whatever the child structured-cloned back, delivered
 * verbatim by `db-host-invoke-dispatch` with no validation, and the main-process
 * type is a single cast. So the static type of this value is an assertion about
 * the peer, not a fact — which makes malformed and unknown input REACHABLE here
 * even though `tsc` forbids it in process.
 */
test("ISS-7957: the boundary reads a well-formed count, including a structured-clone round trip", () => {
  assert.equal(
    countOf({ deletedRowCount: 2 }),
    2,
    "a well-formed reply yields its count"
  );
  assert.equal(
    countOf(structuredClone({ deletedRowCount: 7 })),
    7,
    "and survives the clone the IPC hop actually performs"
  );
  assert.equal(
    countOf({ deletedRowCount: 0 }),
    0,
    "a reported zero is a MEASURED zero and must arrive as 0, never as unmeasured"
  );
  // The ALLOW half of the safe-integer pair below. Without it, a schema that
  // simply refused every large number would satisfy that refusal and prove
  // nothing about WHERE the believable range ends.
  assert.equal(
    countOf({ deletedRowCount: Number.MAX_SAFE_INTEGER }),
    Number.MAX_SAFE_INTEGER,
    "the largest exactly-representable count is still a believable one"
  );
});

/**
 * LAYER 2b — the SAME boundary, driven end to end through the production
 * db-host client/proxy path instead of a hand-built object (PR #6000 review,
 * davetho).
 *
 * Everything above this point hands `readClearedRowCount` a literal. That proves
 * the reader, not the CARRIER: the hop the count actually makes is
 * `createDbHostAgentDatabase`'s forwarding Proxy → `DbHostClient.invoke` →
 * `dispatchDbHostInvoke` in the child → `deliver` → the structured clone
 * `postMessage` performs. Nothing but this test executes that chain for
 * `syncSource.clearOutboxEntries`, and a result dropped anywhere along it —
 * `deliver` not called, the value not made clone-safe, the op path not resolving
 * to the delegate — is invisible to every other layer here.
 *
 * The fakes are the CHILD PROCESS and, since ISS-8246 M1, the STORE THREAD. The
 * child side runs the real `dispatchDbHostInvoke` and the real `callDbHostOp`
 * over a real libSQL `syncSource`, and the main side is the real client and the
 * real Proxy — so op resolution, the delegate call, `deliver`, and the result's
 * clone-safety are all production. What this does NOT cross is either real
 * boundary: the utilityProcess fork or the store worker's `postMessage`.
 */
async function clearThroughDbHost(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  ids: string[]
): Promise<unknown> {
  let toMain: ((message: unknown) => void) | undefined;
  const deps: DbHostInvokeDeps = {
    lanes: createDbHostOpLanes(),
    isOpen: () => true,
    probeUndispatchedWrite: () => ({
      state: WriteDispatchState.Absent,
      taskSeq: null,
    }),
    // ISS-8246 M1 — in production `runOnStore` posts to the store thread and
    // `db-store-host` calls `callDbHostOp` there. This drives that same
    // production function directly, so the op-path resolution and the delegate
    // call are real; what this test does NOT cross is the thread hop itself.
    runOnStore: (op: string, args: unknown[]) => callDbHostOp(db, op, args),
    getInsights: (_args, compute) => compute(() => undefined),
    deliver: () => undefined,
  };
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        toMain = args[1];
      }
      return child;
    },
    // Typed as the real `DbHostRequest` union rather than a loose shape, so the
    // op/args below are narrowed by the protocol instead of cast into place.
    postMessage(message: DbHostRequest) {
      if (message.kind === DbHostRequestKind.Init) {
        toMain?.({ kind: DbHostResponseKind.Ready, id: message.id });
        return;
      }
      if (message.kind !== DbHostRequestKind.Invoke) {
        return;
      }
      // `postMessage` structured-clones in BOTH directions, so the child sees a
      // clone of the args and main sees a clone of the reply. Modelling only the
      // reply would let a non-clone-safe argument pass here and fail in Electron.
      const request = structuredClone(message.args);
      dispatchDbHostInvoke(message.op, request, {
        ...deps,
        deliver: (value: unknown) =>
          toMain?.({
            kind: DbHostResponseKind.Result,
            id: message.id,
            ok: true,
            value: structuredClone(value),
          }),
      }).catch((error: unknown) =>
        toMain?.({
          kind: DbHostResponseKind.Result,
          id: message.id,
          ok: false,
          error: { message: String(error) },
        })
      );
    },
    kill() {
      // no-op for the fake
    },
  };
  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog: () => undefined,
    fork: () => child,
  });
  await client.start({ dataDir: "/tmp/agent-dashboard" });
  try {
    // The production Proxy, reached exactly as the sync lane reaches it.
    const agentDatabase = createDbHostAgentDatabase(client);
    return await agentDatabase.syncSource.clearOutboxEntries?.(SOURCE_KEY, ids);
  } finally {
    await client.close();
  }
}

/**
 * LAYER 2b REFUSAL — the discriminating case, carried over the real hop: two ids
 * acked, ZERO surviving rows. An ack-length answer would arrive as `2`.
 */
test("ISS-7957: the db-host invoke path carries a count of 0 when the delete matched no rows", async () => {
  await withDb(async (db) => {
    await db.syncSource.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "gone-1", syncClass: "backfill" },
      { externalSessionId: "gone-2", syncClass: "backfill" },
    ]);
    await db.syncSource.clearOutboxEntries?.(SOURCE_KEY, ["gone-1", "gone-2"]);

    const replied = await clearThroughDbHost(db, ["gone-1", "gone-2"]);
    assert.equal(
      countOf(replied),
      0,
      "the count that survived the db-host hop must be the delete's, not the two ids it named"
    );
  });
});

/**
 * LAYER 2b ALLOW — the same hop with rows present. Without it the refusal above
 * is satisfied by a carrier that lost the field entirely and answered
 * UNMEASURED... except `undefined` is not `0`, so it is satisfied by a carrier
 * that answers a hard-coded zero. This is what rejects that.
 */
test("ISS-7957: the db-host invoke path carries the rows a delete really removed", async () => {
  await withDb(async (db) => {
    await db.syncSource.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "live-1", syncClass: "backfill" },
      { externalSessionId: "live-2", syncClass: "incremental" },
      { externalSessionId: "live-3", syncClass: "backfill" },
    ]);

    // Two of the three: a count that is neither the ack length nor the table.
    const replied = await clearThroughDbHost(db, ["live-1", "live-2"]);
    assert.equal(
      countOf(replied),
      2,
      "two rows removed must arrive as 2 across the db-host boundary"
    );
    assert.deepEqual(
      [...((await db.syncSource.loadPendingOutboxIds?.(SOURCE_KEY)) ?? [])],
      ["live-3"],
      "and the delete the child ran is the real one"
    );
  });
});

/**
 * LAYER 2 — a NEWER peer's richer reply must still travel.
 *
 * This is why the boundary schema is loose rather than `.strict()`: a strict one
 * rejects the ENTIRE payload over a single key it was never taught, turning a
 * newer peer's extra field into total loss of the count. The compile-time
 * keys-covered guard on `OUTBOX_CLEAR_RESULT_SHAPE` is what keeps the schema
 * honest as fields are added, not strictness.
 */
test("ISS-7957: the boundary keeps the count when a newer peer adds a field it has never heard of", () => {
  assert.equal(
    countOf({ deletedRowCount: 4, deletedByLane: { bulk: 4 } }),
    4,
    "an unknown key must not cost the field this boundary exists to carry"
  );
});

/**
 * LAYER 2 REFUSAL — everything that cannot be believed reads as UNMEASURED.
 *
 * `undefined` is the version-skew case (a db-host peer that predates the field),
 * and it must NOT become `0`: downstream, an omission means "nothing measured"
 * while a zero means "measured, cleared nothing" — and the second is the
 * alarming reading on the very alert that has to tell those apart.
 */
test("ISS-7957: the boundary answers UNMEASURED for a reply it cannot believe", () => {
  for (const reply of [
    undefined,
    null,
    {},
    { deletedRowCount: "2" },
    { deletedRowCount: -1 },
    { deletedRowCount: Number.NaN },
    { deletedRowCount: 1.5 },
    { deletedRowCount: Number.POSITIVE_INFINITY },
    // PR #6000 review (whitlockk): past MAX_SAFE_INTEGER a JS number no longer
    // names one integer, so a corrupted reply would otherwise arrive as a
    // precise-looking burn-down count. `z.number().int()` bounds itself to the
    // safe range; this pins that so swapping it for a bare `Number.isInteger`
    // refinement — which accepts both of these — cannot widen it unnoticed.
    { deletedRowCount: Number.MAX_SAFE_INTEGER + 1 },
    { deletedRowCount: 2 ** 64 },
    [],
    "2",
    2,
  ]) {
    assert.equal(
      countOf(reply),
      undefined,
      `an unbelievable reply must read as unmeasured, not fabricate a count: ${JSON.stringify(reply) ?? String(reply)}`
    );
  }
});

/**
 * LAYER 2 — a source with no outbox delegate measured nothing, and says so.
 * `clearOutboxOnAck` must OMIT the field rather than report a zero, which is the
 * legacy/fake-source arm of the same distinction.
 */
test("ISS-7957: a source with no outbox delegate leaves the count unmeasured", async () => {
  const cleared = await clearOutboxOnAck(
    { sourceKey: SOURCE_KEY, source: null },
    ["s1", "s2"]
  );
  assert.equal(cleared.cleared, true, "ack processing still proceeds");
  assert.ok(
    !Object.hasOwn(cleared, "deletedRowCount"),
    "and the count is OMITTED — a source with no outbox measured nothing"
  );
});

/**
 * LAYER 2 — a clear that THREW reports failure and no count. Paired with the
 * case above so "no count" cannot be read as one single meaning.
 */
test("ISS-7957: a failed clear reports failure and no count", async () => {
  const source = new FakeSyncSource([]);
  source.clearOutboxEntries = () => {
    throw new Error("write queue closed");
  };
  const cleared = await clearOutboxOnAck({ sourceKey: SOURCE_KEY, source }, [
    "s1",
  ]);
  assert.equal(cleared.cleared, false, "a failed write is not a clear");
  assert.ok(
    !Object.hasOwn(cleared, "deletedRowCount"),
    "and reports no count rather than a zero that would read as measured"
  );
});

/**
 * LAYER 3 REFUSAL — the emitted batch event, which is what the ISS-5387
 * burn-down publishes as `queueRowsClearedSincePrevious`.
 *
 * This is the end-to-end shape of the defect: the server acks two ids, the
 * durable delete matches ZERO rows (they were already cleared by an earlier ack
 * whose in-memory dequeue was lost), and the field used to report `2`.
 */
test("ISS-7957: the batch event reports 0 when the durable delete matched no rows", async () => {
  const source = new FakeSyncSource([]);
  // Deliberately NOT seeded: the ids name no surviving row.
  const events = await driveAck(source, ["s1", "s2"]);
  assert.equal(
    events.at(-1)?.durablyClearedRows,
    0,
    "an ack whose delete removed nothing must report 0, not the two ids it named"
  );
});

/**
 * LAYER 3 ALLOW — same drive, rows present. The count and the ack length
 * coincide here, which is what makes the refusal above about the DELETE rather
 * than about the field having been quietly dropped.
 */
test("ISS-7957: the batch event reports the rows a delete really removed", async () => {
  const source = new FakeSyncSource([]);
  source.seedOutbox(SOURCE_KEY, "s1");
  source.seedOutbox(SOURCE_KEY, "s2");
  const events = await driveAck(source, ["s1", "s2"]);
  assert.equal(
    events.at(-1)?.durablyClearedRows,
    2,
    "two rows removed must report 2"
  );
});

/**
 * LAYER 3 — the partial case, which no other layer proves end to end: one of the
 * two acked ids still has a row. The ack length says 2, the delete says 1.
 */
test("ISS-7957: the batch event reports the removed subset when only some ids had rows", async () => {
  const source = new FakeSyncSource([]);
  source.seedOutbox(SOURCE_KEY, "s1");
  const events = await driveAck(source, ["s1", "s2"]);
  assert.equal(
    events.at(-1)?.durablyClearedRows,
    1,
    "one row removed out of two acked ids must report 1"
  );
});

/**
 * LAYER 3 REFUSAL — the OMISSION, asserted on the EVENT rather than on
 * `clearOutboxOnAck`'s return.
 *
 * This is the case the rest of layer 3 cannot reach: every other case here
 * drives a source that HAS an outbox delegate, so a count is always measured
 * and the field is always present. Without this, replacing either conditional
 * spread on the way to the event with `?? 0` — in `processAcceptedAck` or in
 * `advanceOnDurableClear` — leaves the whole suite green while re-introducing
 * the exact collapse this module exists to stop.
 *
 * The collapse is not cosmetic. An omitted field leaves
 * `SyncBurndownReporter.sessionRowsCleared` at its `null` initial value; a
 * fabricated `0` takes the `typeof clearedRows === "number"` branch and
 * publishes `queueRowsClearedSincePrevious: 0` — the measured-nothing-delivered
 * reading — for a source that never counted anything at all.
 */
test("ISS-7957: the batch event OMITS the count when the clear measured nothing", async () => {
  // A source with no outbox delegate at all: nothing measured a count.
  const events = await driveAck(null, ["s1", "s2"]);
  assert.equal(events.length, 1, "the ack still emits its Success");
  assert.ok(
    !Object.hasOwn(events.at(-1) ?? {}, "durablyClearedRows"),
    "an unmeasured clear must leave the field ABSENT — a `0` here reads as `measured, delivered nothing` and raises the alarm this field exists to help silence"
  );
});

/**
 * LAYER 3 REFUSAL — the same omission arriving through VERSION SKEW rather than
 * through a missing delegate: a db-host peer that predates the field answers
 * `undefined`, and `readClearedRowCount` degrades it to unmeasured. Distinct
 * from the case above because it exercises the boundary reader on the real path
 * to the event, not the no-delegate short-circuit in front of it.
 */
test("ISS-7957: the batch event OMITS the count when a version-skewed peer reports none", async () => {
  const source = new VersionSkewedClearSource([]);
  source.seedOutbox(SOURCE_KEY, "s1");
  const events = await driveAck(source, ["s1"]);
  assert.deepEqual(
    source.pendingOutboxIds(SOURCE_KEY),
    [],
    "sanity: the row really was deleted — the peer did the work and only withheld the count"
  );
  assert.ok(
    !Object.hasOwn(events.at(-1) ?? {}, "durablyClearedRows"),
    "a peer that reports no count must leave the field ABSENT rather than have one fabricated for it"
  );
});

test("ISS-11427: a verified ack also clears the lane's set-aside marker, so the row stops reporting a dead letter", async () => {
  const deps = inertAckDeps();
  deps.rowState.deadLetteredIds.set("delivered", Number.POSITIVE_INFINITY);
  deps.rowState.deadLetteredIds.set(
    "still-set-aside",
    Number.POSITIVE_INFINITY
  );

  await processAcceptedAck(
    {
      ids: ["delivered"],
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
      payloadBytes: 1024,
      latencyMs: 12,
      hasMoreChunks: false,
      remainingChunks: null,
    },
    {
      ...deps,
      clearOutboxDurably: () =>
        Promise.resolve({ cleared: true, deletedRowCount: 1 }),
      emitTelemetry: () => 0,
    }
  );

  assert.deepEqual(
    [...deps.rowState.deadLetteredIds.keys()],
    ["still-set-aside"]
  );
});

/**
 * Drive the real `processAcceptedAck` over the real `clearOutboxOnAck` against
 * `source`'s outbox, and return the events it emitted. Everything else is inert
 * — the subject is the one number that reaches the event.
 */
async function driveAck(
  source: AgentSessionSyncSource | null,
  ids: string[]
): Promise<Array<{ durablyClearedRows?: number }>> {
  const events: Array<{ durablyClearedRows?: number }> = [];
  await processAcceptedAck(
    {
      ids,
      syncMode: AgentSessionSyncMode.Backfill,
      sessionCount: ids.length,
      payloadBytes: 1024,
      latencyMs: 12,
      hasMoreChunks: false,
      remainingChunks: null,
    },
    {
      ...inertAckDeps(),
      clearOutboxDurably: (ackedIds) =>
        clearOutboxOnAck({ sourceKey: SOURCE_KEY, source }, ackedIds),
      emitTelemetry: (event) => events.push(event),
    }
  );
  return events;
}

/** Every collaborator this suite does not exercise, as a no-op. */
function inertAckDeps() {
  return {
    rowState: {
      timeoutCountById: new Map<string, number>(),
      rateLimitedCountById: new Map<string, number>(),
      unknownAckReasonCountById: new Map<string, number>(),
      ingestionFailedCountById: new Map<string, number>(),
      laneStalledSinceMsById: new Map<string, number>(),
      validationFailedCountById: new Map<string, number>(),
      ackOmittedCountById: new Map<string, number>(),
      validationBisectIds: new Set<string>(),
      transportErrorCountById: new Map<string, number>(),
      clearTransportTimeoutBudgetFor: () => {
        // no budget to refund in this suite
      },
      nextRetryAfterMs: new Map<string, number>(),
      deadLetterCountById: new Map<string, number>(),
      chunkValidationCycleById: new Map<string, number>(),
      ackOmittedCycleById: new Map<string, number>(),
      deadLetteredIds: new Map<string, number>(),
    },
    sourceStateGeneration: () => 0,
    isStarted: () => true,
    // ISS-8116: these bags exercise ack folding, not identity; the pass-level
    // switch has its own suite (agent-session-sync-pass-identity-guards).
    isCurrentSourceIdentity: () => true,
    dequeue: () => {
      // nothing queued in this suite
    },
    clearLaneGiveUp: () => {
      // no lane give-up under test
    },
    persistCursorIfCaughtUp: () => {
      // no cursor under test
    },
    applyBoundedFold: () => {
      // no omitted rows in this suite
    },
    deadLetteredCount: () => 0,
    resetDeadLetterRevisitAfterDrainedAck: () => {
      // no revisit guard under test
    },
    queueSizes: () => ({ incremental: 0, backfill: 0 }),
    discardPendingChunkTail: () => {
      // no chunk tail in this suite
    },
    schedulePendingPartDrain: () => {
      // no part drain in this suite
    },
    scheduleImmediateDrainIfReadyWorkRemains: () => {
      // no self-continue under test
    },
    logInfo: () => {
      // quiet
    },
    logError: () => {
      // quiet
    },
  };
}

/**
 * The NUMBER a reply yields, or `undefined` when it yielded none.
 *
 * ISS-8179 changed `readClearedRowCount` to name WHICH count-less answer it got
 * (absent vs malformed) instead of collapsing both into one `undefined`. Every
 * expectation in this file is about the number itself, and none of them changed,
 * so they read through this rather than being rewritten: an unbelievable reply
 * must still fabricate no count. Which ARM produced the omission — and that a
 * malformed one now reaches a monitored diagnostic while an older peer stays
 * silent — is asserted in `agent-session-outbox-clear-count-anomaly.test.ts`.
 */
function countOf(reply: unknown): number | undefined {
  const reading = readClearedRowCount(reply);
  return reading.kind === OutboxClearCountKind.Measured
    ? reading.deletedRowCount
    : undefined;
}
