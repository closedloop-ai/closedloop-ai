/**
 * @file sync-lane-give-up-telemetry.test.ts
 * @description ISS-9418 section 6: "give-up and re-arm each emit once".
 *
 * The cadence is the whole contract here, and it is the half that a naive
 * implementation gets wrong in the most expensive direction. A given-up lane is
 * asked whether it may attempt on every 5s tick, and the gate's answers are
 * PURE READS that do not clear the stamp - so an emit driven straight off
 * `isGivenUp` or `reArmTrigger` would report one give-up thousands of times, and
 * a rate monitor built on it would count ticks rather than give-ups.
 *
 * Every case therefore drives the REAL `LaneEnvironmentalDeferGate` through the
 * real `ComponentLaneGiveUp` seam (or the real `applyLaneStallFold`) and counts
 * events at the emitter, rather than calling the reporters directly - the
 * reporters are trivially once-per-call; what is worth pinning is that the
 * production tick path calls them once per TRANSITION.
 *
 * The clock is pinned throughout. A wall-clock give-up is exactly where a
 * real-clock assertion would be worthless: the ceiling arithmetic needs
 * hand-written instants to compare against.
 */

import {
  LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentLaneGiveUp } from "../src/main/agent-sync/agent-component-lane-give-up.js";
import type { AgentComponentSyncLaneOptions } from "../src/main/agent-sync/agent-component-sync-lane-contract.js";
import { createOutboxWriters } from "../src/main/agent-sync/agent-session-outbox-writers.js";
import { SESSION_LANE_STALL_CEILING_MS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { AgentComponentSyncLane } from "../src/main/agent-sync/agent-session-sync-component-lane.js";
import {
  applyLaneStallFold,
  type LaneStallFoldDeps,
  SessionEnvironmentalDeferClass,
} from "../src/main/agent-sync/agent-session-sync-lane-stall-fold.js";
import { createTransitionLogger } from "../src/main/diagnostics/component-sync-diagnostics.js";
import { LaneEnvironmentalDeferGate } from "../src/main/sync/lane-environmental-defer.js";
import { clearSyncLaneGiveUpAnnouncement } from "../src/main/telemetry/sync-lane-give-up-telemetry.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { laneReArmDelayMs } from "../src/shared/lane-give-up.js";
import {
  DEFAULT_LANE_STALL_SCHEDULE,
  laneStallRetryMs,
} from "../src/shared/lane-stall-clock.js";
import {
  laneFailureResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";
import {
  type GiveUpTelemetryCapture,
  installGiveUpTelemetryCapture,
  resetGiveUpTelemetryCapture,
} from "./sync-lane-give-up-telemetry-fixtures.js";

const GAVE_UP = "sync.lane.gave_up";
const REARMED = "sync.lane.rearmed";
const ORIGIN_MS = Date.parse("2026-08-20T00:00:00.000Z");
const PAST_CEILING_MS = ORIGIN_MS + DEFAULT_LANE_STALL_SCHEDULE.ceilingMs + 1;
/**
 * When the PACING gate lets the lane attempt again after the give-up above.
 *
 * The two gates are not the same length and that is the point of the cases
 * below: at the ceiling the run is >=24h old, so the ladder is at its per-delay
 * cap while the first re-arm window is the 5min floor. Derived from the
 * production helper rather than written as a literal, so a schedule change moves
 * the test with it instead of pinning a stale number.
 */
const PACED_UNTIL_MS =
  PAST_CEILING_MS + laneStallRetryMs(DEFAULT_LANE_STALL_SCHEDULE.ceilingMs + 1);
const SOURCE_KEY = "agent_components:target-a";

let capture: GiveUpTelemetryCapture;

function categoriesOf(category: string): EnrichedTelemetryEvent[] {
  return capture.categoriesOf(category);
}

/** Open or shut the telemetry lane's own send gate for the rest of this case. */
function setDeliverable(deliverable: boolean): void {
  capture.setDeliverable(deliverable);
}

/**
 * A component lane whose give-up seam is real and whose durable write is a
 * no-op: the column is `lane-run-record.test.ts`'s subject, and a persist
 * here would only add a microtask to await.
 */
function makeComponentGiveUp(): {
  gate: LaneEnvironmentalDeferGate;
  giveUp: ComponentLaneGiveUp;
} {
  const gate = new LaneEnvironmentalDeferGate();
  const giveUp = new ComponentLaneGiveUp({
    gate,
    getSource: () => null,
    diag: createTransitionLogger("test-give-up"),
  });
  return { gate, giveUp };
}

/** Charge one environmental failure at `nowMs` and announce what it caused. */
function failAt(
  gate: LaneEnvironmentalDeferGate,
  giveUp: ComponentLaneGiveUp,
  nowMs: number,
  reason: SyncReason = SyncReason.TransportError
): void {
  giveUp.noteEnvironmentalOutcome(gate.noteEnvironmentalFailure(nowMs), reason);
}

function makeFoldDeps(
  stalledSinceMsById: Map<string, number>,
  queued: { incremental: number; backfill: number } = {
    incremental: 0,
    backfill: 0,
  },
  // The service wires this straight to `SessionLaneRun.noteRowCeilingGiveUp`,
  // which is where the lane's identity is resolved - so a case about identity has
  // to supply the real collaborator rather than this default no-op.
  noteLaneGiveUp: (gaveUpAtMs: number, reason: SyncReason) => void = () =>
    undefined
): LaneStallFoldDeps {
  return {
    nextRetryAfterMs: new Map<string, number>(),
    // Drops the row's stall clock along with every other per-class budget,
    // exactly as the service's own implementation does. A no-op stub here is a
    // FALSE GREEN for the give-up's age: the fold's read would still find the
    // entry afterwards, so a producer that measured it after the fold instead of
    // before would report the right number in the test and a fabricated `0` in
    // production.
    clearFailureStateForId: (id) => {
      stalledSinceMsById.delete(id);
    },
    markDeadLettered: () => undefined,
    dequeue: () => undefined,
    // Resolves without a timer: this suite runs on a fake clock, and a
    // `setTimeout` here would never fire.
    recordOutboxStall: () => Promise.resolve(true),
    noteLaneGiveUp,
    queueSizes: () => ({ ...queued, deadLettered: 0 }),
    logWarn: () => undefined,
    logInfo: () => undefined,
    formatBytes: (bytes) => `${bytes}B`,
  };
}

beforeEach(() => {
  // The announcement latch is module-level and bounded by the closed lane set,
  // so it outlives a single case. Reset it BY NAME rather than relying on module
  // isolation: a case that passed only because a sibling had already announced
  // the same lane is the exact false green this file exists to prevent.
  clearSyncLaneGiveUpAnnouncement(SyncLane.ComponentInventory);
  clearSyncLaneGiveUpAnnouncement(SyncLane.SessionMetadata);
  capture = installGiveUpTelemetryCapture();
});

afterEach(() => {
  // Unconditional, not the last line of a case: an assertion that throws
  // mid-case would otherwise leak a frozen clock, a live emitter and an
  // installed readiness predicate into every later test in this worker.
  resetGiveUpTelemetryCapture();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("component lane give-up cadence", () => {
  it("gives up ONCE, however many ticks ask whether it may attempt", () => {
    const { gate, giveUp } = makeComponentGiveUp();

    failAt(gate, giveUp, ORIGIN_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(0);

    failAt(gate, giveUp, PAST_CEILING_MS, SyncReason.Unauthenticated);
    // Every later tick re-reads a pure `isGivenUp`, which keeps answering yes.
    for (let tick = 1; tick <= 20; tick += 1) {
      expect(giveUp.holdTick(PAST_CEILING_MS + tick * 5000)).toBe(true);
    }

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]?.severity).toBe("error");
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.ComponentInventory,
      reason: SyncReason.Unauthenticated,
      // PLN-2028 (ISS-10043): this lane has exactly one producer, and naming it
      // is what lets a monitor group the session lane's two apart.
      source: LaneGiveUpSource.EnvironmentalGate,
      stalledForMs: DEFAULT_LANE_STALL_SCHEDULE.ceilingMs + 1,
    });
  });

  it("omits itemsOwed for a lane that keeps no queue, and says so", () => {
    const { gate, giveUp } = makeComponentGiveUp();

    failAt(gate, giveUp, ORIGIN_MS);
    failAt(gate, giveUp, PAST_CEILING_MS);

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp?.itemsOwed).toBeUndefined();
    expect(gaveUp[0]?.message).toContain("keeps no item queue");
    // For THIS lane the give-up is the terminal path itself, so the terminal
    // wording is the true one - the session lane's case below pins the other
    // half, and the two must not both read the same.
    expect(gaveUp[0]?.message).toContain("has stopped attempting");
  });

  it("re-arms ONCE and names the WINDOW door", () => {
    const { gate, giveUp } = makeComponentGiveUp();
    failAt(gate, giveUp, ORIGIN_MS);
    failAt(gate, giveUp, PAST_CEILING_MS);

    // Both gates have opened, so every one of these ticks reaches the send -
    // which is where the announcement lives, and it is once per transition.
    for (let tick = 0; tick < 5; tick += 1) {
      const atMs = PACED_UNTIL_MS + tick * 5000;
      expect(giveUp.holdTick(atMs)).toBe(false);
      giveUp.noteSendAttempt(atMs);
    }

    const reArmed = categoriesOf(REARMED);
    expect(reArmed).toHaveLength(1);
    expect(reArmed[0]?.severity).toBe("info");
    expect(reArmed[0]?.diagnostics?.syncLaneReArmed).toEqual({
      lane: SyncLane.ComponentInventory,
      trigger: "window",
      // The duration the lane was ACTUALLY held, which is the pacing gate's and
      // not the re-arm window's - the two differ by ~55min here.
      gaveUpForMs: PACED_UNTIL_MS - PAST_CEILING_MS,
    });
    expect(reArmed[0]?.message).toContain("retry window ELAPSED");
  });

  it("names the EVENT door when a blocked precondition changed", () => {
    const { gate, giveUp } = makeComponentGiveUp();
    failAt(gate, giveUp, ORIGIN_MS);
    failAt(gate, giveUp, PAST_CEILING_MS);

    // Well inside the widening window - it opens at the 5min floor and this is a
    // second past the give-up - so the event arm is the only one that can open
    // the door here, which is the arm's whole purpose: a precondition changed, so
    // the lane does not wait out a timer that was measuring the old world.
    const insideWindowMs = PAST_CEILING_MS + 1000;
    expect(insideWindowMs).toBeLessThan(
      PAST_CEILING_MS + laneReArmDelayMs(1, DEFAULT_LANE_STALL_SCHEDULE)
    );
    expect(gate.noteRecoverySignal()).toBe(true);
    // The event door zeroes the pacing deadline along with the terminal state,
    // so this tick is one the lane really does send in.
    expect(giveUp.holdTick(insideWindowMs)).toBe(false);
    giveUp.noteSendAttempt(insideWindowMs);

    const reArmed = categoriesOf(REARMED);
    expect(reArmed).toHaveLength(1);
    expect(reArmed[0]?.diagnostics?.syncLaneReArmed?.trigger).toBe("event");
    expect(reArmed[0]?.message).toContain("precondition it was blocked on");
  });

  it("treats a re-armed attempt that fails again as a NEW give-up", () => {
    const { gate, giveUp } = makeComponentGiveUp();
    failAt(gate, giveUp, ORIGIN_MS);
    failAt(gate, giveUp, PAST_CEILING_MS);
    gate.noteRecoverySignal();
    // The event door clears both gates at once - it zeroes the pacing deadline
    // along with the terminal state, because the point of a precondition change
    // is that the attempt happens NOW. So this tick is the one the lane actually
    // attempts in, and therefore the only one a failure can be charged from.
    giveUp.holdTick(PAST_CEILING_MS + 1000);
    giveUp.noteSendAttempt(PAST_CEILING_MS + 1000);

    // The one attempt the re-arm bought is spent, and it failed.
    failAt(gate, giveUp, PACED_UNTIL_MS + 2000, SyncReason.RateLimited);

    expect(categoriesOf(GAVE_UP)).toHaveLength(2);
    expect(categoriesOf(REARMED)).toHaveLength(1);
    expect(categoriesOf(GAVE_UP)[1]?.diagnostics?.syncLaneGaveUp?.reason).toBe(
      SyncReason.RateLimited
    );
  });

  it("RE-ATTEMPTS the announcement dropped at a shut send gate", () => {
    const { gate, giveUp } = makeComponentGiveUp();
    // The give-up is only reached after 24h of unbroken environmental failure,
    // so the send gate this event rides is very likely shut at the crossing -
    // it is closed by the same connectivity loss that produced the give-up.
    setDeliverable(false);
    failAt(gate, giveUp, ORIGIN_MS);
    failAt(gate, giveUp, PAST_CEILING_MS, SyncReason.TransportUnavailable);
    expect(categoriesOf(GAVE_UP)).toHaveLength(0);

    // Every held tick re-attempts, so the one-shot transition is not the only
    // chance the event gets.
    expect(giveUp.holdTick(PAST_CEILING_MS + 5000)).toBe(true);
    expect(categoriesOf(GAVE_UP)).toHaveLength(0);

    setDeliverable(true);
    expect(giveUp.holdTick(PAST_CEILING_MS + 10_000)).toBe(true);

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp?.reason).toBe(
      SyncReason.TransportUnavailable
    );
    // The age is re-read at the attempt that lands, not captured at the crossing:
    // the run origin is not reset by a re-give-up, so this is how long the
    // install has been unable to deliver.
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp?.stalledForMs).toBe(
      PAST_CEILING_MS + 10_000 - ORIGIN_MS
    );

    // And it latches on the attempt that landed, so the cadence still holds.
    giveUp.holdTick(PAST_CEILING_MS + 15_000);
    giveUp.holdTick(PAST_CEILING_MS + 20_000);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);
  });

  it("reports BOTH halves for an outage whose recovery succeeded", () => {
    const { gate, giveUp } = makeComponentGiveUp();
    setDeliverable(false);
    failAt(gate, giveUp, ORIGIN_MS);
    failAt(gate, giveUp, PAST_CEILING_MS);

    // The ordinary recovery: the sign-in that re-arms the lane is also what
    // restores telemetry delivery, and the attempt it buys SUCCEEDS - so there is
    // no later failure to carry a give-up. Without the last-chance announcement
    // the `rearmed` is suppressed too (it answers a give-up nobody was told
    // about), and the whole outage reaches the operator as silence.
    setDeliverable(true);
    giveUp.holdTick(PACED_UNTIL_MS);
    giveUp.noteSendAttempt(PACED_UNTIL_MS);

    expect(categoriesOf(GAVE_UP)).toHaveLength(1);
    expect(categoriesOf(REARMED)).toHaveLength(1);
  });

  it("reports NO recovery for a lane whose give-up was never announced", () => {
    const { gate, giveUp } = makeComponentGiveUp();

    // A healthy lane: the run is open and the ceiling is nowhere near. A
    // `rearmed` here would claim a recovery from a state the operator was never
    // told about - and since the announcement now rides the SEND, a healthy lane
    // reaches it on every batch it ships, which makes this the silence that
    // matters most.
    failAt(gate, giveUp, ORIGIN_MS);
    expect(giveUp.holdTick(ORIGIN_MS + 5000)).toBe(false);
    giveUp.noteSendAttempt(ORIGIN_MS + 5000);

    expect(categoriesOf(REARMED)).toHaveLength(0);
    expect(categoriesOf(GAVE_UP)).toHaveLength(0);
  });

  it("ANNOUNCES a give-up resumed from the durable stamp, and answers it", () => {
    const { giveUp } = makeComponentGiveUp();

    // The app relaunched a second after a previous process crossed the ceiling -
    // a crash, an update, a quit and reopen - so this process is holding a
    // give-up it never saw happen. The announcement latch is process-scoped, so
    // nothing here was announced by anybody.
    const relaunchMs = PAST_CEILING_MS + 1000;
    giveUp.adoptPersisted(
      SOURCE_KEY,
      { laneGaveUpAt: new Date(PAST_CEILING_MS).toISOString() },
      relaunchMs
    );

    expect(giveUp.holdTick(relaunchMs)).toBe(true);

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    // A row written before PLN-2028 records the instant and NOTHING else, which
    // is what this fixture seeds. So the cause is ABSENT rather than guessed -
    // and the duration with it, because that row carries no run origin either.
    // `SyncReason` has no member meaning "unknown", and naming one that means
    // something else sends an operator after a precondition that was never the
    // problem. (A row written SINCE carries both, and the component suite pins
    // that it resumes them.)
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.ComponentInventory,
      // PLN-2028 D3: the row records no producer, and this lane has had exactly
      // one for its whole life, so the reader resolves it rather than reporting
      // an absence it can account for.
      source: LaneGiveUpSource.EnvironmentalGate,
    });
    expect(gaveUp[0]?.message).toContain("cause UNKNOWN");

    // ...and the recovery that ends it REACHES the operator. A `rearmed` is
    // suppressed for a lane whose give-up was never announced, so a resumed
    // give-up that stayed silent took its own answer down with it and the whole
    // outage - both halves of the pair - was lost for the rest of the hold.
    const windowOpenedMs =
      relaunchMs + laneReArmDelayMs(1, DEFAULT_LANE_STALL_SCHEDULE);
    expect(giveUp.holdTick(windowOpenedMs)).toBe(false);
    giveUp.noteSendAttempt(windowOpenedMs);
    expect(categoriesOf(REARMED)).toHaveLength(1);
  });

  it("reports an UNMEASURED duration for the failure that re-opened the run", () => {
    const { gate, giveUp } = makeComponentGiveUp();

    // Same relaunch, a day later and still inside the same outage. The stamp is
    // long past its re-arm window, so the lane attempts, and the attempt fails.
    const relaunchMs = PAST_CEILING_MS + 86_400_000;
    giveUp.adoptPersisted(
      SOURCE_KEY,
      { laneGaveUpAt: new Date(PAST_CEILING_MS).toISOString() },
      relaunchMs
    );

    failAt(gate, giveUp, relaunchMs, SyncReason.Unauthenticated);

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    // This pre-PLN-2028 row carries no run origin to resume, so the failure
    // OPENED a window and would measure it at 0 - for an install that has been
    // unable to deliver for over a day. A `0` on this field renders as "GAVE UP
    // after 0min" on the one signal that says how long the outage has run, so it
    // is reported as unmeasured instead. A row that DOES carry an origin resumes
    // it and reports the real duration, which the component suite pins.
    expect(
      Object.hasOwn(
        gaveUp[0]?.diagnostics?.syncLaneGaveUp ?? {},
        "stalledForMs"
      )
    ).toBe(false);
    expect(gaveUp[0]?.message).toContain("an UNMEASURED interval");
    expect(gaveUp[0]?.message).not.toContain("after 0min");
    // The CAUSE is known on this path, unlike the resumed announcement above:
    // the failure that noticed carried it.
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp?.reason).toBe(
      SyncReason.Unauthenticated
    );
  });

  it("drops the announcement on an identity switch WITHOUT claiming a recovery", () => {
    const { gate, giveUp } = makeComponentGiveUp();
    failAt(gate, giveUp, ORIGIN_MS);
    failAt(gate, giveUp, PAST_CEILING_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    giveUp.clearIdentity();
    expect(categoriesOf(REARMED)).toHaveLength(0);

    // A different compute target, its own outage. Without the latch drop this
    // give-up is swallowed as a duplicate of one that belonged to someone else.
    const next = makeComponentGiveUp();
    failAt(next.gate, next.giveUp, PAST_CEILING_MS);
    failAt(next.gate, next.giveUp, PAST_CEILING_MS * 2);
    expect(categoriesOf(GAVE_UP)).toHaveLength(2);
  });
});

/**
 * The cases above drive `ComponentLaneGiveUp` directly, which proves the seam
 * and NOT that the lane uses it - a counterfactual that swapped the lane's tick
 * gate back to the bare `environmentalDefer.isGivenUp` left all of them green.
 * The cases below drive the real `AgentComponentSyncLane.syncOnce`, so deleting
 * a call site is what fails.
 *
 * The two silences belong here and NOT to the seam, because what they are about
 * is the ORDER of the lane's gates: `holdTick` is the first of several, and the
 * pacing gate, the single-flight guard and the pre-send egress re-check each
 * return without sending. A seam-level case cannot observe a send that did not
 * happen, so it could only assert that a method it chose not to call announced
 * nothing.
 */
describe("component lane give-up wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** A lane whose transport always fails lane-wide, over one component row. */
  function makeFailingLane(
    overrides: Partial<AgentComponentSyncLaneOptions> = {}
  ): AgentComponentSyncLane {
    const row = { id: "component-a", last_seen_at: "2026-08-01T00:00:00.000Z" };
    return new AgentComponentSyncLane(
      {
        getSource: () => ({}) as never,
        getSyncComputeTargetId: () => "target-a",
        listComponentCursorRows: () => Promise.resolve([row]),
        loadComponentRows: (ids) =>
          Promise.resolve(ids.map((id) => syncedFor(id, row.last_seen_at))),
        sendComponents: () => Promise.resolve(laneFailureResult()),
        ...overrides,
      },
      { getSourceStateGeneration: () => 1, isStarted: () => true }
    );
  }

  async function tickAt(lane: AgentComponentSyncLane, atMs: number) {
    vi.setSystemTime(new Date(atMs));
    await lane.syncOnce();
  }

  it("announces the give-up and its re-arm from the lane's own tick", async () => {
    const lane = makeFailingLane();

    await tickAt(lane, ORIGIN_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(0);

    // The run has now outlived the ceiling, so this failure is the give-up.
    await tickAt(lane, PAST_CEILING_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    // Held ticks: the terminal gate answers on a pure read every 5s, and none of
    // them is a new transition.
    await tickAt(lane, PAST_CEILING_MS + 5000);
    await tickAt(lane, PAST_CEILING_MS + 10_000);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);
    expect(categoriesOf(REARMED)).toHaveLength(0);

    // Both gates clear, so the next tick may actually attempt again.
    await tickAt(lane, PACED_UNTIL_MS);

    const reArmed = categoriesOf(REARMED);
    expect(reArmed).toHaveLength(1);
    expect(reArmed[0]?.diagnostics?.syncLaneReArmed?.trigger).toBe("window");
  });

  it("stays silent while the PACING gate still holds the next attempt", async () => {
    const lane = makeFailingLane();
    await tickAt(lane, ORIGIN_MS);
    await tickAt(lane, PAST_CEILING_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    // The TERMINAL gate has opened - the widening window elapsed at the 5min
    // floor - but the ladder staged the next attempt at its 60min cap, so this
    // tick provably cannot send. Announcing a recovery here tells an operator
    // the lane is collecting up to 55 minutes before it can attempt anything.
    const windowOpenedMs =
      PAST_CEILING_MS + laneReArmDelayMs(1, DEFAULT_LANE_STALL_SCHEDULE) + 1;
    expect(windowOpenedMs).toBeLessThan(PACED_UNTIL_MS);
    await tickAt(lane, windowOpenedMs);
    expect(categoriesOf(REARMED)).toHaveLength(0);

    // ...and it is not lost, only deferred to the tick that will attempt.
    await tickAt(lane, PACED_UNTIL_MS);
    expect(categoriesOf(REARMED)).toHaveLength(1);
  });

  it("stays silent on a tick that gates out before it can send", async () => {
    // The pre-send re-check no longer folds in the consent tier - component
    // inventory is unconditional - so the compute target is what closes this
    // gate now. The CONTRACT is unchanged and is what this case pins: a tick
    // that cannot send must not announce a recovery. The switch has to land
    // DURING the run: the lane captures `computeTargetId` before its first
    // await and `isCurrentComponentState` compares the live value against that
    // capture, so a target changed between ticks reads as unchanged.
    const row = { id: "component-a", last_seen_at: "2026-08-01T00:00:00.000Z" };
    let target = "target-a";
    let switchTargetDuringLoad = false;
    const lane = makeFailingLane({
      getSyncComputeTargetId: () => target,
      loadComponentRows: (ids) => {
        if (switchTargetDuringLoad) {
          target = "target-b";
        }
        return Promise.resolve(
          ids.map((id) => syncedFor(id, row.last_seen_at))
        );
      },
    });
    await tickAt(lane, ORIGIN_MS);
    await tickAt(lane, PAST_CEILING_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    // BOTH gates have opened, so this tick is allowed to attempt - and then the
    // pre-send egress re-check closes on it, exactly as a mid-drain account /
    // target switch does. Nothing was sent, so "collecting again" is a claim
    // about a send that never happened, and the latch that would have carried
    // the give-up is released for nothing: the operator is told the outage
    // ended and then hears nothing until something fails.
    switchTargetDuringLoad = true;
    await tickAt(lane, PACED_UNTIL_MS);
    expect(categoriesOf(REARMED)).toHaveLength(0);

    // The target settles and the lane really does attempt, which is the tick
    // the recovery belongs to.
    switchTargetDuringLoad = false;
    target = "target-a";
    await tickAt(lane, PACED_UNTIL_MS + 5000);
    expect(categoriesOf(REARMED)).toHaveLength(1);
  });

  it("announces from the recovery send a drained install relies on", async () => {
    // A caught-up install: the live cursor is drained, so the dead-letter
    // recovery pass is the ONLY send this lane makes. Moving the announcement
    // onto the send is what makes this reachable at all - a wrapper applied to
    // the live batch alone would leave the steady state with a give-up that
    // never gets answered.
    const lane = makeFailingLane({
      listComponentCursorRows: () => Promise.resolve([]),
      getSource: () =>
        ({
          loadSyncState: () => Promise.resolve({ deadLetteredIds: ["dl-a"] }),
        }) as never,
    });

    await tickAt(lane, ORIGIN_MS);
    await tickAt(lane, PAST_CEILING_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    await tickAt(lane, PACED_UNTIL_MS);
    expect(categoriesOf(REARMED)).toHaveLength(1);
  });
});

describe("session lane give-up cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ORIGIN_MS + SESSION_LANE_STALL_CEILING_MS + 1));
  });

  /**
   * One ceiling-crossing fold over `id`, whose row opened its run at
   * {@link ORIGIN_MS}.
   *
   * The clock map is the CALLER's, so successive folds share it exactly as the
   * service's does - which is what lets the dead-letter's clock clear be visible
   * to the next fold. The id is a PARAMETER because the map is keyed by it: a
   * fold whose ids do not appear in the map admits a fresh clock at `nowMs` and
   * defers instead of crossing anything, so a case meaning to fold twice would
   * silently fold once and assert the second event's absence for the wrong
   * reason.
   */
  async function foldPastCeiling(
    deps: LaneStallFoldDeps,
    stalledSinceMsById: Map<string, number>,
    id = "session-a"
  ): Promise<void> {
    await applyLaneStallFold(
      {
        ids: [id],
        syncMode: AgentSessionSyncMode.Incremental,
        payloadBytes: 1024,
        deferClass: SessionEnvironmentalDeferClass.IngestionFailed,
        attemptsById: new Map(),
        stalledSinceMsById,
      },
      deps
    );
  }

  it("gives up once across repeated folds, carrying the reason and the remainder", async () => {
    const clocks = new Map([["session-a", ORIGIN_MS]]);
    const deps = makeFoldDeps(clocks, { incremental: 4, backfill: 7 });

    await foldPastCeiling(deps, clocks);
    // A long outage folds again and again as each staggered row clock runs out,
    // and each of these genuinely crosses the ceiling for its own row.
    await foldPastCeiling(
      deps,
      new Map([["session-b", ORIGIN_MS]]),
      "session-b"
    );
    await foldPastCeiling(
      deps,
      new Map([["session-c", ORIGIN_MS]]),
      "session-c"
    );

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.SessionMetadata,
      reason: SyncReason.IngestionFailed,
      // PLN-2028 (ISS-10043): the per-ROW ceiling, which is the producer whose
      // give-up terminates nothing lane-wide. The sibling case below is the same
      // lane's other producer, and it reads as terminal.
      source: LaneGiveUpSource.RowCeiling,
      stalledForMs: SESSION_LANE_STALL_CEILING_MS + 1,
      itemsOwed: 11,
      // What this ceiling ABANDONED, which `itemsOwed` cannot say - it counts the
      // remainder AFTER the dequeue, so an operator given only the remainder
      // concludes nothing left the queue.
      deadLetteredCount: 1,
    });
  });

  it("says the lane KEEPS ATTEMPTING and names what the ceiling abandoned", async () => {
    const clocks = new Map([["session-a", ORIGIN_MS]]);
    await foldPastCeiling(
      makeFoldDeps(clocks, { incremental: 2, backfill: 0 }),
      clocks
    );

    const message = categoriesOf(GAVE_UP)[0]?.message ?? "";
    // This ceiling dead-letters the expired rows and terminates NOTHING
    // lane-wide: every other row keeps deferring on `policy.schedule`. The
    // component sweep's wording would send an operator looking for a sign-in,
    // policy or target change that a still-retrying lane does not need.
    expect(message).toContain("KEEPS ATTEMPTING");
    expect(message).not.toContain("has stopped attempting");
    expect(message).not.toContain("no longer trying");
    expect(message).toContain("1 ABANDONED to the dead-letter ledger");
  });

  it("announces a SECOND identity's give-up instead of folding it into the first", async () => {
    let sourceKey = "agent_sessions:target-a";
    // The real collaborator, wired as the service wires it - this is where the
    // lane's identity is resolved, and the fold calls it before it announces.
    const writers = createOutboxWriters(() => ({ sourceKey, source: null }));
    const gate = new LaneEnvironmentalDeferGate();
    const clocksA = new Map([["session-a", ORIGIN_MS]]);
    await foldPastCeiling(
      makeFoldDeps(clocksA, undefined, (gaveUpAtMs, reason) =>
        writers.laneRun.noteRowCeilingGiveUp(gate, gaveUpAtMs, reason)
      ),
      clocksA
    );
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    // The machine switches accounts and target B gives up before it ever answers.
    // B is a genuinely different compute target having its own outage, so folding
    // it into A's as a duplicate means an operator never sees B's at all.
    sourceKey = "agent_sessions:target-b";
    writers.laneRun.clearIdentity();
    const clocksB = new Map([["session-b", ORIGIN_MS]]);
    await foldPastCeiling(
      makeFoldDeps(clocksB, undefined, (gaveUpAtMs, reason) =>
        writers.laneRun.noteRowCeilingGiveUp(gate, gaveUpAtMs, reason)
      ),
      clocksB,
      "session-b"
    );

    expect(categoriesOf(GAVE_UP)).toHaveLength(2);
    // And no `rearmed` in between: the previous target's outage did not end, this
    // machine simply stopped being the one collecting for it.
    expect(categoriesOf(REARMED)).toHaveLength(0);
  });

  it("ANNOUNCES the gate's own give-up when it happens, once per transition", () => {
    // PLN-2028 M5 (tamsinb review; operator decision 2026-09-17). This producer
    // recorded its give-up durably and went terminal without telling anybody, so
    // it reached the monitoring channel only if the user happened to restart
    // inside the outage - which made the `environmental_gate` bucket of M5's own
    // per-producer grouping a count of RELAUNCHES rather than of outages.
    const writers = createOutboxWriters(() => ({
      sourceKey: "agent_sessions:target-live-gate",
      source: null,
    }));
    const gate = new LaneEnvironmentalDeferGate();
    const failAtMs = (nowMs: number): void =>
      writers.laneRun.noteEnvironmentalOutcome(
        gate,
        gate.noteEnvironmentalFailure(nowMs),
        SyncReason.Unauthenticated
      );

    failAtMs(ORIGIN_MS);
    expect(categoriesOf(GAVE_UP)).toHaveLength(0);

    failAtMs(PAST_CEILING_MS);
    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.SessionMetadata,
      reason: SyncReason.Unauthenticated,
      // The dimension the whole grouping turns on: this is the lane-wide
      // producer, and its sentence is the opposite of the row ceiling's above.
      source: LaneGiveUpSource.EnvironmentalGate,
      stalledForMs: PAST_CEILING_MS - ORIGIN_MS,
    });
    expect(gaveUp[0]?.message).toContain("has stopped attempting");
    expect(gaveUp[0]?.message).not.toContain("KEEPS ATTEMPTING");

    // Once per TRANSITION, not once per failure: a given-up lane keeps folding
    // failures for as long as the outage lasts, and the latch is what keeps a
    // rate monitor counting give-ups rather than ticks.
    failAtMs(PAST_CEILING_MS + 5000);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);
  });

  it("counts a RESUMED give-up and the failures into that same run as one", () => {
    // The other half of the cadence, and the one the live announcement above
    // could have broken: a process that relaunched inside the outage announces
    // the give-up it resumed, then keeps failing into that same run. Two events
    // there would read as a second outage that never happened.
    const writers = createOutboxWriters(() => ({
      sourceKey: "agent_sessions:target-resumed-then-live",
      source: null,
    }));
    const gate = new LaneEnvironmentalDeferGate();

    writers.laneRun.adopt(
      gate,
      {
        laneStalledSince: new Date(ORIGIN_MS).toISOString(),
        laneGaveUpAt: new Date(PAST_CEILING_MS).toISOString(),
        laneGaveUpReason: SyncReason.Unauthenticated,
        laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
      },
      Date.now()
    );
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    writers.laneRun.noteEnvironmentalOutcome(
      gate,
      gate.noteEnvironmentalFailure(Date.now()),
      SyncReason.Unauthenticated
    );

    expect(categoriesOf(GAVE_UP)).toHaveLength(1);
  });

  it("reports no give-up for a fold that has not reached the ceiling", async () => {
    vi.setSystemTime(new Date(ORIGIN_MS + 60_000));
    const clocks = new Map([["session-a", ORIGIN_MS]]);
    await foldPastCeiling(makeFoldDeps(clocks), clocks);

    expect(categoriesOf(GAVE_UP)).toHaveLength(0);
  });

  it("answers the give-up when the lane ANSWERS, with no door named", async () => {
    const clocks = new Map([["session-a", ORIGIN_MS]]);
    await foldPastCeiling(makeFoldDeps(clocks), clocks);
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    // `noteLaneAnswered` and the verified-ack path both reach this one clear.
    const writers = createOutboxWriters(() => ({
      sourceKey: SOURCE_KEY,
      source: null,
    }));
    writers.laneRun.clear();
    // Every healthy batch that follows reaches it too, and must stay silent.
    writers.laneRun.clear();

    const reArmed = categoriesOf(REARMED);
    expect(reArmed).toHaveLength(1);
    expect(reArmed[0]?.diagnostics?.syncLaneReArmed).toEqual({
      lane: SyncLane.SessionMetadata,
    });
    expect(reArmed[0]?.message).toContain("because the lane ANSWERED");
  });

  it("ANNOUNCES a give-up RESUMED from the durable stamp, and answers it", () => {
    const writers = createOutboxWriters(() => ({
      sourceKey: "agent_sessions:target-a",
      source: null,
    }));

    // A previous process crossed the ceiling and stamped the column; this one
    // relaunched inside the same outage, so the announcement latch is
    // process-scoped and empty - nothing here was announced by anybody.
    writers.laneRun.adopt(
      new LaneEnvironmentalDeferGate(),
      { laneGaveUpAt: new Date(ORIGIN_MS).toISOString() },
      Date.now()
    );

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    // The column records an instant and no cause, and the run origin and the
    // queue depth died with the previous process - so everything but the lane is
    // ABSENT rather than guessed.
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.SessionMetadata,
      // PLN-2028 D3: a session row with no producer column predates ISS-8610, so
      // the row ceiling was its only producer then. Resolving it the other way
      // is the ISS-10043 bounce.
      source: LaneGiveUpSource.RowCeiling,
    });
    expect(gaveUp[0]?.message).toContain("cause UNKNOWN");
    // This lane's outbox is real, so an absent count is one this process could
    // not take - never the component sweep's structural "there is no queue",
    // which on THIS event reads as "nothing was lost".
    expect(gaveUp[0]?.message).toContain("still owed is UNMEASURED");
    expect(gaveUp[0]?.message).not.toContain("keeps no item queue");

    // ...and the ack that ends the outage REACHES the operator. A `rearmed` is
    // suppressed for a lane whose give-up was never announced, so a resumed
    // give-up that stayed silent took its own answer down with it and the whole
    // outage - both halves of the pair - reached an operator as silence.
    writers.laneRun.clear();
    expect(categoriesOf(REARMED)).toHaveLength(1);
  });

  it("reads a resumed session GATE give-up as TERMINAL, with its cause and its real age", () => {
    // PLN-2028 M5 (ISS-10043, ISS-9963), and the sibling of the case above on the
    // SAME lane. Pinned to the lane alone, `LANE_GIVE_UP_SHAPE` told an operator
    // that every session give-up "KEEPS ATTEMPTING" - true of the per-row ceiling
    // and false of this one, which is the whole lane holding until a recovery
    // door opens. The two cases differ only in the producer on the row.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PAST_CEILING_MS));
    const writers = createOutboxWriters(() => ({
      sourceKey: "agent_sessions:target-resumed-gate",
      source: null,
    }));

    writers.laneRun.adopt(
      new LaneEnvironmentalDeferGate(),
      {
        laneStalledSince: new Date(ORIGIN_MS).toISOString(),
        laneGaveUpAt: new Date(PAST_CEILING_MS).toISOString(),
        laneGaveUpReason: SyncReason.Unauthenticated,
        laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
      },
      Date.now()
    );

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.SessionMetadata,
      // ISS-9963: off the row, both of them. The duration is measured from the
      // persisted ORIGIN, which is what this process could not otherwise know -
      // its own gate opened moments ago.
      reason: SyncReason.Unauthenticated,
      source: LaneGiveUpSource.EnvironmentalGate,
      stalledForMs: PAST_CEILING_MS - ORIGIN_MS,
    });
    // The sentence the shape decides, in both directions.
    expect(gaveUp[0]?.message).toContain("has stopped attempting");
    expect(gaveUp[0]?.message).not.toContain("KEEPS ATTEMPTING");
    expect(gaveUp[0]?.message).not.toContain("cause UNKNOWN");
  });

  it("claims NEITHER session sentence for a producer this build does not know", () => {
    // PLN-2028 D3's unrecognised half, reaching the prose. A row written by a
    // NEWER desktop can name a producer this build has never heard of, and the
    // two sentences this lane's known producers get say opposite things - one
    // that collection has stopped, one that it continues. Borrowing either is a
    // confident claim about a value this build cannot judge, so the scope is
    // reported as unknown, which is what the reader actually has.
    const writers = createOutboxWriters(() => ({
      sourceKey: "agent_sessions:target-foreign-producer",
      source: null,
    }));

    writers.laneRun.adopt(
      new LaneEnvironmentalDeferGate(),
      {
        laneGaveUpAt: new Date(ORIGIN_MS).toISOString(),
        laneGaveUpSource: "a_producer_this_build_never_heard_of",
      },
      Date.now()
    );

    const gaveUp = categoriesOf(GAVE_UP);
    expect(gaveUp).toHaveLength(1);
    // Omitted on the wire too: attributing it to a known producer is the same
    // fabrication the prose refuses.
    expect(gaveUp[0]?.diagnostics?.syncLaneGaveUp).toEqual({
      lane: SyncLane.SessionMetadata,
    });
    expect(gaveUp[0]?.message).toContain("is UNCLASSIFIED for it");
    expect(gaveUp[0]?.message).not.toContain("KEEPS ATTEMPTING");
    expect(gaveUp[0]?.message).not.toContain("has stopped attempting");
    // And it says WHY it could not be classified. Nothing was mis-wired here:
    // the row named a producer this build does not know, so telling an operator
    // a producer "was wired without saying which" sends them looking for a
    // missing shape entry that does not exist (marisolashgrove review).
    expect(gaveUp[0]?.message).toContain(
      "the durable row it was resumed from could not supply one"
    );
  });

  it("adopts a SECOND identity's stamp instead of folding it into the first", () => {
    let sourceKey = "agent_sessions:target-a";
    const writers = createOutboxWriters(() => ({ sourceKey, source: null }));
    const gate = new LaneEnvironmentalDeferGate();
    writers.laneRun.adopt(
      gate,
      { laneGaveUpAt: new Date(ORIGIN_MS).toISOString() },
      Date.now()
    );
    expect(categoriesOf(GAVE_UP)).toHaveLength(1);

    // The machine switches accounts, and hydration is where that is seen
    // EARLIEST - before target B has failed or answered anything. Announcing
    // before the identity drop would swallow B's give-up as a duplicate of A's
    // and THEN drop the latch, so B's outage would reach nobody.
    sourceKey = "agent_sessions:target-b";
    writers.laneRun.adopt(
      gate,
      { laneGaveUpAt: new Date(ORIGIN_MS + 1000).toISOString() },
      Date.now()
    );

    expect(categoriesOf(GAVE_UP)).toHaveLength(2);
    // And no `rearmed` in between: A's outage did not end, this machine simply
    // stopped being the one collecting for it.
    expect(categoriesOf(REARMED)).toHaveLength(0);
  });
});
