/**
 * @file lane-environmental-defer.test.ts
 * @description ISS-8615 (PRD-699 F8): the lane-level environmental defer gate,
 * and the component-inventory lane that adopts it.
 *
 * The gate's own cases pass `nowMs` explicitly — it is a clock, so a test that
 * needed a real one would be testing the wrong thing. The WIRING cases pin the
 * system clock with fake timers, because production reads `Date.now()` and the
 * whole claim being tested is "the next tick does not send". Timers are restored
 * in an unconditional `afterEach`, never at the end of a case: a throw between
 * install and restore leaks a frozen clock into every later suite in the worker
 * and turns one real failure into a file of unrelated red.
 *
 * Every deferral assertion has a positive sibling that proves the lane still
 * sends when the gate is NOT engaged. Without it, a lane broken for some other
 * reason would pass the negative half.
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
import { LANE_STALL_CEILING_MS } from "../src/shared/lane-stall-clock.js";
import {
  batchRejectedResult,
  flush,
  laneFailureResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const MINUTE_MS = 60_000;
const NOW_MS = 1_800_000_000_000;

describe("LaneEnvironmentalDeferGate", () => {
  it("opens a run on the first failure and defers for the ladder floor", () => {
    const gate = new LaneEnvironmentalDeferGate();
    const first = gate.noteEnvironmentalFailure(NOW_MS);
    expect(first.opened).toBe(true);
    expect(first.elapsedMs).toBe(0);
    expect(first.nextAttemptAtMs).toBe(NOW_MS + 5 * MINUTE_MS);
    expect(gate.isDeferred(NOW_MS + 5 * MINUTE_MS - 1)).toBe(true);
    expect(gate.isDeferred(NOW_MS + 5 * MINUTE_MS)).toBe(false);
  });

  it("keeps the ORIGINAL origin across later failures and climbs the ladder", () => {
    // Re-stamping the origin on every failure would hand the run a fresh
    // ceiling forever and pin the ladder to its opening rung — the two defects
    // an anchored clock exists to prevent.
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);
    const later = gate.noteEnvironmentalFailure(NOW_MS + 20 * MINUTE_MS);
    expect(later.opened).toBe(false);
    expect(later.stalledSinceMs).toBe(NOW_MS);
    expect(later.elapsedMs).toBe(20 * MINUTE_MS);
    expect(later.nextAttemptAtMs).toBe(NOW_MS + 40 * MINUTE_MS);
  });

  it("ends the run when the lane is ANSWERED, and starts the next one fresh", () => {
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);
    gate.noteLaneAnswered();
    expect(gate.isDeferred(NOW_MS + 1)).toBe(false);
    expect(gate.stallAgeMs(NOW_MS + 1)).toBe(null);
    const reopened = gate.noteEnvironmentalFailure(NOW_MS + MINUTE_MS);
    expect(reopened.opened).toBe(true);
    expect(reopened.nextAttemptAtMs).toBe(NOW_MS + 6 * MINUTE_MS);
  });

  it("reports no stall age at all rather than a fabricated zero", () => {
    const gate = new LaneEnvironmentalDeferGate();
    expect(gate.stallAgeMs(NOW_MS)).toBe(null);
    gate.noteEnvironmentalFailure(NOW_MS);
    expect(gate.stallAgeMs(NOW_MS + MINUTE_MS)).toBe(MINUTE_MS);
  });

  it("honors a server Retry-After longer than the rung it had chosen", () => {
    const gate = new LaneEnvironmentalDeferGate();
    const deferred = gate.noteEnvironmentalFailure(NOW_MS, 45 * MINUTE_MS);
    expect(deferred.nextAttemptAtMs).toBe(NOW_MS + 45 * MINUTE_MS);
  });

  it("drops the run on reset, so a new identity inherits no backoff", () => {
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);
    expect(gate.isDeferred(NOW_MS + MINUTE_MS)).toBe(true);
    gate.reset();
    expect(gate.isDeferred(NOW_MS + MINUTE_MS)).toBe(false);
  });
});

/** A component-lane fixture whose `sendComponents` outcome the case chooses. */
function componentLaneOptions(
  outcomes: () => ReturnType<typeof laneFailureResult>,
  sends: string[][]
): AgentSessionSyncServiceOptions {
  const rows: AgentComponentCursorRow[] = [
    { id: "a", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  return {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => "target-environmental-defer",
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
      Promise.resolve(
        ids.map((id) => syncedFor(id, "2026-07-20T10:00:00.000Z"))
      ),
    sendComponents: (payload) => {
      sends.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(outcomes());
    },
  };
}

describe("LaneEnvironmentalDeferGate.hydrateRun (PLN-2028 / ISS-10053)", () => {
  it("CONTINUES the resumed run instead of opening a new one", () => {
    // The origin is what a relaunch could not previously recover. `opened: false`
    // with a real elapsed reading is what ONLY a resumed origin produces — a gate
    // that adopted nothing reports `opened: true` and zero, which is the state
    // that made a give-up announce "after 0min" for a day-old outage.
    const gate = new LaneEnvironmentalDeferGate();
    const openedAtMs = NOW_MS - 90 * MINUTE_MS;

    gate.hydrateRun({ stalledSinceMs: openedAtMs, gaveUpAtMs: null }, NOW_MS);

    expect(gate.runOriginMs()).toBe(openedAtMs);
    const next = gate.noteEnvironmentalFailure(NOW_MS);
    expect(next.opened).toBe(false);
    expect(next.elapsedMs).toBe(90 * MINUTE_MS);
  });

  it("gives up on the next failure when the resumed run is already past the ceiling", () => {
    // ISS-10053 in one assertion: this process has been up for no time at all,
    // so nothing but the resumed origin can carry the run past 24h. An install
    // that keeps restarting inside an outage reaches the terminal path only here.
    const gate = new LaneEnvironmentalDeferGate();

    gate.hydrateRun(
      {
        stalledSinceMs: NOW_MS - LANE_STALL_CEILING_MS - MINUTE_MS,
        gaveUpAtMs: null,
      },
      NOW_MS
    );

    expect(gate.noteEnvironmentalFailure(NOW_MS).givenUp).toBe(true);
  });

  it("D4: ignores the row when this process already holds a run", () => {
    // The row can only EQUAL what this process knows or LAG it by a dropped
    // write, so adopting it over a live run would move the ceiling backwards on
    // a lane that is currently failing — and resurrect a give-up this process
    // has already seen cleared.
    const gate = new LaneEnvironmentalDeferGate();
    gate.noteEnvironmentalFailure(NOW_MS);

    gate.hydrateRun(
      {
        stalledSinceMs: NOW_MS - LANE_STALL_CEILING_MS,
        gaveUpAtMs: NOW_MS - MINUTE_MS,
      },
      NOW_MS
    );

    expect(gate.runOriginMs()).toBe(NOW_MS);
    expect(gate.giveUpStampMs()).toBe(null);
  });

  it("CLAMPS a future origin, so the ceiling measures from a real instant", () => {
    // A corrupt row or a backwards clock jump. Adopted verbatim the run ages
    // against an anchor that moves with the clock, so it never reaches the
    // ceiling at all — the bound removed by arithmetic rather than by omission.
    const gate = new LaneEnvironmentalDeferGate();

    gate.hydrateRun(
      { stalledSinceMs: NOW_MS + 90 * 24 * 60 * MINUTE_MS, gaveUpAtMs: null },
      NOW_MS
    );

    expect(gate.runOriginMs()).toBe(NOW_MS);
    expect(gate.noteEnvironmentalFailure(NOW_MS).elapsedMs).toBe(0);
  });

  it("opens a FRESH run when the row carries no readable origin", () => {
    // What `readLaneRunRecord` hands back for an unreadable column. It is not
    // evidence that anything waited, so the lane opens its own run rather than
    // giving up on a duration it cannot substantiate.
    const gate = new LaneEnvironmentalDeferGate();

    gate.hydrateRun({ stalledSinceMs: null, gaveUpAtMs: null }, NOW_MS);

    expect(gate.runOriginMs()).toBe(null);
    const opened = gate.noteEnvironmentalFailure(NOW_MS);
    expect(opened.opened).toBe(true);
    expect(opened.givenUp).toBe(false);
  });
});

describe("component-inventory lane adopts the gate (PRD-699 F8)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
  });

  test("a LaneFailure holds the next tick instead of re-sending the same batch", async () => {
    const sends: string[][] = [];
    const service = new AgentSessionSyncService(
      componentLaneOptions(laneFailureResult, sends)
    );

    service.start();
    await flush();
    assert.equal(sends.length, 1, "the first tick sends once");

    // Before the fix this tick re-sent the identical batch, and did so every 5s
    // for as long as the outage lasted.
    service.refresh();
    await flush();
    assert.equal(sends.length, 1, "the next tick is held by the backoff");

    // ...and it is a BACKOFF, not a permanent stop: the ladder's opening rung
    // is five minutes, so the lane sends again once that has passed.
    vi.setSystemTime(NOW_MS + 5 * MINUTE_MS);
    service.refresh();
    await flush();
    assert.equal(sends.length, 2, "the lane resumes once the rung elapses");
  });

  test("ISS-9698: a LaneFailure's Retry-After holds the lane past the staged rung", async () => {
    // The case that PROVES the plumbing. A server minimum SHORTER than the
    // staged rung is indistinguishable from ignoring the header entirely, so
    // only a longer one can fail if the value is dropped anywhere between the
    // response and `noteEnvironmentalFailure`. The sibling above — the same lane
    // with no hint at all — is what shows five minutes is the unhinted answer.
    const sends: string[][] = [];
    const service = new AgentSessionSyncService(
      componentLaneOptions(
        () => ({ ...laneFailureResult(), retryAfterMs: 30 * MINUTE_MS }),
        sends
      )
    );

    service.start();
    await flush();
    assert.equal(sends.length, 1, "the first tick sends once");

    vi.setSystemTime(NOW_MS + 29 * MINUTE_MS);
    service.refresh();
    await flush();
    assert.equal(
      sends.length,
      1,
      "the lane is STILL held at 29 minutes — the staged five-minute rung would have released it at 5"
    );

    vi.setSystemTime(NOW_MS + 31 * MINUTE_MS);
    service.refresh();
    await flush();
    assert.equal(
      sends.length,
      2,
      "and it resumes once the wait the server actually asked for has elapsed"
    );
  });

  test("the DRAINED-cursor dead-letter recovery send charges the clock too", async () => {
    // On a caught-up install the recovery send is the ONLY send this lane makes,
    // and it never reaches `applySendOutcome` — so gating the tick alone left the
    // gate permanently un-armed there and an outage kept hammering every 5s,
    // which is the exact behaviour the gate exists to end.
    const sends: string[][] = [];
    const persisted: PersistedSyncState = {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: ["stranded"],
    };
    const source: Pick<
      AgentSessionSyncSource,
      "loadSyncState" | "advanceSyncState"
    > = {
      loadSyncState: () => persisted,
      advanceSyncState: () => undefined,
    };
    const service = new AgentSessionSyncService({
      isHttpReady: () => true,
      // Single test-local cast, matching the sibling cold-restart suite: the
      // component lane exercises only these two source methods.
      getSource: () => source as AgentSessionSyncSource,
      getSyncComputeTargetId: () => "target-recovery-defer",
      sendBatch: () => Promise.resolve({ accepted: true }),
      // Drained: nothing newer than the cursor, so run() takes the recovery arm.
      listComponentCursorRows: () => Promise.resolve([]),
      loadComponentRows: (ids) =>
        Promise.resolve(
          ids.map((id) => syncedFor(id, "2026-07-20T10:00:00.000Z"))
        ),
      sendComponents: (payload) => {
        sends.push(payload.components.map((c) => c.externalId));
        return Promise.resolve(laneFailureResult());
      },
    });

    service.start();
    await flush();
    assert.equal(sends.length, 1, "the recovery pass attempts the stranded id");

    service.refresh();
    await flush();
    assert.equal(sends.length, 1, "and the next tick is held by the backoff");
  });

  test("a recovery send that THROWS charges the clock before it is swallowed", async () => {
    // ISS-8615 (whitlockk / marisolashgrove review). `recoverComponentDeadLetters`
    // catches a rejected `sendComponents` itself and keeps the ids due, so a
    // charge placed after the await never runs: a caught-up install with
    // recovery-only work re-threw a transport failure every 5s forever.
    const attempts: string[][] = [];
    const persisted: PersistedSyncState = {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: ["stranded"],
    };
    const source: Pick<
      AgentSessionSyncSource,
      "loadSyncState" | "advanceSyncState"
    > = {
      loadSyncState: () => persisted,
      advanceSyncState: () => undefined,
    };
    const service = new AgentSessionSyncService({
      isHttpReady: () => true,
      getSource: () => source as AgentSessionSyncSource,
      getSyncComputeTargetId: () => "target-recovery-throw",
      sendBatch: () => Promise.resolve({ accepted: true }),
      listComponentCursorRows: () => Promise.resolve([]),
      loadComponentRows: (ids) =>
        Promise.resolve(
          ids.map((id) => syncedFor(id, "2026-07-20T10:00:00.000Z"))
        ),
      sendComponents: (payload) => {
        attempts.push(payload.components.map((c) => c.externalId));
        return Promise.reject(new Error("socket hung up"));
      },
    });

    service.start();
    await flush();
    assert.equal(
      attempts.length,
      1,
      "the recovery pass attempts the stranded id"
    );

    service.refresh();
    await flush();
    assert.equal(
      attempts.length,
      1,
      "and the thrown failure held the next tick"
    );

    // A backoff, not a stop — the positive half, so a lane broken for any other
    // reason cannot pass the assertion above.
    vi.setSystemTime(NOW_MS + 5 * MINUTE_MS);
    service.refresh();
    await flush();
    assert.equal(attempts.length, 2, "the lane resumes once the rung elapses");
  });

  test("a drained pass that owes NOTHING ends the run instead of carrying it", async () => {
    // ISS-8615 (marisolashgrove review). A drained cursor with no due dead letters
    // answers nothing, so a healed outage's origin used to ride along for the
    // life of the process — and an isolated failure hours later read its elapsed
    // off that origin and parked the lane on a rung it never climbed.
    const persisted: PersistedSyncState = {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
    };
    const source: Pick<
      AgentSessionSyncSource,
      "loadSyncState" | "advanceSyncState"
    > = {
      loadSyncState: () => persisted,
      advanceSyncState: () => undefined,
    };
    const sends: string[][] = [];
    let drained = false;
    const service = new AgentSessionSyncService({
      isHttpReady: () => true,
      getSource: () => source as AgentSessionSyncSource,
      getSyncComputeTargetId: () => "target-drained-clear",
      sendBatch: () => Promise.resolve({ accepted: true }),
      // One row on the first tick (which fails lane-wide and opens the run),
      // then drained — the steady state whose empty pass must clear it.
      listComponentCursorRows: () =>
        Promise.resolve(
          drained ? [] : [{ id: "a", last_seen_at: "2026-07-20T10:00:00.000Z" }]
        ),
      loadComponentRows: (ids) =>
        Promise.resolve(
          ids.map((id) => syncedFor(id, "2026-07-20T10:00:00.000Z"))
        ),
      sendComponents: (payload) => {
        sends.push(payload.components.map((c) => c.externalId));
        return Promise.resolve(laneFailureResult());
      },
    });

    service.start();
    await flush();
    assert.equal(sends.length, 1, "the first tick opens an environmental run");

    // The outage heals and the lane drains. Past the opening rung so the pass
    // actually runs rather than being held by the very backoff under test.
    drained = true;
    vi.setSystemTime(NOW_MS + 6 * MINUTE_MS);
    service.refresh();
    await flush();

    // The run is gone, so a fresh failure gets the ladder FLOOR: one more tick
    // 5 minutes on gets to send. Carrying the origin would have put the lane on
    // a much higher rung and held this send back.
    drained = false;
    vi.setSystemTime(NOW_MS + 11 * MINUTE_MS + 1);
    service.refresh();
    await flush();
    assert.equal(sends.length, 2, "a cleared run leaves the lane free to send");
    vi.setSystemTime(NOW_MS + 16 * MINUTE_MS + 2);
    service.refresh();
    await flush();
    assert.equal(
      sends.length,
      3,
      "and the reopened run is on the floor rung, not an inherited one"
    );
  });

  test("a send that throws AFTER an identity switch charges nobody's gate", async () => {
    // ISS-8615 (marisolashgrove review): the throw-charge sits behind the same
    // identity re-check `applySendOutcome` does. Unguarded, a send resolving
    // after `resetSourceState()` opened a run on the FRESH gate, and the new
    // compute target served out five minutes for a failure it never saw
    // (`main/sync/AGENTS.md` invariant 2).
    const sends: string[][] = [];
    let target: string | null = "target-before-switch";
    const service = new AgentSessionSyncService({
      isHttpReady: () => true,
      getSource: () => null,
      getSyncComputeTargetId: () => target,
      sendBatch: () => Promise.resolve({ accepted: true }),
      listComponentCursorRows: (sinceTs, sinceId) =>
        Promise.resolve(
          [{ id: "a", last_seen_at: "2026-07-20T10:00:00.000Z" }].filter(
            (r) =>
              r.last_seen_at > sinceTs ||
              (r.last_seen_at === sinceTs && r.id > sinceId)
          )
        ),
      loadComponentRows: (ids) =>
        Promise.resolve(
          ids.map((id) => syncedFor(id, "2026-07-20T10:00:00.000Z"))
        ),
      sendComponents: (payload) => {
        sends.push(payload.components.map((c) => c.externalId));
        // The switch lands mid-flight, then the socket drops. Both halves are
        // needed: a throw alone would legitimately charge this lane's own gate.
        if (sends.length === 1) {
          target = "target-after-switch";
          return Promise.reject(new Error("socket hung up"));
        }
        return Promise.resolve(batchRejectedResult());
      },
    });

    service.start();
    await flush();
    assert.equal(sends.length, 1, "the superseded run reached the transport");

    // The new target owns the lane now, and it is owed the cursor's row. A gate
    // charged by the run it superseded would hold this send for five minutes.
    service.refresh();
    await flush();
    assert.equal(
      sends.length,
      2,
      "the new identity sends immediately rather than serving the old run"
    );
  });

  test("a BatchRejected leaves the lane free to retry on the very next tick", async () => {
    // The positive sibling. A server that judged the batch ANSWERED, so no
    // environmental run opens and nothing is held — which is what proves the
    // case above is the gate and not some unrelated stall.
    const sends: string[][] = [];
    const service = new AgentSessionSyncService(
      componentLaneOptions(batchRejectedResult, sends)
    );

    service.start();
    await flush();
    assert.equal(sends.length, 1);

    service.refresh();
    await flush();
    assert.equal(sends.length, 2, "an answered lane keeps its 5s cadence");
  });
});
