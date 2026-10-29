/**
 * @file lane-run-record.test.ts
 * @description PLN-2028 (ISS-10053): direct coverage for `LaneRunRecord` — the
 * durable half of a lane's environmental run — and for the clone-safe persists
 * both lanes derive from it.
 *
 * It had none as a stamp. The equality gate, the optimistic-update-then-forget
 * path and `clearIdentity` were reachable only through two lanes that also carry
 * a cursor, a batch and a dead-letter tracker, so a defect in the write
 * discipline surfaced as one of those lanes behaving oddly.
 *
 * Every change-detection case names the write it expects AND the write it expects
 * NOT to happen. Issuing a write only when a column would actually change is this
 * module's whole job, so a suite that asserted only the writes would pass
 * unchanged against a tracker that wrote on every call.
 *
 * The ACKNOWLEDGED-WRITE cases (PLN-2028 D5) are the ones the run origin added.
 * A dropped stamp cost one repeated 24h run; a dropped origin removes the ceiling
 * outright, so the write is re-attempted once, serialized, and a re-attempt a
 * newer record has overtaken is dropped rather than landed.
 */
import {
  LaneGiveUpSource,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { describe, expect, it } from "vitest";
import type { PersistedLaneRun } from "../src/main/agent-sync/sync-cursor-state-source.js";
import {
  LaneRunRecord,
  type LaneRunState,
  laneGiveUpStampOnly,
  sourceLaneGiveUpStampPersist,
  sourceLaneRunPersist,
} from "../src/main/sync/lane-run-record.js";

const KEY = "agent_components:target-a";
const OTHER_KEY = "agent_components:target-b";
const OPENED_MS = Date.parse("2026-08-02T12:00:00.000Z");
const GAVE_UP_MS = Date.parse("2026-08-03T12:00:00.000Z");
const LATER_MS = GAVE_UP_MS + 3_600_000;
const OPENED_AT = new Date(OPENED_MS).toISOString();
const GAVE_UP_AT = new Date(GAVE_UP_MS).toISOString();
const LATER_AT = new Date(LATER_MS).toISOString();

/**
 * Drain the write chain COMPLETELY. One hop to the macrotask queue, because the
 * microtask queue is fully drained before it — including the microtasks each
 * link enqueues, which is what a counted flush cannot know the length of. A
 * fixed count reads a pending re-attempt, or a write still queued behind four
 * others, as a write that never happened.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The whole-record shape a gate-backed lane writes. */
function gateRun(overrides: Partial<LaneRunState> = {}): LaneRunState {
  return {
    stalledSinceMs: OPENED_MS,
    gaveUpAtMs: GAVE_UP_MS,
    reason: SyncReason.IngestionFailed,
    source: LaneGiveUpSource.EnvironmentalGate,
    ...overrides,
  };
}

const GATE_RECORD: PersistedLaneRun = {
  laneStalledSince: OPENED_AT,
  laneGaveUpAt: GAVE_UP_AT,
  laneGaveUpReason: SyncReason.IngestionFailed,
  laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
};

const CLEARED_RECORD: PersistedLaneRun = {
  laneStalledSince: null,
  laneGaveUpAt: null,
  laneGaveUpReason: null,
  laneGaveUpSource: null,
};

function makeRecord(
  options: {
    /**
     * `false` models a source whose delegate is missing (legacy / db host down).
     * A PREDICATE models one that VANISHES mid-run, which is the only way to
     * reach `attempt`'s own re-resolution.
     */
    available?: boolean | (() => boolean);
    /** Throw to model a synchronous refusal; reject to model an async one. */
    onWrite?: (key: string, run: PersistedLaneRun) => void | Promise<void>;
    /**
     * Model a caller whose own OUTCOME HOOK is broken. The hooks are the
     * tracker's only reporting channel, and one of them throwing must not end
     * this tracker's writes for the life of the process.
     */
    throwFrom?: "succeeded" | "failed";
  } = {}
) {
  const writes: Array<{ key: string; run: PersistedLaneRun }> = [];
  const failures: string[] = [];
  const counts = { succeeded: 0, unavailable: 0 };
  const record = new LaneRunRecord({
    getPersist: () =>
      isAvailable(options.available)
        ? (key, run) => {
            writes.push({ key, run });
            return options.onWrite?.(key, run);
          }
        : undefined,
    onWriteFailed: (message) => {
      failures.push(message);
      if (options.throwFrom === "failed") {
        throw new Error("the failure hook is broken");
      }
    },
    onWriteSucceeded: () => {
      counts.succeeded += 1;
      if (options.throwFrom === "succeeded") {
        throw new Error("the success hook is broken");
      }
    },
    onPersistUnavailable: () => {
      counts.unavailable += 1;
    },
  });
  return { record, writes, failures, counts };
}

describe("LaneRunRecord change detection", () => {
  it("writes a changed record once and says nothing the second time", async () => {
    // The gate that makes this affordable: a healthy lane reconciles on every
    // accepted batch, and without it each one would issue a redundant SQLite
    // write onto the single-connection queue every other lane serializes behind.
    const { record, writes, counts } = makeRecord();

    record.reconcile(KEY, gateRun());
    record.reconcile(KEY, gateRun());
    await settle();

    expect(writes).toEqual([{ key: KEY, run: GATE_RECORD }]);
    expect(counts.succeeded).toBe(1);
  });

  it("writes again when ANY of the four columns genuinely changes", async () => {
    // One case per column, because an equality gate that compared only the stamp
    // would suppress a changed origin, cause or producer — and the origin is the
    // one that carries the ceiling across a relaunch.
    const { record, writes } = makeRecord();

    record.reconcile(KEY, gateRun());
    record.reconcile(KEY, gateRun({ stalledSinceMs: GAVE_UP_MS }));
    record.reconcile(KEY, gateRun({ gaveUpAtMs: LATER_MS }));
    record.reconcile(KEY, gateRun({ reason: SyncReason.RateLimited }));
    record.reconcile(KEY, gateRun({ source: LaneGiveUpSource.RowCeiling }));
    await settle();

    expect(writes).toHaveLength(5);
  });

  it("never carries one identity's believed record onto another's row", async () => {
    // Invariant 2. An account or compute-target switch is a DIFFERENT sync_state
    // row, so the same record must be written again rather than suppressed by a
    // belief that describes the previous lane.
    const { record, writes } = makeRecord();

    record.reconcile(KEY, gateRun());
    record.reconcile(OTHER_KEY, gateRun());
    await settle();

    expect(writes.map((write) => write.key)).toEqual([KEY, OTHER_KEY]);
  });

  it("adopts a hydrated record without writing it back, and still writes a different one", async () => {
    // A hydration is the one moment the columns are known to be current. Writing
    // them back would pay a write per boot for a lane whose state never changed;
    // NOT recording them would make the very next reconcile do the same.
    const { record, writes } = makeRecord();

    record.adopt(KEY, gateRun());
    record.reconcile(KEY, gateRun());
    await settle();
    expect(writes).toEqual([]);

    record.reconcile(KEY, laneGiveUpStampOnly(null));
    await settle();
    expect(writes).toEqual([{ key: KEY, run: CLEARED_RECORD }]);
  });

  it("forgets the identity on clearIdentity, so the next reconcile re-writes", async () => {
    // Target switch, stop, or a hydration that could not consult the row: after
    // it, nothing is known about what any column holds.
    const { record, writes } = makeRecord();

    record.adopt(KEY, laneGiveUpStampOnly(null));
    record.reconcile(KEY, laneGiveUpStampOnly(null));
    await settle();
    expect(writes).toEqual([]);

    record.clearIdentity();
    record.reconcile(KEY, laneGiveUpStampOnly(null));
    await settle();
    expect(writes).toEqual([{ key: KEY, run: CLEARED_RECORD }]);
  });

  it("writes a non-finite instant as a CLEARED column rather than throwing", async () => {
    // `new Date(NaN).toISOString()` throws, and the store refuses an unparseable
    // value outright — so a fabricated instant must never be built here. `null`
    // is the honest answer, and it keeps a bad in-memory clock from taking down
    // the tick that reconciled.
    const { record, writes, failures } = makeRecord();

    record.reconcile(KEY, gateRun({ stalledSinceMs: Number.NaN }));
    await settle();

    expect(writes[0]?.run.laneStalledSince).toBe(null);
    expect(failures).toEqual([]);
  });
});

describe("LaneRunRecord acknowledged writes (PLN-2028 D5)", () => {
  it("re-attempts a REJECTED write exactly once, with the identical record", async () => {
    // The origin IS the bound, so a dropped write does not delay the ceiling, it
    // removes it. One re-attempt is what the run buys over the stamp — and it is
    // ONE, not a ladder: the in-memory gate still governs this process.
    const { record, writes, failures, counts } = makeRecord({
      onWrite: () => Promise.reject(new Error("db-host exited")),
    });

    record.reconcile(KEY, gateRun());
    await settle();

    expect(writes).toEqual([
      { key: KEY, run: GATE_RECORD },
      { key: KEY, run: GATE_RECORD },
    ]);
    expect(failures).toEqual(["db-host exited"]);
    expect(counts.succeeded).toBe(0);
  });

  it("stops at the re-attempt when it LANDS, and reports the success once", async () => {
    let rejectNext = true;
    const { record, writes, failures, counts } = makeRecord({
      onWrite: () => {
        if (rejectNext) {
          rejectNext = false;
          return Promise.reject(new Error("db-host exited"));
        }
        return Promise.resolve();
      },
    });

    record.reconcile(KEY, gateRun());
    await settle();

    expect(writes).toHaveLength(2);
    expect(failures).toEqual([]);
    expect(counts.succeeded).toBe(1);
  });

  it("DROPS a re-attempt a newer record has overtaken, so a clear is not undone", async () => {
    // The defect this guard exists for: the give-up write is rejected, the lane
    // then ANSWERS and clears all four columns, and the stale retry lands after
    // it — resurrecting a run the lane has already ended, durably, until the next
    // genuine state change.
    let rejectNext = true;
    const { record, writes } = makeRecord({
      onWrite: () => {
        if (rejectNext) {
          rejectNext = false;
          return Promise.reject(new Error("db-host exited"));
        }
        return Promise.resolve();
      },
    });

    record.reconcile(KEY, gateRun());
    record.reconcile(KEY, laneGiveUpStampOnly(null));
    await settle();

    expect(writes).toEqual([
      { key: KEY, run: GATE_RECORD },
      { key: KEY, run: CLEARED_RECORD },
    ]);
    // The column the lane is left holding is the CLEAR, not a resurrected run.
    expect(writes.at(-1)?.run).toEqual(CLEARED_RECORD);
  });

  it("forgets the believed record after the re-attempt fails, so the next reconcile re-issues", async () => {
    // Optimistic-then-forget. The believed value is updated before the write is
    // known to have landed, so the forget is what stops the equality gate
    // suppressing a re-issue of a record that never reached the columns.
    const { record, writes } = makeRecord({
      onWrite: () => Promise.reject(new Error("db-host exited")),
    });

    record.reconcile(KEY, gateRun());
    await settle();
    expect(writes).toHaveLength(2);

    record.reconcile(KEY, gateRun());
    await settle();
    expect(writes).toHaveLength(4);
  });

  it("treats a synchronously THROWN write the same way, without taking down the tick", async () => {
    // The store REFUSES a value outside its column domain by throwing
    // (`assertWritableLaneRunColumns`). That refusal has to reach the lane's
    // write-failure hook, not the caller's stack.
    const { record, writes, failures } = makeRecord({
      onWrite: () => {
        throw new Error(
          "refused a lane-run write outside its column domain: laneGaveUpReason"
        );
      },
    });

    expect(() => record.reconcile(KEY, gateRun())).not.toThrow();
    await settle();

    expect(writes).toHaveLength(2);
    expect(failures).toEqual([
      "refused a lane-run write outside its column domain: laneGaveUpReason",
    ]);
  });

  it("names a lane with no durable write available and records no belief", () => {
    // A source with no delegate, or a db host that is down. The gate still
    // terminates this process's lane; the columns simply do not learn about it,
    // so the next reconcile must try again rather than compare against values
    // nothing ever wrote.
    const { record, counts } = makeRecord({ available: false });

    record.reconcile(KEY, gateRun());
    record.reconcile(KEY, gateRun());

    expect(counts.unavailable).toBe(2);
  });

  it("names a delegate that VANISHED after the check, not a failed write", async () => {
    // `reconcile` resolves the persist and `attempt` resolves it AGAIN, so the db
    // host can go down between them — and every write after a tracker's first is
    // deferred by a microtask, which is that window. The two hooks exist to keep
    // "there is no writer" distinguishable from "the writer refused", so this must
    // not reach the operator under the write-FAILED outcome.
    let available = true;
    const { record, writes, failures, counts } = makeRecord({
      available: () => available,
    });

    record.reconcile(KEY, gateRun());
    await settle();
    expect(writes).toHaveLength(1);

    record.reconcile(KEY, gateRun({ gaveUpAtMs: LATER_MS }));
    available = false;
    await settle();

    expect(writes).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(counts.unavailable).toBe(1);

    // And the belief was forgotten, so the re-issue is not suppressed by a record
    // that never reached the columns.
    available = true;
    record.reconcile(KEY, gateRun({ gaveUpAtMs: LATER_MS }));
    await settle();

    expect(writes.at(-1)?.run.laneGaveUpAt).toBe(LATER_AT);
  });
});

describe("LaneRunRecord: a broken outcome hook cannot end the write chain", () => {
  it("keeps writing after the SUCCESS hook throws, and does not re-issue the write that landed", async () => {
    // Writes are serialized on one promise chain, so a hook that throws rejects
    // the link every later write is chained onto: without a terminal catch the
    // second reconcile below never reaches the store at all, and the lane stops
    // persisting for the rest of the process. And the success hook is reported
    // OUTSIDE the write's own catch, or a throw from it reads as a rejected
    // write and re-issues a persist that already landed (tamsinb review).
    const { record, writes, failures } = makeRecord({ throwFrom: "succeeded" });

    record.reconcile(KEY, gateRun());
    await settle();
    record.reconcile(KEY, gateRun({ gaveUpAtMs: LATER_MS }));
    await settle();

    expect(writes.map((write) => write.run.laneGaveUpAt)).toEqual([
      GAVE_UP_AT,
      LATER_AT,
    ]);
    expect(failures).toEqual([]);
  });

  it("keeps writing after the FAILURE hook throws on a rejected write", async () => {
    let refuseWrite = true;
    const { record, writes } = makeRecord({
      throwFrom: "failed",
      onWrite: () =>
        refuseWrite
          ? Promise.reject(new Error("db-host exited (code: 0)"))
          : undefined,
    });

    record.reconcile(KEY, gateRun());
    await settle();
    // The write and its one re-attempt (D5), after which the failure is named —
    // through the hook that throws.
    expect(writes).toHaveLength(2);

    refuseWrite = false;
    record.reconcile(KEY, gateRun({ gaveUpAtMs: LATER_MS }));
    await settle();

    expect(writes.at(-1)?.run.laneGaveUpAt).toBe(LATER_AT);
  });
});

describe("LaneRunRecord.anchorGiveUp", () => {
  it("holds the give-up already on record instead of re-anchoring to the new instant", async () => {
    // The session lane's defect. Its ceiling is crossed per ROW, so a prolonged
    // outage folds a dead-letter every time another row's staggered clock runs
    // out, and each fold knows only `Date.now()`. An unanchored write slides the
    // column forward for the whole outage.
    const { record, writes } = makeRecord();

    record.anchorGiveUp(KEY, GAVE_UP_MS);
    record.anchorGiveUp(KEY, LATER_MS);
    record.anchorGiveUp(KEY, LATER_MS + 5000);
    await settle();

    expect(writes).toEqual([
      { key: KEY, run: { ...CLEARED_RECORD, laneGaveUpAt: GAVE_UP_AT } },
    ]);
  });

  it("anchors to a give-up HYDRATED from disk, so a relaunch does not restart it", async () => {
    const { record, writes } = makeRecord();

    record.adopt(KEY, laneGiveUpStampOnly(GAVE_UP_MS));
    record.anchorGiveUp(KEY, LATER_MS);
    await settle();

    expect(writes).toEqual([]);
  });

  it("carries the rest of the believed record through, so a stamp cannot erase an origin", async () => {
    // A stamp-only producer anchoring onto a row a gate-backed writer owns must
    // not spread three nulls over the origin, cause and producer beside it.
    const { record, writes } = makeRecord();

    record.adopt(KEY, gateRun({ gaveUpAtMs: null }));
    record.anchorGiveUp(KEY, LATER_MS);
    await settle();

    expect(writes).toEqual([
      { key: KEY, run: { ...GATE_RECORD, laneGaveUpAt: LATER_AT } },
    ]);
  });

  it("writes the new instant when nothing is on record to hold", async () => {
    // Three ways to have nothing: never hydrated, cleared by an answer, or
    // forgotten by a failed write. Anchoring to a value that never landed would
    // anchor to a fiction, so each of these writes.
    const fresh = makeRecord();
    fresh.record.anchorGiveUp(KEY, LATER_MS);
    await settle();
    expect(fresh.writes).toEqual([
      { key: KEY, run: { ...CLEARED_RECORD, laneGaveUpAt: LATER_AT } },
    ]);

    const answered = makeRecord();
    answered.record.adopt(KEY, laneGiveUpStampOnly(GAVE_UP_MS));
    answered.record.reconcile(KEY, laneGiveUpStampOnly(null));
    answered.record.anchorGiveUp(KEY, LATER_MS);
    await settle();
    expect(answered.writes.at(-1)?.run.laneGaveUpAt).toBe(LATER_AT);

    const switched = makeRecord();
    switched.record.adopt(KEY, laneGiveUpStampOnly(GAVE_UP_MS));
    switched.record.anchorGiveUp(OTHER_KEY, LATER_MS);
    await settle();
    expect(switched.writes).toEqual([
      { key: OTHER_KEY, run: { ...CLEARED_RECORD, laneGaveUpAt: LATER_AT } },
    ]);
  });
});

describe("lane-run persist derivations", () => {
  it("answers nothing when the source cannot record the op it needs", () => {
    expect(sourceLaneRunPersist(() => null)).toBeUndefined();
    expect(sourceLaneRunPersist(() => ({}))).toBeUndefined();
    expect(sourceLaneGiveUpStampPersist(() => null)).toBeUndefined();
    expect(sourceLaneGiveUpStampPersist(() => ({}))).toBeUndefined();
  });

  it("calls THROUGH the source rather than capturing its method (ISS-4620)", () => {
    // The clone-safe contract, asserted behaviourally: the DB-host source is a
    // proxy that resolves every property it does not know to an op PATH, so a
    // `.bind` posts the non-cloneable proxy and crashes the write. A bound
    // reference would still call the FIRST implementation here.
    const calls: string[] = [];
    const source = {
      recordLaneRun: () => {
        calls.push("first");
      },
    };
    const persist = sourceLaneRunPersist(() => source);

    source.recordLaneRun = () => {
      calls.push("second");
    };
    persist?.(KEY, GATE_RECORD);

    expect(calls).toEqual(["second"]);
  });

  it("sends the stamp ALONE through the compatibility alias", () => {
    // The session lane has not been moved onto the whole record yet, so its
    // writes must keep touching `lane_gave_up_at` and nothing else. Passing the
    // whole record here would clear three columns it does not compute.
    const stampWrites: Array<string | null> = [];
    const persist = sourceLaneGiveUpStampPersist(() => ({
      recordLaneGiveUp: (_key: string, gaveUpAt: string | null) => {
        stampWrites.push(gaveUpAt);
      },
    }));

    persist?.(KEY, GATE_RECORD);

    expect(stampWrites).toEqual([GAVE_UP_AT]);
  });
});

function isAvailable(
  available: boolean | (() => boolean) | undefined
): boolean {
  if (typeof available === "function") {
    return available();
  }
  return available !== false;
}
