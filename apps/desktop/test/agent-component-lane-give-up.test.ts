/**
 * @file agent-component-lane-give-up.test.ts
 * @description ISS-9418 and PLN-2028 (ISS-10053, ISS-9963): what the component
 * lane RECORDS about its environmental run, over the real
 * `createTransitionLogger` and the real `LaneEnvironmentalDeferGate`.
 *
 * TWO CONTRACTS LIVE HERE, and they are different kinds of claim.
 *
 * The DIAGNOSTIC cases assert on log lines, which is unusual and deliberate: the
 * logging behaviour IS the contract. A transition logger logs only a CHANGED
 * outcome, so a durable-write failure names itself once instead of once per tick
 * — and the cost of that is that nothing tells it when the failure ENDED. Without
 * a reset on the successful write, a second, genuinely new persist failure
 * carries the same outcome string as the first and is swallowed for the life of
 * the process: the operator sees one line for two incidents.
 *
 * The RESTART cases are ISS-10053's acceptance. They assert something only a
 * resumed run ORIGIN can produce, because early in a run the pacing ladder
 * produces the same quiet tick a give-up does — so "the lane went quiet" would
 * pass against a lane that resumed nothing. Each one is paired with the same
 * scenario minus the origin, which must NOT give up.
 */
import {
  LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentLaneGiveUp } from "../src/main/agent-sync/agent-component-lane-give-up.js";
import type { AgentComponentSyncLaneOptions } from "../src/main/agent-sync/agent-component-sync-lane-contract.js";
import { AgentComponentSyncLane } from "../src/main/agent-sync/agent-session-sync-component-lane.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { PersistedLaneRun } from "../src/main/agent-sync/sync-cursor-state-source.js";
import { createTransitionLogger } from "../src/main/diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { LaneEnvironmentalDeferGate } from "../src/main/sync/lane-environmental-defer.js";
import type { PersistedLaneRunRead } from "../src/main/sync/lane-run-policy.js";
import { reportSyncLaneGaveUp } from "../src/main/telemetry/sync-lane-give-up-telemetry.js";
import {
  laneFailureResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

// Mocked to make the PAYLOAD directly assertable, which is the ISS-9963 claim: a
// resumed give-up reports the cause and duration it read off the row. The
// module-level latch is NOT the reason — it is clearable by name, and
// `sync-lane-give-up-telemetry.test.ts` does exactly that per case. So what these
// cases pin is what this class BUILDS; that the event is emitted once per
// transition and reaches the wire as `syncLaneGaveUp` is that suite's.
vi.mock("../src/main/telemetry/sync-lane-give-up-telemetry.js", () => ({
  reportSyncLaneGaveUp: vi.fn(),
  reportSyncLaneReArmed: vi.fn(),
  clearSyncLaneGiveUpAnnouncement: vi.fn(),
}));

const KEY = "agent_components:target-a";
const HOUR_MS = 3_600_000;
// A resumed give-up is only HELD while it is inside its re-arm window, whose
// first rung is five minutes. A stamp older than that has already re-armed, so
// these cases seed a RECENT give-up on an OLD run: the outage is long, the
// decision to stop is fresh. That is also the real shape — a process relaunches
// shortly after the one that gave up.
const MINUTE_MS = 60_000;
const FIRST_MS = Date.parse("2026-08-03T12:00:00.000Z");
const SECOND_MS = Date.parse("2026-08-05T12:00:00.000Z");

/**
 * Drain the write chain COMPLETELY. One hop to the macrotask queue, because the
 * microtask queue is fully drained before it — including the microtasks each
 * link enqueues, which is what a counted flush cannot know the length of. A
 * fixed count reads a pending re-attempt (PLN-2028 D5), or a write still queued
 * behind others, as a write that never happened.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The store OMITS a NULL column, so a fake that reads back must omit it too. */
function laneRunRow(run: PersistedLaneRun): PersistedLaneRunRead {
  return {
    ...(run.laneStalledSince === null
      ? {}
      : { laneStalledSince: run.laneStalledSince }),
    ...(run.laneGaveUpAt === null ? {} : { laneGaveUpAt: run.laneGaveUpAt }),
    ...(run.laneGaveUpReason === null
      ? {}
      : { laneGaveUpReason: run.laneGaveUpReason }),
    ...(run.laneGaveUpSource === null
      ? {}
      : { laneGaveUpSource: run.laneGaveUpSource }),
  };
}

/**
 * One durable lane-run row that outlives a process, as `sync_state` does. The
 * row is what the next launch READS, which is the whole subject here — a fake
 * that only logged the writes could not tell a resumed run from a fresh one.
 */
function makeDurableRun() {
  let row: PersistedLaneRunRead = {};
  const runWrites: PersistedLaneRun[] = [];
  const source = {
    recordLaneRun: (_key: string, run: PersistedLaneRun) => {
      runWrites.push(run);
      row = laneRunRow(run);
    },
  } as unknown as AgentSessionSyncSource;
  return {
    source,
    runWrites,
    row: () => row,
    seed: (seeded: PersistedLaneRunRead) => {
      row = seeded;
    },
  };
}

function makeLane(source: AgentSessionSyncSource) {
  const gate = new LaneEnvironmentalDeferGate();
  const giveUp = new ComponentLaneGiveUp({
    gate,
    getSource: () => source,
    diag: createTransitionLogger("test-give-up"),
  });
  return { gate, giveUp };
}

/**
 * The REAL lane over one durable row and a transport that only ever fails
 * LANE-WIDE, so a tick is exactly: hydrate the row, read, send, take the
 * environmental failure, reconcile. Nothing here reaches past what this lane
 * itself owns — the point is the seam that hands it the row.
 */
function makeProductionLane(seeded: PersistedLaneRunRead) {
  const runWrites: PersistedLaneRun[] = [];
  const lastSeenAt = new Date(FIRST_MS - 30 * MINUTE_MS).toISOString();
  const source = {
    loadSyncState: () =>
      Promise.resolve({
        observedTopUpdatedAt: null,
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds: [],
        ...seeded,
      }),
    recordLaneRun: (_key: string, run: PersistedLaneRun) => {
      runWrites.push(run);
    },
  } as unknown as AgentSessionSyncSource;
  const options: AgentComponentSyncLaneOptions = {
    getSource: () => source,
    getSyncComputeTargetId: () => "target-a",
    listComponentCursorRows: (sinceTs: string) =>
      Promise.resolve(
        sinceTs === "" ? [{ id: "c-a", last_seen_at: lastSeenAt }] : []
      ),
    loadComponentRows: (ids: string[]) =>
      Promise.resolve(ids.map((id) => syncedFor(id, lastSeenAt))),
    sendComponents: () => Promise.resolve(laneFailureResult()),
  };
  const lane = new AgentComponentSyncLane(options, {
    getSourceStateGeneration: () => 1,
    isStarted: () => true,
  });
  return { runWrites, syncOnce: () => lane.syncOnce() };
}

/**
 * One PROCESS: adopt whatever the row holds, charge an environmental failure at
 * each instant, reconcile, then exit. `adoptOrigin: false` is the counterfactual
 * — the same launch with only the give-up instant resumed, which is what this
 * lane did before ISS-10053.
 */
async function runProcess(
  durable: ReturnType<typeof makeDurableRun>,
  startedAtMs: number,
  failureAtMs: number[],
  options: { adoptOrigin?: boolean } = {}
) {
  const lane = makeLane(durable.source);
  const row = durable.row();
  lane.giveUp.adoptPersisted(
    KEY,
    options.adoptOrigin === false
      ? { ...row, laneStalledSince: undefined }
      : row,
    startedAtMs
  );
  for (const at of failureAtMs) {
    lane.giveUp.noteEnvironmentalOutcome(
      lane.gate.noteEnvironmentalFailure(at),
      SyncReason.IngestionFailed
    );
    lane.giveUp.reconcile(KEY);
  }
  await settle();
  return lane;
}

/**
 * A 28-hour outage lived through four 7-hour processes. No single process is up
 * for the 24h ceiling, which is exactly the install an in-memory clock can never
 * terminate.
 */
async function fourRelaunchesAcrossA28HourOutage(options: {
  adoptOrigin?: boolean;
}) {
  const durable = makeDurableRun();
  let lane = await runProcess(durable, FIRST_MS, [FIRST_MS], options);
  for (let relaunch = 1; relaunch <= 3; relaunch += 1) {
    const startedAt = FIRST_MS + relaunch * 7 * HOUR_MS;
    lane = await runProcess(
      durable,
      startedAt,
      [startedAt, startedAt + 7 * HOUR_MS],
      options
    );
  }
  return { durable, lane };
}

describe("ISS-10053: the ceiling survives a desktop that keeps restarting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives up in the FOURTH process of a 28h outage no process saw 24h of", async () => {
    const { lane } = await fourRelaunchesAcrossA28HourOutage({});

    expect(lane.gate.isGivenUp(FIRST_MS + 28 * HOUR_MS)).toBe(true);
  });

  it("...and does NOT give up when the run origin is not resumed", async () => {
    // The discriminator. Identical outage, identical relaunches, identical
    // failures — the ONLY difference is that each process resumes the give-up
    // instant without the origin, so every launch opens a fresh 24h run and the
    // fourth is only 7 hours into its own. This is the behaviour before
    // ISS-10053, and without this case the assertion above would pass against a
    // lane that gave up for some entirely unrelated reason.
    const { lane } = await fourRelaunchesAcrossA28HourOutage({
      adoptOrigin: false,
    });

    expect(lane.gate.isGivenUp(FIRST_MS + 28 * HOUR_MS)).toBe(false);
  });

  it("carries the run origin onto the row, so the next launch can resume it", async () => {
    const { durable } = await fourRelaunchesAcrossA28HourOutage({});

    expect(durable.row().laneStalledSince).toBe(
      new Date(FIRST_MS).toISOString()
    );
    // And the give-up it eventually reached is on the row beside it, attributed
    // to the producer that wrote it (ISS-10043).
    expect(durable.row().laneGaveUpSource).toBe(
      LaneGiveUpSource.EnvironmentalGate
    );
    expect(durable.row().laneGaveUpReason).toBe(SyncReason.IngestionFailed);
  });

  it("clears all four columns in ONE write when the lane answers", async () => {
    const { durable, lane } = await fourRelaunchesAcrossA28HourOutage({});
    const writesBeforeAnswer = durable.runWrites.length;

    lane.gate.noteLaneAnswered();
    lane.giveUp.reconcile(KEY);
    await settle();

    expect(durable.runWrites).toHaveLength(writesBeforeAnswer + 1);
    expect(durable.runWrites.at(-1)).toEqual({
      laneStalledSince: null,
      laneGaveUpAt: null,
      laneGaveUpReason: null,
      laneGaveUpSource: null,
    });
    // The row a relaunch would read is genuinely empty, not merely "not given
    // up": a surviving origin would hand the next launch a run that had already
    // been answered.
    expect(durable.row()).toEqual({});
  });
});

describe("ISS-9963: a resumed give-up reports its real cause and duration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("announces the reason and the duration it read off the row", async () => {
    // Before this, a process that relaunched inside an outage held a give-up it
    // never saw happen: it announced no cause at all, and no duration, on the
    // only channel a give-up is ever observed on.
    const durable = makeDurableRun();
    durable.seed({
      laneStalledSince: new Date(FIRST_MS - 28 * HOUR_MS).toISOString(),
      laneGaveUpAt: new Date(FIRST_MS - MINUTE_MS).toISOString(),
      laneGaveUpReason: SyncReason.IngestionFailed,
      laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
    });
    const lane = makeLane(durable.source);

    lane.giveUp.adoptPersisted(KEY, durable.row(), FIRST_MS);
    expect(lane.giveUp.holdTick(FIRST_MS)).toBe(true);
    await settle();

    expect(reportSyncLaneGaveUp).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: SyncLane.ComponentInventory,
        reason: SyncReason.IngestionFailed,
        stalledForMs: 28 * HOUR_MS,
      })
    );
  });

  it("reports the duration as UNMEASURED when the row carries no origin", async () => {
    // A row written before migration 0091. The give-up still resumes and is
    // still announced — it simply cannot say how long, and `null` is what says
    // so. A fabricated `0` would render as a lane that gave up instantly.
    const durable = makeDurableRun();
    durable.seed({
      laneGaveUpAt: new Date(FIRST_MS - MINUTE_MS).toISOString(),
    });
    const lane = makeLane(durable.source);

    lane.giveUp.adoptPersisted(KEY, durable.row(), FIRST_MS);
    expect(lane.giveUp.holdTick(FIRST_MS)).toBe(true);
    await settle();

    expect(reportSyncLaneGaveUp).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null, stalledForMs: null })
    );
  });
});

describe("ISS-10043: only a LANE-wide give-up becomes a lane hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to resume a ROW-CEILING give-up, and holds no tick for it", async () => {
    // The bounce. A row-ceiling stamp says individual rows exhausted their own
    // budgets; holding the whole lane for it stops a lane that was never
    // lane-wide broken, and it stays stopped across every later relaunch. This
    // lane writes no such give-up at all (`produces: false`), so the value can
    // only be a corrupt or foreign row.
    const durable = makeDurableRun();
    durable.seed({
      laneStalledSince: new Date(FIRST_MS - 28 * HOUR_MS).toISOString(),
      laneGaveUpAt: new Date(FIRST_MS - MINUTE_MS).toISOString(),
      laneGaveUpReason: SyncReason.IngestionFailed,
      laneGaveUpSource: LaneGiveUpSource.RowCeiling,
    });
    const lane = makeLane(durable.source);

    lane.giveUp.adoptPersisted(KEY, durable.row(), FIRST_MS);
    await settle();

    expect(lane.gate.giveUpStampMs()).toBe(null);
    expect(lane.giveUp.holdTick(FIRST_MS)).toBe(false);
    expect(reportSyncLaneGaveUp).not.toHaveBeenCalled();
  });

  it("...while the SAME row attributed to the GATE is resumed and held", async () => {
    // The discriminator: identical instants, identical cause, only the producer
    // column differs. Without it the case above would pass against a lane that
    // resumed nothing at all, for some entirely unrelated reason.
    const durable = makeDurableRun();
    durable.seed({
      laneStalledSince: new Date(FIRST_MS - 28 * HOUR_MS).toISOString(),
      laneGaveUpAt: new Date(FIRST_MS - MINUTE_MS).toISOString(),
      laneGaveUpReason: SyncReason.IngestionFailed,
      laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
    });
    const lane = makeLane(durable.source);

    lane.giveUp.adoptPersisted(KEY, durable.row(), FIRST_MS);
    await settle();

    expect(lane.gate.giveUpStampMs()).toBe(FIRST_MS - MINUTE_MS);
    expect(lane.giveUp.holdTick(FIRST_MS)).toBe(true);
  });
});

describe("PLN-2028 D4: a re-hydration cannot blank a give-up this process holds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the cause when the row lost the give-up to a write that never landed", async () => {
    // The gate refuses a record while it is holding a run of its own, and what
    // the LANE holds beside the gate owes the same refusal. Reachable without a
    // restart: the durable write fails while the db host is down, the same outage
    // takes `hydratedSourceKey` with it, and the next re-armed tick re-enters
    // hydration against a row that has no give-up on it. Taking the row's answer
    // there writes a null cause beside a give-up the lane is still holding — the
    // ISS-9963 silence, through the hydration door.
    const durable = makeDurableRun();
    const lane = makeLane(durable.source);
    const gaveUpAtMs = FIRST_MS + 25 * HOUR_MS;

    lane.giveUp.adoptPersisted(KEY, durable.row(), FIRST_MS);
    for (const at of [FIRST_MS, gaveUpAtMs]) {
      lane.giveUp.noteEnvironmentalOutcome(
        lane.gate.noteEnvironmentalFailure(at),
        SyncReason.IngestionFailed
      );
    }
    // No reconcile in between, so the give-up never reached the columns — which
    // is exactly the row the re-hydration below then reads.
    expect(durable.row()).toEqual({});

    lane.giveUp.adoptPersisted(KEY, durable.row(), gaveUpAtMs);
    lane.giveUp.reconcile(KEY);
    await settle();

    expect(durable.row().laneGaveUpAt).toBe(new Date(gaveUpAtMs).toISOString());
    expect(durable.row().laneGaveUpReason).toBe(SyncReason.IngestionFailed);
  });
});

describe("ISS-10053: the run is resumed by the PRODUCTION lane, not only by the helper", () => {
  // The cases above drive `ComponentLaneGiveUp` directly, so deleting the
  // adoption from `AgentComponentSyncLane.hydrateCursorFor` — the one seam that
  // hands this lane its durable row — leaves every one of them green (whitlockk
  // review). These run the same outage through the real lane.
  beforeEach(() => {
    vi.clearAllMocks();
    // Only the CLOCK: the lane reads `Date.now()` at every seam, and faking the
    // timers too would park the awaits this drives it with.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIRST_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on the FIRST lane failure after resuming an origin already past the ceiling", async () => {
    const lane = makeProductionLane({
      laneStalledSince: new Date(FIRST_MS - 25 * HOUR_MS).toISOString(),
    });

    await lane.syncOnce();
    await settle();

    expect(lane.runWrites.at(-1)).toEqual({
      laneStalledSince: new Date(FIRST_MS - 25 * HOUR_MS).toISOString(),
      laneGaveUpAt: new Date(FIRST_MS).toISOString(),
      laneGaveUpReason: SyncReason.TransportError,
      laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
    });
  });

  it("...and does NOT when the row carries no origin to resume", async () => {
    // The discriminator. Identical row, identical failure — the only difference
    // is that nothing on disk says when the run opened, so this tick opens a
    // fresh one and is seconds rather than 25 hours into it.
    const lane = makeProductionLane({});

    await lane.syncOnce();
    await settle();

    expect(lane.runWrites.at(-1)?.laneGaveUpAt).toBe(null);
  });
});

describe("ComponentLaneGiveUp persist diagnostic", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a SECOND persist failure that a later success separated from the first", async () => {
    const warn = vi
      .spyOn(gatewayLog, "warn")
      .mockImplementation(() => undefined);
    let refuseWrite = true;
    const source = {
      recordLaneRun: () =>
        refuseWrite
          ? Promise.reject(new Error("db-host exited (code: 0)"))
          : Promise.resolve(),
    } as unknown as AgentSessionSyncSource;
    const { gate, giveUp } = makeLane(source);

    gate.hydrateGiveUp(FIRST_MS, FIRST_MS);
    giveUp.reconcile(KEY);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);

    // The db host comes back and the next state change lands. Nothing is logged
    // for a write that worked — the point is only that the failure is over.
    refuseWrite = false;
    gate.noteLaneAnswered();
    giveUp.reconcile(KEY);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);

    // A NEW incident, a day later. Same outcome string as the first one, so a
    // logger nothing had reset would suppress it and this stays at 1.
    refuseWrite = true;
    gate.hydrateGiveUp(SECOND_MS, SECOND_MS);
    giveUp.reconcile(KEY);
    await settle();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("still says a STUCK failure only once, however many ticks it spans", async () => {
    // The reset must not cost the anti-spam property it was added around: a
    // failure that never ends is one line, not one per reconcile.
    const warn = vi
      .spyOn(gatewayLog, "warn")
      .mockImplementation(() => undefined);
    const source = {
      recordLaneRun: () => Promise.reject(new Error("db-host exited")),
    } as unknown as AgentSessionSyncSource;
    const { gate, giveUp } = makeLane(source);

    gate.hydrateGiveUp(FIRST_MS, FIRST_MS);
    for (const at of [FIRST_MS, SECOND_MS, SECOND_MS + 1]) {
      gate.hydrateGiveUp(at, at);
      giveUp.reconcile(KEY);
      await settle();
    }

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("REPAIRS a row whose stamp is ahead of the clock, and names it", async () => {
    const warn = vi
      .spyOn(gatewayLog, "warn")
      .mockImplementation(() => undefined);
    const durable = makeDurableRun();
    const { gate, giveUp } = makeLane(durable.source);

    // 90 days ahead: a corrupt row, or the clock moved back after the give-up
    // was written. Adopted verbatim the lane is terminal behind a window that
    // cannot elapse, so the read normalizes the anchor AND the row is rewritten
    // rather than left to hand the next launch the same trap.
    const skewedAt = new Date(FIRST_MS + 90 * 86_400_000).toISOString();
    giveUp.adoptPersisted(KEY, { laneGaveUpAt: skewedAt }, FIRST_MS);
    await settle();

    expect(gate.giveUpStampMs()).toBe(FIRST_MS);
    expect(durable.runWrites.at(-1)?.laneGaveUpAt).toBe(
      new Date(FIRST_MS).toISOString()
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("writes NOTHING back for a run that is already a real instant", async () => {
    // The repair must not cost the equality gate it sits next to: a healthy
    // hydration pays no SQLite write, which is the whole reason `adopt` exists.
    const durable = makeDurableRun();
    const { gate, giveUp } = makeLane(durable.source);

    giveUp.adoptPersisted(
      KEY,
      { laneGaveUpAt: new Date(FIRST_MS).toISOString() },
      SECOND_MS
    );
    await settle();

    expect(gate.giveUpStampMs()).toBe(FIRST_MS);
    expect(durable.runWrites).toEqual([]);
  });
});
