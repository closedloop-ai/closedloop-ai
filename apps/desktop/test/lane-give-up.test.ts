/**
 * @file lane-give-up.test.ts
 * @description ISS-9418 (PRD-699 Appendix A): the ENVIRONMENTAL 24h give-up —
 * the terminal state a lane enters at the ceiling, the durable stamp that makes
 * it survive a relaunch, and the two doors that re-arm it.
 *
 * The pure cases pass `nowMs` explicitly, because the subject IS a clock. The
 * WIRING cases pin the system clock with fake timers, because production reads
 * `Date.now()` and the claim under test is "the next tick does not send".
 * Timers are restored in an unconditional `afterEach`, never at the end of a
 * case: a throw between install and restore leaks a frozen clock into every
 * later suite in the worker.
 *
 * Every "the lane stopped" assertion has a positive sibling proving it starts
 * again — a lane broken for an unrelated reason passes the negative half on its
 * own, and a terminal state with no reachable door is the exact defect this
 * ticket exists to end.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { LaneEnvironmentalDeferGate } from "../src/main/sync/lane-environmental-defer.js";
import {
  LaneGiveUpStampDefect,
  LaneReArmTrigger,
  laneGiveUpReached,
  laneGiveUpState,
  laneReArmDelayMs,
  laneReArmed,
  readLaneGiveUpStamp,
} from "../src/shared/lane-give-up.js";
import {
  LANE_STALL_CEILING_MS,
  LANE_STALL_MAX_RETRY_MS,
  LANE_STALL_RETRY_FLOOR_MS,
} from "../src/shared/lane-stall-clock.js";
import {
  acceptedResult,
  flush,
  laneFailureResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const MINUTE_MS = 60_000;
const NOW_MS = 1_800_000_000_000;
const ROW_SEEN_AT = "2026-07-20T10:00:00.000Z";

describe("lane-give-up primitive", () => {
  it("gives up at the SHARED ceiling and not one millisecond earlier", () => {
    // The boundary is asserted against `LANE_STALL_CEILING_MS` itself rather
    // than a hand-written 24h, because "no second ceiling constant" is the
    // contract: a give-up that drifted onto its own literal would still pass a
    // test that spelled the number out.
    const base = { gaveUpAtMs: null, stalledSinceMs: NOW_MS };
    expect(
      laneGiveUpReached({ ...base, nowMs: NOW_MS + LANE_STALL_CEILING_MS - 1 })
    ).toBe(false);
    expect(
      laneGiveUpReached({ ...base, nowMs: NOW_MS + LANE_STALL_CEILING_MS })
    ).toBe(true);
  });

  it("never gives up on a run whose origin is unknown", () => {
    // An unreadable `lane_gave_up_at` / `lane_stalled_since` is not evidence
    // that anything waited. Treating it as spent would terminate healthy lanes
    // the first time a column failed to parse.
    expect(
      laneGiveUpReached({
        stalledSinceMs: null,
        gaveUpAtMs: null,
        nowMs: NOW_MS + 10 * LANE_STALL_CEILING_MS,
      })
    ).toBe(false);
  });

  it("anchors the stamp to the FIRST give-up, not to the latest failure", () => {
    // Re-anchoring is the durable-column version of an unbounded retry: every
    // later failure would hand the lane a fresh re-arm window forever.
    const state = laneGiveUpState({
      stalledSinceMs: NOW_MS,
      gaveUpAtMs: NOW_MS + LANE_STALL_CEILING_MS,
      nowMs: NOW_MS + 3 * LANE_STALL_CEILING_MS,
    });
    expect(state.givenUp).toBe(true);
    expect(state.gaveUpAtMs).toBe(NOW_MS + LANE_STALL_CEILING_MS);
    expect(state.elapsedMs).toBe(2 * LANE_STALL_CEILING_MS);
  });

  it("reports the stamp a fresh give-up should persist", () => {
    const state = laneGiveUpState({
      stalledSinceMs: NOW_MS,
      gaveUpAtMs: null,
      nowMs: NOW_MS + LANE_STALL_CEILING_MS,
    });
    expect(state.givenUp).toBe(true);
    expect(state.gaveUpAtMs).toBe(NOW_MS + LANE_STALL_CEILING_MS);
  });

  it("widens the re-arm window from the schedule floor to its cap", () => {
    // The session lane's FEA-3795 window, to the millisecond: 5min doubling to a
    // 24h cap. Asserted against the shared constants for the same reason the
    // ceiling case is.
    expect(laneReArmDelayMs(1)).toBe(LANE_STALL_RETRY_FLOOR_MS);
    expect(laneReArmDelayMs(2)).toBe(2 * LANE_STALL_RETRY_FLOOR_MS);
    expect(laneReArmDelayMs(3)).toBe(4 * LANE_STALL_RETRY_FLOOR_MS);
    expect(laneReArmDelayMs(99)).toBe(LANE_STALL_CEILING_MS);
  });

  it("re-arms on the WINDOW with no event at all, and names which door opened", () => {
    // The operator-added arm. Without it a laptop that regains access with no
    // sign-in, no policy change and no target switch stays terminal until the
    // process restarts.
    const base = { gaveUpAtMs: NOW_MS, giveUpCount: 1, eventFired: false };
    expect(
      laneReArmed({ ...base, nowMs: NOW_MS + LANE_STALL_RETRY_FLOOR_MS - 1 })
    ).toBe(null);
    expect(
      laneReArmed({ ...base, nowMs: NOW_MS + LANE_STALL_RETRY_FLOOR_MS })
    ).toBe(LaneReArmTrigger.Window);
  });

  it("lets an EVENT outrank the window it has not yet reached", () => {
    expect(
      laneReArmed({
        gaveUpAtMs: NOW_MS,
        giveUpCount: 1,
        nowMs: NOW_MS + 1,
        eventFired: true,
      })
    ).toBe(LaneReArmTrigger.Event);
  });

  it("re-arms nothing on a lane that never gave up", () => {
    // A healthy lane must not report a recovery it never needed — an event
    // answering here would make every sign-in a licence to ignore the ladder.
    expect(
      laneReArmed({
        gaveUpAtMs: null,
        giveUpCount: 0,
        nowMs: NOW_MS,
        eventFired: true,
      })
    ).toBe(null);
  });
});

describe("LaneEnvironmentalDeferGate give-up", () => {
  it("enters the give-up state at the ceiling and reports the stamp to persist", () => {
    const gate = new LaneEnvironmentalDeferGate();
    const opened = gate.noteEnvironmentalFailure(NOW_MS);
    expect(opened.givenUp).toBe(false);
    expect(opened.gaveUpAtMs).toBe(null);
    expect(gate.isGivenUp(NOW_MS + MINUTE_MS)).toBe(false);

    const ceiling = NOW_MS + LANE_STALL_CEILING_MS;
    const gaveUp = gate.noteEnvironmentalFailure(ceiling);
    expect(gaveUp.givenUp).toBe(true);
    expect(gaveUp.gaveUpAtMs).toBe(ceiling);
    expect(gate.giveUpStampMs()).toBe(ceiling);
    expect(gate.isGivenUp(ceiling)).toBe(true);
  });

  it("re-arms on the widening window with no event, then re-stamps and widens", () => {
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);
    const ceiling = NOW_MS + LANE_STALL_CEILING_MS;
    gate.noteEnvironmentalFailure(ceiling);

    expect(gate.isGivenUp(ceiling + LANE_STALL_RETRY_FLOOR_MS - 1)).toBe(true);
    const firstDoor = ceiling + LANE_STALL_RETRY_FLOOR_MS;
    expect(gate.isGivenUp(firstDoor)).toBe(false);
    expect(gate.reArmTrigger(firstDoor)).toBe(LaneReArmTrigger.Window);

    // The attempt the door bought fails: re-stamped HERE, and the next window is
    // twice as long. Without the re-stamp the lane would re-attempt every five
    // minutes forever, which is the unbounded retry the ceiling replaced.
    const spent = gate.noteEnvironmentalFailure(firstDoor);
    expect(spent.givenUp).toBe(true);
    expect(spent.gaveUpAtMs).toBe(firstDoor);
    expect(gate.isGivenUp(firstDoor + LANE_STALL_RETRY_FLOOR_MS)).toBe(true);
    expect(gate.isGivenUp(firstDoor + 2 * LANE_STALL_RETRY_FLOOR_MS)).toBe(
      false
    );
  });

  it("buys exactly ONE attempt on a recovery signal, then re-stamps", () => {
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);
    const ceiling = NOW_MS + LANE_STALL_CEILING_MS;
    gate.noteEnvironmentalFailure(ceiling);
    expect(gate.isGivenUp(ceiling + 1)).toBe(true);

    expect(gate.noteRecoverySignal()).toBe(true);
    expect(gate.isGivenUp(ceiling + 1)).toBe(false);

    // The one attempt fails: given up again on the spot, NOT deferred for a
    // fresh 24h run. A cleared stamp here would let a permanently-broken corpus
    // churn a whole ceiling on every sign-in.
    const spent = gate.noteEnvironmentalFailure(ceiling + 1);
    expect(spent.givenUp).toBe(true);
    expect(gate.isGivenUp(ceiling + 2)).toBe(true);
  });

  it("re-arms nothing when the lane has not given up", () => {
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);
    expect(gate.noteRecoverySignal()).toBe(false);
    // ...and the ordinary backoff is untouched by the signal that did nothing.
    expect(gate.isDeferred(NOW_MS + MINUTE_MS)).toBe(true);
  });

  it("ends the give-up when the lane is ANSWERED", () => {
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);
    const ceiling = NOW_MS + LANE_STALL_CEILING_MS;
    gate.noteEnvironmentalFailure(ceiling);
    gate.noteLaneAnswered();
    expect(gate.isGivenUp(ceiling + 1)).toBe(false);
    expect(gate.giveUpStampMs()).toBe(null);

    // And the NEXT outage gets a full ceiling, not a resumed one.
    const reopened = gate.noteEnvironmentalFailure(ceiling + MINUTE_MS);
    expect(reopened.givenUp).toBe(false);
  });

  it("resumes a give-up hydrated from the durable stamp", () => {
    // The relaunch case. An in-memory ceiling never fires for a desktop that
    // keeps restarting inside an outage, so a fresh gate handed the stamp must
    // be terminal with no failures of its own.
    const gate = new LaneEnvironmentalDeferGate();
    gate.hydrateGiveUp(NOW_MS, NOW_MS);
    expect(gate.isGivenUp(NOW_MS + 1)).toBe(true);
    expect(gate.giveUpStampMs()).toBe(NOW_MS);
  });

  it("adopts nothing from an unreadable stamp", () => {
    const gate = new LaneEnvironmentalDeferGate();
    gate.hydrateGiveUp(Number.NaN, NOW_MS);
    expect(gate.isGivenUp(NOW_MS)).toBe(false);
    expect(gate.giveUpStampMs()).toBe(null);
  });

  it("keeps the WINDOW door reachable after hydrating a FUTURE stamp", () => {
    // A backwards clock jump, or a corrupt row, leaves the stored stamp ahead of
    // the clock. Adopted verbatim it is terminal AND unreachable: the widening
    // window measures `now - min(stamp, now)`, which is zero at every instant
    // the stamp is still in the future, so the door never opens and only the
    // EVENT arm is left — the arm the window one exists because we cannot count
    // on. Normalizing at hydration is what keeps the door.
    const gate = new LaneEnvironmentalDeferGate();
    gate.hydrateGiveUp(NOW_MS + 90 * 24 * 60 * MINUTE_MS, NOW_MS);

    expect(gate.giveUpStampMs()).toBe(NOW_MS);
    expect(gate.isGivenUp(NOW_MS)).toBe(true);
    // The first rung of the widening window, measured from a real instant.
    expect(gate.isGivenUp(NOW_MS + LANE_STALL_RETRY_FLOOR_MS)).toBe(false);
    expect(gate.reArmTrigger(NOW_MS + LANE_STALL_RETRY_FLOOR_MS)).toBe(
      LaneReArmTrigger.Window
    );
  });

  it("normalizes a FUTURE stamp into the state its owner persists", () => {
    // `laneGiveUpState` reports the stamp the owner WRITES, so clamping only the
    // elapsed reading would leave the impossible instant on the row and hand the
    // next launch the same unreachable window. This is the treatment
    // `laneStallWindow` already gives a future run origin.
    const state = laneGiveUpState({
      stalledSinceMs: NOW_MS,
      gaveUpAtMs: NOW_MS + LANE_STALL_CEILING_MS,
      nowMs: NOW_MS,
    });
    expect(state.givenUp).toBe(true);
    expect(state.gaveUpAtMs).toBe(NOW_MS);
    expect(state.elapsedMs).toBe(0);
  });

  it("reads a stored stamp, and says which stored values are not measurements", () => {
    // An ABSENT column is the ordinary state of a lane that never gave up, so it
    // is not a defect; the other three answers are all different.
    expect(readLaneGiveUpStamp(undefined, NOW_MS)).toEqual({
      gaveUpAtMs: null,
      storedMs: null,
      defect: null,
    });
    expect(readLaneGiveUpStamp("not-a-date", NOW_MS)).toEqual({
      gaveUpAtMs: null,
      storedMs: null,
      defect: LaneGiveUpStampDefect.Unreadable,
    });
    const pastMs = NOW_MS - MINUTE_MS;
    expect(readLaneGiveUpStamp(new Date(pastMs).toISOString(), NOW_MS)).toEqual(
      {
        gaveUpAtMs: pastMs,
        storedMs: pastMs,
        defect: null,
      }
    );
    // The ANCHOR is normalized while `storedMs` keeps what the column holds —
    // that divergence is what lets the adopting lane notice and repair the row.
    const futureMs = NOW_MS + MINUTE_MS;
    expect(
      readLaneGiveUpStamp(new Date(futureMs).toISOString(), NOW_MS)
    ).toEqual({
      gaveUpAtMs: NOW_MS,
      storedMs: futureMs,
      defect: LaneGiveUpStampDefect.Future,
    });
  });
});

/** What one case's fake component-lane source recorded. */
type ComponentLaneProbe = {
  options: AgentSessionSyncServiceOptions;
  sends: string[][];
  cursorWrites: string[];
  giveUpWrites: (string | null)[];
};

/**
 * A component lane whose send outcome the case chooses, over a source that
 * records BOTH durable writes the give-up must be told apart from: the cursor
 * advance and the lane run.
 *
 * PLN-2028: the lane writes its whole run through `recordLaneRun`, so
 * `giveUpWrites` is projected from that record's give-up column. Left on the
 * stamp-only alias this log would simply stop filling, and every assertion over
 * it would pass against a lane that had stopped writing anything at all.
 */
function componentLaneProbe(
  send: () => ReturnType<typeof laneFailureResult>,
  persisted: PersistedSyncState = {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
    deadLetteredIds: [],
  }
): ComponentLaneProbe {
  const rows: AgentComponentCursorRow[] = [
    { id: "a", last_seen_at: ROW_SEEN_AT },
  ];
  const sends: string[][] = [];
  const cursorWrites: string[] = [];
  const giveUpWrites: (string | null)[] = [];
  const source: Pick<
    AgentSessionSyncSource,
    "loadSyncState" | "advanceSyncState" | "recordLaneRun"
  > = {
    loadSyncState: () => persisted,
    advanceSyncState: (_key, state) => {
      cursorWrites.push(state.observedTopUpdatedAt ?? "");
    },
    recordLaneRun: (_key, run) => {
      giveUpWrites.push(run.laneGaveUpAt);
    },
  };
  return {
    sends,
    cursorWrites,
    giveUpWrites,
    options: {
      isHttpReady: () => true,
      getSource: () => source as AgentSessionSyncSource,
      getSyncComputeTargetId: () => "target-give-up",
      sendBatch: () => Promise.resolve({ accepted: true }),
      listComponentCursorRows: (sinceTs, sinceId) =>
        Promise.resolve(
          rows.filter(
            (r) =>
              (r.last_seen_at ?? "") > sinceTs ||
              ((r.last_seen_at ?? "") === sinceTs && r.id > sinceId)
          )
        ),
      loadComponentRows: (ids) =>
        Promise.resolve(ids.map((id) => syncedFor(id, ROW_SEEN_AT))),
      sendComponents: (payload) => {
        sends.push(payload.components.map((c) => c.externalId));
        return Promise.resolve(send());
      },
    },
  };
}

/**
 * Drive the component lane to its ceiling: one failure opens the run, and a
 * second a full ceiling later crosses it. Returns the instant of the give-up.
 *
 * The two sends are the fixture's own PRECONDITION, so they throw rather than
 * assert: an assertion here would be attributed to whichever case happened to
 * call the helper, and this is setup that must hold for every one of them.
 */
async function driveToGiveUp(
  service: AgentSessionSyncService,
  probe: ComponentLaneProbe
): Promise<number> {
  service.start();
  await flush();
  const afterOpen: number = probe.sends.length;
  if (afterOpen !== 1) {
    throw new Error(
      `fixture: the first tick should send once, sent ${afterOpen}`
    );
  }
  const ceiling = NOW_MS + LANE_STALL_CEILING_MS;
  vi.setSystemTime(ceiling);
  service.refresh();
  await flush();
  const afterCeiling: number = probe.sends.length;
  if (afterCeiling !== 2) {
    throw new Error(
      `fixture: the run's last attempt should cross the ceiling, sent ${afterCeiling}`
    );
  }
  return ceiling;
}

describe("component-inventory lane give-up (PRD-699 invariant 5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
  });

  test("a lane that stays given up charges no owed row and never moves its cursor", async () => {
    // Invariant 4 at the ceiling: an environmental give-up is not
    // item-attributable, so dead-lettering the rows it owes because the WORLD was
    // broken is the ISS-6883 / ISS-7730 defect class that lost 40,634 events.
    //
    // The cycles are load-bearing, not padding. The component lane's dead-letter
    // budget only fires once a boundary crosses
    // `COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD` consecutive failures, so a case
    // that gave up and stopped would report zero against a lane that charges at
    // the ceiling too — it simply would not have charged enough yet. Staying past
    // the threshold is what makes the zero mean something.
    //
    // Deliberately claims nothing about TIMING: at the first give-up the pacing
    // ladder is still the longer of the two gates, so a timing assertion here
    // would pass on the ladder alone. That claim is the sibling below.
    const probe = componentLaneProbe(laneFailureResult);
    const service = new AgentSessionSyncService(probe.options);
    let at = await driveToGiveUp(service, probe);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      at += LANE_STALL_MAX_RETRY_MS;
      vi.setSystemTime(at);
      service.refresh();
      await flush();
    }
    assert.ok(
      probe.sends.length > 3,
      "the same boundary failed more times than the dead-letter budget allows, so a lane that charged at the ceiling would have burned it"
    );
    assert.equal(
      service.getSyncProgress().deadLetteredComponents,
      0,
      "and yet nothing is dead-lettered: owed items are NOT charged (invariant 4)"
    );
    assert.deepEqual(
      probe.cursorWrites,
      [],
      "nor does the cursor move — a given-up sweep leaves it exactly where it is"
    );
  });

  test("the give-up OUTLIVES the backoff ladder that paced the run", async () => {
    // The claim that separates a give-up from a defer, and the only timing shape
    // that can. The two gates compose as a max: the ladder caps at 60 minutes
    // while the give-up window doubles from 5 minutes without bound, so the
    // ladder is the longer gate for the first four re-arms and the give-up is
    // the longer one from the fifth on. A lane that stamped the ceiling and then
    // kept only its ladder passes every earlier assertion in this file and fails
    // exactly here.
    const probe = componentLaneProbe(laneFailureResult);
    const service = new AgentSessionSyncService(probe.options);
    let at = await driveToGiveUp(service, probe);

    // Four re-arm-and-fail cycles on the ladder's cap. Each spends the window's
    // one attempt and doubles it: 5 → 10 → 20 → 40 → 80 minutes.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      at += LANE_STALL_MAX_RETRY_MS;
      vi.setSystemTime(at);
      service.refresh();
      await flush();
    }
    const sendsAtWidestLadderRung = probe.sends.length;
    assert.equal(
      sendsAtWidestLadderRung,
      6,
      "each cycle bought exactly ONE attempt, never a free-running retry"
    );

    vi.setSystemTime(at + LANE_STALL_MAX_RETRY_MS);
    service.refresh();
    await flush();
    assert.equal(
      probe.sends.length,
      sendsAtWidestLadderRung,
      "the ladder's cap has elapsed and the lane is STILL held — by the give-up"
    );

    vi.setSystemTime(at + 2 * LANE_STALL_MAX_RETRY_MS);
    service.refresh();
    await flush();
    assert.equal(
      probe.sends.length,
      sendsAtWidestLadderRung + 1,
      "and it is a widened window, not a permanent stop"
    );
  });

  test("stamps the give-up durably, so it survives the process", async () => {
    const probe = componentLaneProbe(laneFailureResult);
    const service = new AgentSessionSyncService(probe.options);
    const ceiling = await driveToGiveUp(service, probe);

    // PLN-2028: the lane writes its whole RUN, so the log also carries the write
    // that recorded the origin when the run opened, with a null give-up. That
    // write is the point of ISS-10053 and is asserted where it belongs
    // (`agent-component-lane-give-up.test.ts`); what this case still pins is
    // that the give-up INSTANT itself reaches the column exactly once, however
    // many times the run around it is written.
    assert.deepEqual(
      probe.giveUpWrites.filter((gaveUpAt) => gaveUpAt !== null),
      [new Date(ceiling).toISOString()],
      "the give-up instant reaches sync_state.lane_gave_up_at exactly once"
    );
  });

  test("a relaunch inside the outage resumes the give-up instead of restarting the clock", async () => {
    // The whole reason the stamp is durable: with an in-memory ceiling, a desktop
    // that keeps restarting inside a long outage re-opens a 24h run on every
    // launch and never reaches the terminal path at all.
    //
    // Proving that takes more than "the next tick is quiet", because for the
    // first few rungs the backoff ladder is the longer gate and a lane that
    // ignored the stamp would be just as quiet. What ONLY a resumed give-up can
    // do is widen past the ladder's 60-minute cap without ever spending 24 hours
    // — this whole case runs inside five, so a lane on a fresh run has not
    // reached its ceiling and is still sending on every rung.
    const probe = componentLaneProbe(laneFailureResult, {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
      laneGaveUpAt: new Date(NOW_MS - MINUTE_MS).toISOString(),
    });
    const service = new AgentSessionSyncService(probe.options);

    service.start();
    await flush();
    // The FIRST tick, and it is the one a relaunch inside an outage gets wrong.
    // `syncOnce`'s gate reads the in-memory give-up, which is still null because
    // nothing has consulted the durable row yet — so the send is refused only if
    // the run re-checks the gate after hydration adopts the stamp. Without that
    // re-check every launch leaks exactly one unauthorized send at the cloud it
    // gave up on, which is the restart hole the durable stamp exists to close.
    assert.equal(
      probe.sends.length,
      0,
      "a relaunched given-up lane sends NOTHING on its first tick"
    );
    let at = NOW_MS;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      at += LANE_STALL_MAX_RETRY_MS;
      vi.setSystemTime(at);
      service.refresh();
      await flush();
    }
    const sendsSoFar = probe.sends.length;

    vi.setSystemTime(at + LANE_STALL_MAX_RETRY_MS);
    service.refresh();
    await flush();
    assert.equal(
      probe.sends.length,
      sendsSoFar,
      "held past the ladder's cap only five hours in — the give-up came off disk, not from a 24h run this process served"
    );
    assert.ok(
      at + LANE_STALL_MAX_RETRY_MS - NOW_MS < LANE_STALL_CEILING_MS,
      "and the case never let a fresh in-memory run reach its own ceiling"
    );
  });

  test("a recovery signal re-arms the lane and it drains", async () => {
    // The event door. The lane must both STOP at the ceiling and START again on
    // a precondition change; a terminal state with no reachable door is the
    // defect class this ticket exists to end.
    let accepted = false;
    const probe = componentLaneProbe(() =>
      accepted ? acceptedResult() : laneFailureResult()
    );
    const service = new AgentSessionSyncService(probe.options);
    const ceiling = await driveToGiveUp(service, probe);

    service.refresh();
    await flush();
    assert.equal(
      probe.sends.length,
      2,
      "given up: an ordinary tick does nothing"
    );

    accepted = true;
    service.noteLaneRecoverySignal();
    service.refresh();
    await flush();
    assert.equal(probe.sends.length, 3, "the recovery signal buys one attempt");
    assert.deepEqual(
      probe.cursorWrites,
      [ROW_SEEN_AT],
      "which succeeds, so the lane drains and the cursor finally advances"
    );
    assert.equal(
      probe.giveUpWrites.at(-1),
      null,
      "and the durable give-up is cleared, not left behind on a healthy lane"
    );
    // Nothing about the give-up survives a lane that answered.
    vi.setSystemTime(ceiling + MINUTE_MS);
    service.refresh();
    await flush();
    assert.equal(probe.sends.length, 3, "drained: nothing left to send");
  });

  test("the lane recovers with NO event at all — time alone re-arms it", async () => {
    // The operator-added door, and the one a laptop that loses access for two
    // days and regains it depends on: no sign-in, no org-policy change, no
    // compute-target switch. Build the event arm alone and this case fails,
    // because nothing here ever calls `noteLaneRecoverySignal` — that absence is
    // the whole assertion, and it is why this case does not touch the service's
    // recovery signal even once.
    let accepted = false;
    const probe = componentLaneProbe(() =>
      accepted ? acceptedResult() : laneFailureResult()
    );
    const service = new AgentSessionSyncService(probe.options);
    const ceiling = await driveToGiveUp(service, probe);

    accepted = true;
    vi.setSystemTime(ceiling + LANE_STALL_MAX_RETRY_MS);
    service.refresh();
    await flush();
    assert.equal(
      probe.sends.length,
      3,
      "the window opened on its own, so the lane attempted again unprompted"
    );
    assert.deepEqual(probe.cursorWrites, [ROW_SEEN_AT], "and it drains");
    assert.equal(
      probe.giveUpWrites.at(-1),
      null,
      "and the durable give-up is cleared once the lane answers"
    );
  });
});
