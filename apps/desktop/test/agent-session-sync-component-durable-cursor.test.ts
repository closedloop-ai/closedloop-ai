/**
 * @file agent-session-sync-component-durable-cursor.test.ts
 * @description ISS-5347 regression coverage for the component-inventory sync
 * lane's DURABLE cursor.
 *
 * BUG (observed on a live install, 2026-08-06). `getSyncSource()` returns null
 * while the db host restarts — twice in one day on the reporting machine, logged
 * as `component cursor read failed: db-host exited (code: 0)`. When a lane tick
 * started inside that window and the lane needed to hydrate:
 *
 *   1. `hydrateCursorFor` cleared the in-memory keyset and marked the lane
 *      HYDRATED anyway, so the real cursor sitting on disk was replaced by the
 *      EPOCH position and never re-read;
 *   2. the lane then re-walked the entire inventory from epoch, and
 *      `buildComponentCursorPersist(null)` returned undefined, so every advance
 *      moved the keyset in memory and wrote NOTHING durable;
 *   3. `advanceComponentCursor` swallowed that with `.catch(() => undefined)` —
 *      no log, no counter, no state anywhere.
 *
 * Once the lane had walked past every row in memory there was nothing left to
 * advance, so even after the db host came back NO further persist was attempted:
 * the durable row stayed frozen. On the reporting machine it sat at
 * `observed_top_updated_at = 2026-08-03T20:56:53Z` / `data_revision = 65`
 * against a current `DATA_REVISION` of 68 for three days — 500 of 502 local
 * components newer than the recorded position — while the lane logged
 * `synced N agent component(s) to cloud inventory` 1,713 times in one day.
 *
 * FIX: a hydration that could not consult the durable cursor leaves the
 * in-memory position ALONE and does NOT mark the lane hydrated, so the next tick
 * adopts the durable cursor; the persist source is re-resolved at advance time
 * instead of reusing the run-entry capture; and the persist outcome is reported
 * so an absent or failing durable write names itself.
 *
 * These specs drive {@link AgentComponentSyncLane} DIRECTLY rather than through
 * `AgentSessionSyncService`. The service resets lane state on unrelated
 * session-lane failures, which masks exactly the cursor behavior under test —
 * a fixture whose session source is incomplete would re-hydrate the component
 * lane for the wrong reason and pass either way.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentComponentSyncLaneOptions } from "../src/main/agent-sync/agent-session-sync-component-lane.js";
import { AgentComponentSyncLane } from "../src/main/agent-sync/agent-session-sync-component-lane.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  acceptedResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const COMPUTE_TARGET = "target-durable-cursor";
const SOURCE_KEY = buildAgentComponentSyncSourceKey(COMPUTE_TARGET);
const TS_A = "2026-08-01T10:00:00.000Z";
const TS_B = "2026-08-03T20:56:53.196Z";
const TS_C = "2026-08-06T20:26:04.113Z";

/**
 * What the fake `advanceSyncState` does with one durable write: complete it,
 * reject it, or park it until the spec releases it.
 */
const PersistBehavior = {
  Ok: "ok",
  Reject: "reject",
  Hold: "hold",
} as const;
type PersistBehavior = (typeof PersistBehavior)[keyof typeof PersistBehavior];

/** A parked durable write plus the handle that completes or rejects it. */
type HeldPersist = {
  promise: Promise<void>;
  complete: () => void;
  fail: () => void;
};

type LaneFixtureOptions = {
  /** Initial rows in the keyset table. More can be added between ticks. */
  componentRows: AgentComponentCursorRow[];
  /**
   * Source availability, evaluated on every `getSource()` call. `false` models
   * the db host being down.
   *
   * `getSourceCall` is the 0-based index of the call WITHIN the current tick,
   * so a spec can flip availability mid-tick: the lane resolves the source once
   * at `run()` entry and again at `applyCursorAdvance` (ISS-5347), and those two
   * resolutions disagreeing is the production race — a db-host blip at run entry
   * while the write is healthy by the time the cursor advances.
   */
  sourceAvailable: (tick: number, getSourceCall: number) => boolean;
  /**
   * How the durable write behaves, evaluated per persist call (0-based).
   * Defaults to `"ok"`. `"hold"` parks the write until the spec releases it,
   * which is how a LATE outcome from a superseded attempt is reproduced.
   */
  persistBehavior?: (persistCall: number) => PersistBehavior;
  /** Durable `sync_state` row present before the first tick. */
  seedDurable?: PersistedSyncState;
  /**
   * Compute target for this tick. Defaults to a constant; a spec that needs an
   * account/target switch mid-lifetime overrides it so the lane's `sourceKey`
   * changes between ticks.
   */
  computeTargetId?: (tick: number) => string;
};

/**
 * Build a lane over a MUTABLE keyset table and an in-memory durable store, with
 * `getSource()` availability driven per tick so a db-host outage window is
 * reproducible.
 *
 * The readers are wired the way PRODUCTION wires them
 * (`desktop-sync-lane-composition.ts` re-resolves the source on every
 * `listComponentCursorRows` / `loadComponentRows` call) rather than closing over
 * one snapshot. That asymmetry is the whole point: a null `getSource()` does NOT
 * stop the lane reading, sending, or advancing — only persisting.
 */
function makeLaneFixture(fixture: LaneFixtureOptions) {
  const durableRows = new Map<string, PersistedSyncState>();
  if (fixture.seedDurable) {
    durableRows.set(SOURCE_KEY, fixture.seedDurable);
  }
  const persistCalls: PersistedSyncState[] = [];
  const persistKeys: string[] = [];
  const uploads: string[][] = [];
  const reads: Array<{ sinceTs: string; sinceId: string }> = [];
  const table: AgentComponentCursorRow[] = [...fixture.componentRows];
  let tick = 0;
  let getSourceCall = 0;

  const sortedTable = (): AgentComponentCursorRow[] =>
    [...table].sort((a, b) => {
      const at = a.last_seen_at ?? "";
      const bt = b.last_seen_at ?? "";
      if (at !== bt) {
        return at < bt ? -1 : 1;
      }
      return a.id < b.id ? -1 : 1;
    });

  const held: HeldPersist[] = [];
  let persistCall = 0;

  const recordPersist = (
    sourceKey: string,
    state: PersistedSyncState
  ): void => {
    persistCalls.push(state);
    persistKeys.push(sourceKey);
    durableRows.set(sourceKey, state);
  };

  const holdPersist = (
    sourceKey: string,
    state: PersistedSyncState
  ): Promise<void> => {
    let complete: () => void = () => undefined;
    let fail: () => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      complete = () => {
        recordPersist(sourceKey, state);
        resolve();
      };
      fail = () => reject(new Error("db-host exited (code: 0)"));
    });
    held.push({ promise, complete, fail });
    return promise;
  };

  const source = {
    loadSyncState: (sourceKey: string) =>
      Promise.resolve(durableRows.get(sourceKey) ?? null),
    advanceSyncState: (sourceKey: string, state: PersistedSyncState) => {
      const behavior =
        fixture.persistBehavior?.(persistCall) ?? PersistBehavior.Ok;
      persistCall += 1;
      if (behavior === PersistBehavior.Reject) {
        return Promise.reject(new Error("db-host exited (code: 0)"));
      }
      if (behavior === PersistBehavior.Hold) {
        return holdPersist(sourceKey, state);
      }
      recordPersist(sourceKey, state);
      return Promise.resolve();
    },
  } as unknown as AgentSessionSyncSource;

  const targetFor = (currentTick: number): string =>
    fixture.computeTargetId?.(currentTick) ?? COMPUTE_TARGET;

  const options: AgentComponentSyncLaneOptions = {
    getSource: () => {
      const call = getSourceCall;
      getSourceCall += 1;
      return fixture.sourceAvailable(tick, call) ? source : null;
    },
    getSyncComputeTargetId: () => targetFor(tick),
    isCloudSyncTierAllowed: () => true,
    listComponentCursorRows: (sinceTs: string, sinceId: string) => {
      reads.push({ sinceTs, sinceId });
      return Promise.resolve(
        sortedTable().filter((r) => {
          const t = r.last_seen_at ?? "";
          return t > sinceTs || (t === sinceTs && r.id > sinceId);
        })
      );
    },
    loadComponentRows: (ids: string[]) =>
      Promise.resolve(
        ids.map((id) =>
          syncedFor(id, table.find((r) => r.id === id)?.last_seen_at ?? null)
        )
      ),
    sendComponents: (payload) => {
      uploads.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(acceptedResult());
    },
  };
  const lane = new AgentComponentSyncLane(options, {
    getSourceStateGeneration: () => 1,
    isStarted: () => true,
  });
  return {
    lane,
    uploads,
    persistCalls,
    persistKeys,
    reads,
    durableCursor: (key = SOURCE_KEY): PersistedSyncState | null =>
      durableRows.get(key) ?? null,
    addRow(row: AgentComponentCursorRow): void {
      table.push(row);
    },
    async runTick(): Promise<void> {
      await lane.syncOnce();
      // The durable persist is fire-and-forget inside the advance, so awaiting
      // the run alone does not prove the write reported. `whenCursorPersistSettled`
      // is the lane's REAL completion signal for that half of the tick (wongk
      // review) — no microtask-turn guessing.
      await lane.whenCursorPersistSettled();
      tick += 1;
      getSourceCall = 0;
    },
    /**
     * Run the drain WITHOUT waiting on the durable write. Only for specs that
     * deliberately park a persist (`PersistBehavior.Hold`), where waiting would
     * block forever.
     */
    async runDrainOnly(): Promise<void> {
      await lane.syncOnce();
      tick += 1;
      getSourceCall = 0;
    },
    /**
     * Settle a parked durable write and wait for the lane's own handler on that
     * exact promise to have run. The lane registered its `.then` when it issued
     * the write, so chaining here resolves strictly after it — a real completion
     * signal rather than a guessed number of microtask turns.
     */
    async releaseHeldPersist(
      index: number,
      outcome: Exclude<PersistBehavior, "hold">
    ): Promise<void> {
      const entry = held[index];
      if (!entry) {
        throw new Error(`no held persist at index ${index}`);
      }
      if (outcome === PersistBehavior.Ok) {
        entry.complete();
      } else {
        entry.fail();
      }
      await entry.promise.then(
        () => undefined,
        () => undefined
      );
    },
  };
}

/** Component-lane log lines emitted since the last `gatewayLog.clear()`. */
function laneLogMessages(): string[] {
  return gatewayLog
    .getEntries()
    .filter((e) => e.tag === "agent-session-sync")
    .map((e) => e.message);
}

test("ISS-5347: a hydration during a db-host outage must not strand the durable cursor forever", async () => {
  gatewayLog.clear();
  // The install has already synced up to c-b and recorded it durably — the
  // 2026-08-03 position seen in production.
  const fixture = makeLaneFixture({
    componentRows: [
      { id: "c-a", last_seen_at: TS_A },
      { id: "c-b", last_seen_at: TS_B },
      { id: "c-c", last_seen_at: TS_C },
    ],
    seedDurable: {
      observedTopUpdatedAt: TS_B,
      observedIdsAtTopUpdatedAt: ["c-b"],
      deadLetteredIds: [],
    },
    // Tick 0 is the outage: the lane must hydrate (first run for this key) and
    // the db host is down. Every later tick has the source back.
    sourceAvailable: (tick) => tick !== 0,
  });

  for (let i = 0; i < 4; i++) {
    await fixture.runTick();
  }

  // THE REGRESSION. Before the fix, tick 0 hydrated to EPOCH and marked itself
  // hydrated, so the lane re-walked all three components in memory and never
  // re-read the durable cursor. With nothing left to advance, no persist was ever
  // attempted again and the durable row stayed pinned at TS_B — the three-day
  // freeze reported.
  const persisted = fixture.durableCursor();
  assert.ok(persisted, "the durable cursor row must still exist");
  assert.equal(
    persisted?.observedTopUpdatedAt,
    TS_C,
    `the durable cursor must reach the newest component (${TS_C}) once the db host returns; a value still at ${TS_B} means the outage stranded it permanently. Got ${persisted?.observedTopUpdatedAt}`
  );
  assert.deepEqual(
    persisted?.observedIdsAtTopUpdatedAt,
    ["c-c"],
    "the durable cursor must record the newest row's id alongside its timestamp"
  );
  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    false,
    "once a persist has landed the lane must no longer report a stale durable cursor"
  );
});

test("ISS-5347: an advance with no durable persist available names itself instead of being swallowed", async () => {
  gatewayLog.clear();
  const fixture = makeLaneFixture({
    componentRows: [{ id: "c-a", last_seen_at: TS_A }],
    // The source is NEVER available. The lane can still read and send
    // (production wires those independently of `getSource()`), so it advances in
    // memory with nothing durable behind it. That must be reported.
    sourceAvailable: () => false,
  });

  await fixture.runTick();

  assert.equal(
    fixture.uploads.flat().length,
    1,
    "sanity: the lane still uploaded, which is what makes the silent case dangerous"
  );
  assert.equal(
    fixture.persistCalls.length,
    0,
    "sanity: nothing durable was written"
  );
  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    true,
    "the lane must report that its in-memory keyset is ahead of the durable cursor"
  );
  const messages = laneLogMessages();
  assert.ok(
    messages.some((m) => m.includes("no durable persist available")),
    `expected the lane to name the absent durable persist, got: ${JSON.stringify(messages)}`
  );
});

test("ISS-5347: a REJECTED durable persist is named, and the lane resumes persisting when the write recovers", async () => {
  gatewayLog.clear();
  let failing = true;
  const fixture = makeLaneFixture({
    componentRows: [{ id: "c-a", last_seen_at: TS_A }],
    sourceAvailable: () => true,
    persistBehavior: () =>
      failing ? PersistBehavior.Reject : PersistBehavior.Ok,
  });

  await fixture.runTick();

  assert.equal(
    fixture.persistCalls.length,
    0,
    "sanity: the first persist rejected, so nothing was recorded"
  );
  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    true,
    "a rejected persist must leave the lane reporting a stale durable cursor"
  );
  const afterFailure = laneLogMessages();
  assert.ok(
    afterFailure.some((m) => m.includes("durable cursor persist failed")),
    `a rejected persist must be logged, got: ${JSON.stringify(afterFailure)}`
  );

  // RECOVERY WITH NO NEW ROW (wongk review). The write comes back but the
  // inventory is unchanged, so the cursor is drained and `applyCursorAdvance` is
  // never called again. Naming the failure was not enough on its own: nothing
  // re-attempted the unpersisted position, so the durable row stayed frozen at
  // the pre-failure value until some unrelated component happened to change —
  // the same freeze this ticket is about, reached through a rejected write
  // instead of an absent one. The lane must re-drive the held position itself.
  failing = false;
  const uploadsBeforeRecovery = fixture.uploads.flat().length;
  for (let i = 0; i < 3; i++) {
    await fixture.runTick();
  }

  assert.equal(
    fixture.persistCalls.length > 0,
    true,
    "the lane must resume persisting once the durable write recovers, with no new component to advance past"
  );
  assert.equal(
    fixture.durableCursor()?.observedTopUpdatedAt,
    TS_A,
    "the recovered persist must record the position that never reached disk"
  );
  assert.deepEqual(
    fixture.durableCursor()?.observedIdsAtTopUpdatedAt,
    ["c-a"],
    "the re-driven position carries the same keyset id the failed write held"
  );
  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    false,
    "a successful persist must clear the stale-cursor report"
  );
  assert.equal(
    fixture.uploads.flat().length,
    uploadsBeforeRecovery,
    "recovering the durable cursor must not re-upload components; only the position is re-written"
  );
});

test("ISS-5347: a restart resumes from the durable cursor instead of re-walking the inventory", async () => {
  gatewayLog.clear();
  const rows: AgentComponentCursorRow[] = [
    { id: "c-a", last_seen_at: TS_A },
    { id: "c-b", last_seen_at: TS_B },
  ];
  const first = makeLaneFixture({
    componentRows: rows,
    sourceAvailable: () => true,
  });

  for (let i = 0; i < 3; i++) {
    await first.runTick();
  }

  const persisted = first.durableCursor();
  assert.equal(
    persisted?.observedTopUpdatedAt,
    TS_B,
    "the durable cursor must record the last synced row so a restart resumes after it"
  );

  // A FRESH lane seeded with that durable row must upload nothing — the property
  // the frozen cursor destroyed in production, where every db-host restart
  // re-uploaded the entire 502-component inventory.
  const resumed = makeLaneFixture({
    componentRows: rows,
    sourceAvailable: () => true,
    seedDurable: persisted as PersistedSyncState,
  });
  for (let i = 0; i < 2; i++) {
    await resumed.runTick();
  }

  assert.equal(
    resumed.uploads.flat().length,
    0,
    `a restart at a current durable cursor must upload nothing; re-uploaded ${JSON.stringify(resumed.uploads)}`
  );
});

// ISS-5347 (wongk review): the WITHIN-TICK race is the actual reason
// `applyCursorAdvance` re-resolves the source instead of reusing the one captured
// at `run()` entry. Every other spec here holds the source steady for a whole
// tick, so reverting that re-resolution would not fail them. This one flips it
// mid-tick: null when the run starts (a db-host blip), live by the time the
// cursor advances. The durable write must land in that SAME tick — a lane that
// reuses the run-entry capture sees `buildComponentCursorPersist(null)` and
// writes nothing.
test("ISS-5347: a source that returns between run entry and the cursor advance still persists in that tick", async () => {
  gatewayLog.clear();
  const fixture = makeLaneFixture({
    componentRows: [{ id: "c-a", last_seen_at: TS_A }],
    // Call 0 is `run()`'s entry resolution; call 1 is `applyCursorAdvance`'s.
    sourceAvailable: (_tick, getSourceCall) => getSourceCall > 0,
  });

  await fixture.runTick();

  assert.equal(
    fixture.uploads.flat().length,
    1,
    "sanity: the null run-entry source does not stop the lane reading and sending"
  );
  assert.equal(
    fixture.persistCalls.length,
    1,
    "the advance must use the LIVE source, not the null run-entry capture, so the write happens in this same tick"
  );
  assert.equal(
    fixture.durableCursor()?.observedTopUpdatedAt,
    TS_A,
    "the durable cursor must record the position reached in this tick"
  );
  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    false,
    "a write that landed leaves nothing stale to report"
  );
});

// ISS-5347 (wongk review): `hydratedSourceKey` goes null whenever hydration could
// not consult the durable cursor, while `watermark`/`lastId` keep the position
// they were advanced to. Keying the foreign-position drop off `hydratedSourceKey`
// therefore missed the case where the target changes while that key is ALREADY
// null: the previous target's keyset survived into the new target's tick, so the
// lane read strictly after a foreign position (skipping the new target's earlier
// rows) and could persist it under the new source key.
test("ISS-5347: a target change with an unconsultable durable cursor must not reuse the prior target's keyset", async () => {
  gatewayLog.clear();
  const secondTarget = "target-durable-cursor-2";
  const secondKey = buildAgentComponentSyncSourceKey(secondTarget);
  const fixture = makeLaneFixture({
    componentRows: [
      { id: "c-a", last_seen_at: TS_A },
      { id: "c-b", last_seen_at: TS_B },
    ],
    // The source is down for the WHOLE lifetime, so hydration never succeeds and
    // `hydratedSourceKey` is null on every tick — the state in which the old
    // guard skipped its own drop.
    sourceAvailable: () => false,
    // Tick 0 syncs under the first target; tick 1 switches accounts.
    computeTargetId: (tick) => (tick === 0 ? COMPUTE_TARGET : secondTarget),
  });

  await fixture.runTick();
  assert.deepEqual(
    fixture.reads.at(-1),
    { sinceTs: "", sinceId: "" },
    "sanity: the first target walked from epoch"
  );
  assert.equal(
    fixture.uploads.flat().length,
    2,
    "sanity: the first target uploaded both rows and advanced its in-memory keyset"
  );

  await fixture.runTick();

  assert.deepEqual(
    fixture.reads.at(-1),
    { sinceTs: "", sinceId: "" },
    `the new target must start from epoch, not from the previous target's keyset; reading after ${TS_B} would silently skip every component older than it`
  );
  assert.deepEqual(
    fixture.uploads.at(-1),
    ["c-a", "c-b"],
    "the new target must receive the rows the prior target's position would have skipped"
  );
  assert.equal(
    fixture.persistKeys.includes(secondKey),
    false,
    "nothing may be persisted under the new source key while the durable cursor is unreachable"
  );
});

// ISS-5347 (wongk review): the durable write is fire-and-forget, so its outcome
// can land arbitrarily late — including after `clearCursorState()` re-scoped the
// lane to a different account. An OLD failure landing then would dirty the NEW
// identity's flag, and `hasStaleDurableCursor` would stop describing the durable
// position at all.
test("ISS-5347: a persist that rejects after clearCursorState must not dirty the new identity", async () => {
  gatewayLog.clear();
  const fixture = makeLaneFixture({
    componentRows: [{ id: "c-a", last_seen_at: TS_A }],
    sourceAvailable: () => true,
    persistBehavior: () => PersistBehavior.Hold,
  });

  await fixture.runDrainOnly();

  // The identity changes while that write is still in flight.
  fixture.lane.clearCursorState();
  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    false,
    "sanity: clearing the cursor state clears the staleness report with it"
  );

  await fixture.releaseHeldPersist(0, PersistBehavior.Reject);

  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    false,
    "a superseded attempt's failure must not report the CLEARED cursor as stale — that flag now describes a different identity"
  );
});

// ISS-5347 (wongk review): the mirror case. An OLD success settling after a NEWER
// persist already failed would clear a staleness report that is still true, which
// is precisely the silent divergence this ticket exists to make observable.
test("ISS-5347: a persist that succeeds after a newer one failed must not clear the newer failure", async () => {
  gatewayLog.clear();
  const fixture = makeLaneFixture({
    componentRows: [{ id: "c-a", last_seen_at: TS_A }],
    sourceAvailable: () => true,
    persistBehavior: (call) =>
      call === 0 ? PersistBehavior.Hold : PersistBehavior.Reject,
  });

  // Advance 1: parked write.
  await fixture.runDrainOnly();
  // Advance 2: a newly-discovered component whose write rejects outright.
  fixture.addRow({ id: "c-c", last_seen_at: TS_C });
  await fixture.runTick();

  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    true,
    "sanity: the newer write rejected, so the lane is ahead of disk"
  );

  await fixture.releaseHeldPersist(0, PersistBehavior.Ok);

  assert.equal(
    fixture.lane.hasStaleDurableCursor,
    true,
    `the superseded attempt's success only proves ${TS_A} landed; the lane is at ${TS_C} and is still ahead of disk`
  );
  assert.equal(
    fixture.durableCursor()?.observedTopUpdatedAt,
    TS_A,
    "sanity: only the superseded (older) position ever reached disk"
  );
});
