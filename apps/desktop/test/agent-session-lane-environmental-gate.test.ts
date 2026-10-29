/**
 * @file agent-session-lane-environmental-gate.test.ts
 * @description ISS-8610 (PRD-699 F8) coverage for the session lane's three
 * CLOCKLESS environmental defers — `unauthenticated` (401), `target_not_owned`
 * (403) and `transport_unavailable` (no compute target).
 *
 * Each used to re-attempt every 30s with budgets intact, forever, with no
 * terminal path at all. They now share one `LaneEnvironmentalDeferGate`, so they
 * stage off the run's own age and reach a durable give-up that survives a
 * relaunch. Driven through the real `AgentSessionSyncService` rather than the
 * gate, because the thing this ticket added is the WIRING: the gate itself
 * already had its own unit coverage in `lane-environmental-defer.test.ts`, and a
 * suite that drove it directly would stay green if nothing in the session lane
 * ever called it.
 *
 * WHICH SEAM FIRES WHICH DOOR is `sync-lane-kicks.test.ts`; what
 * each door then DOES to the lane is here. The two doors are not the same: a
 * genuine account switch re-arms a give-up, while a routine same-account token
 * renewal ends the pacing window and must not re-arm anything — without that
 * narrow one, moving 401 onto the staged gate would have turned a 30-second
 * token-refresh recovery into a five-minute one with no seam able to shorten it.
 *
 * The last case drops to the fold runners rather than the service, because the
 * service fixture captures its compute target at construction and the behavior
 * under test is what happens when that target CHANGES.
 */
import assert from "node:assert/strict";
import {
  LaneGiveUpSource,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import { SESSION_LANE_STALL_CEILING_MS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { createSessionFoldRunners } from "../src/main/agent-sync/agent-session-sync-fold-runners.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { LANE_STALL_RETRY_FLOOR_MS } from "../src/shared/lane-stall-clock.js";
import { foldRunnerViewStub } from "./agent-session-sync-lane-stall-fixtures.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const NOW_MS = Date.parse("2026-08-03T12:00:00.000Z");
const UPDATED_AT = "2026-06-08T12:00:00.000Z";
/** The flat window all three classes used to re-attempt on, forever. */
const RETIRED_FLAT_WINDOW_MS = 30_000;

function unauthenticatedLane(target: string): {
  service: ReturnType<typeof makeServiceWithIdentity>;
  attempts: () => number;
  source: FakeSyncSource;
} {
  const source = new FakeSyncSource([makeSyncedSession("unauth", UPDATED_AT)]);
  let attempts = 0;
  const service = makeServiceWithIdentity(
    source,
    () => {
      attempts += 1;
      return Promise.resolve({
        accepted: false as const,
        reason: DesktopAgentSessionsAckReason.Unauthenticated,
      });
    },
    target
  );
  return { service, attempts: () => attempts, source };
}

test("ISS-8610: a sustained 401 stages off its run instead of polling flat", async () => {
  const lane = unauthenticatedLane("target-401-stages");

  try {
    await runWithMockedNow(async ({ advance }) => {
      lane.service.start();
      await flushAgentSessionSync();
      assert.equal(lane.attempts(), 1, "the first 401 opens the run");

      advance(RETIRED_FLAT_WINDOW_MS + 1);
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        1,
        "the retired flat 30s window buys nothing: the run opens on the gate's floor"
      );

      advance(LANE_STALL_RETRY_FLOOR_MS);
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "and one elapsed floor buys exactly one more attempt"
      );

      advance(LANE_STALL_RETRY_FLOOR_MS + 1);
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "the ladder STAGED: a second floor no longer clears the second rung"
      );

      advance(LANE_STALL_RETRY_FLOOR_MS);
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        3,
        "which is twice the floor, and it buys the next attempt"
      );
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
});

test("ISS-8610: a recovery signal buys ONE immediate attempt inside the 401 backoff", async () => {
  // The decision that made moving 401/403 off their flat 30s safe. Without this
  // door a user who has just signed in again waits out the current rung — up to
  // five minutes on the first one — for a lane whose blocker demonstrably went.
  const lane = unauthenticatedLane("target-401-rearm");

  try {
    await runWithMockedNow(async () => {
      lane.service.start();
      await flushAgentSessionSync();
      assert.equal(lane.attempts(), 1);

      // The counterfactual, on the same unmoved clock: a refresh alone buys
      // nothing, so the attempt below is the SIGNAL's doing and not the tick's.
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        1,
        "an ordinary tick inside the backoff window attempts nothing"
      );

      lane.service.noteLaneRecoverySignal();
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "a genuine sign-in or org-policy transition buys the attempt immediately"
      );
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
});

test("ISS-8610: a 401 run that outlives the ceiling stamps a durable give-up and stops attempting", async () => {
  const TARGET = "target-401-gives-up";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const lane = unauthenticatedLane(TARGET);

  try {
    await runWithMockedNow(async ({ advance }) => {
      lane.service.start();
      await flushAgentSessionSync();
      // PLN-2028 (ISS-10053): the run's ORIGIN reaches the row on the FIRST
      // failure, and that is the whole point of the durable record. Without it
      // the 24h ceiling lives only in this process, so a desktop restarting
      // inside the outage opens a fresh run on every launch and never reaches
      // the give-up below.
      assert.deepEqual(
        lane.source.laneRunWrites,
        [
          {
            sourceKey: key,
            run: {
              laneStalledSince: new Date(NOW_MS).toISOString(),
              laneGaveUpAt: null,
              laneGaveUpReason: null,
              laneGaveUpSource: null,
            },
          },
        ],
        "a run that has just opened records its origin and has given up on nothing"
      );

      advance(SESSION_LANE_STALL_CEILING_MS + 1);
      lane.service.refresh();
      await flushAgentSessionSync();
      const gaveUpAt = new Date(
        NOW_MS + SESSION_LANE_STALL_CEILING_MS + 1
      ).toISOString();
      assert.equal(
        lane.attempts(),
        2,
        "the attempt that crossed the ceiling still happened"
      );
      assert.deepEqual(
        lane.source.laneRunWrites.at(-1),
        {
          sourceKey: key,
          run: {
            laneStalledSince: new Date(NOW_MS).toISOString(),
            laneGaveUpAt: gaveUpAt,
            // ISS-9963 and ISS-10043: the CAUSE and the PRODUCER ride with the
            // stamp. A bare instant is what left a relaunch announcing "cause
            // UNKNOWN", and what left a per-row ceiling indistinguishable from
            // this lane-wide one.
            laneGaveUpReason: SyncReason.Unauthenticated,
            laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
          },
        },
        "and it stamped the lane-level give-up with its cause and its producer"
      );
      assert.equal(
        lane.source.persistedSyncState(key)?.laneGaveUpAt,
        gaveUpAt,
        "which is what an operator reads, and what a relaunch resumes"
      );

      advance(RETIRED_FLAT_WINDOW_MS + 1);
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "a given-up lane holds: before this ticket it re-attempted every 30s forever"
      );
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
});

test("ISS-8610: an accepted batch ends the environmental RUN, so the next outage opens at the floor", async () => {
  // The clear has to reach the gate and not only the column. A gate left holding
  // the previous outage's origin would read the NEXT outage's opening failure as
  // one already minutes old and hand it a rung it never earned — and, at the far
  // end, a ceiling it never served.
  const TARGET = "target-401-answered";
  const source = new FakeSyncSource([makeSyncedSession("first", UPDATED_AT)]);
  let attempts = 0;
  let rejecting = true;
  const service = makeServiceWithIdentity(
    source,
    () => {
      attempts += 1;
      if (rejecting) {
        return Promise.resolve({
          accepted: false as const,
          reason: DesktopAgentSessionsAckReason.Unauthenticated,
        });
      }
      return Promise.resolve({ accepted: true as const });
    },
    TARGET
  );

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();
      assert.equal(attempts, 1, "the outage opens");

      advance(LANE_STALL_RETRY_FLOOR_MS);
      rejecting = false;
      service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        attempts,
        2,
        "and the elapsed floor buys the attempt that is accepted"
      );

      // A SECOND outage, on a lane the server has since answered.
      rejecting = true;
      source.upsert(makeSyncedSession("second", "2026-06-08T13:00:00.000Z"));
      service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        attempts,
        3,
        "an answered lane is not held, so the new work is attempted"
      );

      advance(LANE_STALL_RETRY_FLOOR_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        attempts,
        4,
        "one floor clears it: the accepted batch ended the run, so this outage opened on rung one rather than inheriting the previous one's age"
      );
    }, NOW_MS);
  } finally {
    service.stop();
  }
});

test("ISS-8610: a held lane does not attempt NEW work either — the gate is the lane's, not one batch's", async () => {
  // The half a per-row deadline cannot express, and the reason the primitive is
  // a LANE gate. A 401 is a fact about the lane, so a session collected while
  // the lane is backing off would otherwise sail straight past the backoff — it
  // carries no deadline of its own — and draw the identical 401. During a long
  // outage that is one request per newly-collected session, which is the shape
  // the whole ticket exists to end.
  const TARGET = "target-401-holds-new-work";
  const lane = unauthenticatedLane(TARGET);

  try {
    await runWithMockedNow(async ({ advance }) => {
      lane.service.start();
      await flushAgentSessionSync();
      assert.equal(lane.attempts(), 1, "the outage opens");

      lane.source.upsert(
        makeSyncedSession("arrived-mid-outage", "2026-06-08T13:00:00.000Z")
      );
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        1,
        "a session collected inside the backoff window is held with the rest of the lane"
      );

      advance(LANE_STALL_RETRY_FLOOR_MS);
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "and rides out on the same elapsed rung, rather than on no clock at all"
      );
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
});

test("ISS-8610: the progress surface reports a lane-deferred row as NOT ready to send", async () => {
  // The gate paces the LANE, but the rows it parked still carry their own
  // deadline, and this is why. `countReadyCandidates` answers "how many queued
  // sessions could the lane send right now" for the renderer's sync indicator,
  // and it answers it from `nextRetryAfterMs` alone — it cannot see a lane-level
  // hold. Dropping the per-row deadline would leave that surface reporting work
  // as ready-to-send while the lane will send none of it.
  const lane = unauthenticatedLane("target-401-progress");

  try {
    await runWithMockedNow(async ({ advance }) => {
      lane.service.start();
      await flushAgentSessionSync();

      advance(RETIRED_FLAT_WINDOW_MS + 1);
      const progress = lane.service.getSyncProgress();
      assert.equal(
        (progress.readyBackfillSessions ?? 0) +
          (progress.readyIncrementalSessions ?? 0),
        0,
        "a row parked by the lane gate reads as deferred, not as ready-to-send"
      );
      assert.equal(
        progress.caughtUp,
        false,
        "and it is still owed — deferred is not delivered"
      );
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
});

test("ISS-8610: a give-up stamp read back on launch is RESUMED by the gate, not just left on the column", async () => {
  // The whole reason the bound is a COLUMN. An in-memory clock restarts on every
  // launch, so a desktop that keeps restarting inside a long outage would never
  // reach the terminal path — the invariant-5 violation the exemption was
  // supposed to avoid.
  //
  // The COLUMN cannot witness this, and that is worth knowing before reaching
  // for it: a resumed lane re-writes the instant it adopted
  // (`SessionLaneRun.noteEnvironmentalOutcome`) while a lane that ignored the
  // stamp and opened a fresh 24h run writes no give-up at all until its own day
  // elapses, so both leave the identical value there. What separates them is what
  // the lane SAYS about itself on its next failure — a resumed lane is already
  // terminal, a reopened one is five minutes into a day — and for this lane that
  // line is the only place a give-up is ever observed (PLN-1961 D-a: no
  // user-facing surface), which is what makes it the contract and not a debug
  // aside.
  // PLN-2028 (ISS-10043): the seeded stamp names its PRODUCER, because only a
  // lane-wide one may be resumed as a gate hold. A stamp with no producer column
  // is a legacy session row, which D3 resolves to the per-row ceiling and which
  // deliberately resumes nothing — that case is its own test in
  // `agent-session-sync-lane-give-up.test.ts`.
  const seededTargets = [
    {
      target: "target-401-resumed",
      laneGaveUpAt: new Date(NOW_MS - 10 * 60_000).toISOString(),
    },
    { target: "target-401-not-resumed", laneGaveUpAt: undefined },
  ] as const;
  const saidGivenUpByTarget = new Map<string, boolean>();

  for (const seeded of seededTargets) {
    const lane = unauthenticatedLane(seeded.target);
    lane.source.seedSyncState(buildAgentSessionSyncSourceKey(seeded.target), {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      ...(seeded.laneGaveUpAt
        ? {
            laneGaveUpAt: seeded.laneGaveUpAt,
            laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
          }
        : {}),
    });
    gatewayLog.clear();
    try {
      await runWithMockedNow(async () => {
        // The first pass is the whole window. This stamp is 10 minutes old,
        // which is PAST the give-up's opening re-arm window, so the launch
        // attempt is the one attempt a re-arm is meant to buy — see the sibling
        // case below for a stamp still inside that window, where the pass is
        // held instead. The gate has adopted by the time this attempt's 401 is
        // folded, which is where the two lanes part company.
        lane.service.start();
        await flushAgentSessionSync();
      }, NOW_MS);
    } finally {
      lane.service.stop();
    }
    saidGivenUpByTarget.set(
      seeded.target,
      gatewayLog
        .getEntries()
        .some((entry) => entry.message.includes("the lane has GIVEN UP"))
    );
    gatewayLog.clear();
  }

  assert.equal(
    saidGivenUpByTarget.get("target-401-not-resumed"),
    false,
    "the control: a lane with nothing on record is five minutes into a fresh run and says so"
  );
  assert.equal(
    saidGivenUpByTarget.get("target-401-resumed"),
    true,
    "and a lane handed a stamp on launch reports itself terminal on its very next failure — it resumed the give-up rather than starting a new day"
  );
});

test("ISS-8610: a restart INSIDE the re-arm window sends nothing, so restarts cannot spend a batch each", async () => {
  // davetho review: the hold is checked at ADMISSION, which runs before
  // hydration has read `lane_gave_up_at` — so on a fresh process the gate held no
  // stamp yet and the pass was let in. One batch per launch is exactly the
  // request storm the durable bound exists to stop, and it is reachable in the
  // case restarts are the symptom of. The pass now re-checks once the stamp is
  // adopted. The sibling case above uses a stamp PAST the re-arm window, where
  // attempting is correct; this one is one minute in, where it is not.
  const TARGET = "target-401-restart-inside-window";
  const lane = unauthenticatedLane(TARGET);
  lane.source.seedSyncState(buildAgentSessionSyncSourceKey(TARGET), {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
    laneGaveUpAt: new Date(NOW_MS - 60_000).toISOString(),
    // PLN-2028 (ISS-10043): a GATE give-up, which is the only producer whose
    // stamp a relaunch resumes as a lane-wide hold.
    laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
  });
  try {
    await runWithMockedNow(async () => {
      lane.service.start();
      await flushAgentSessionSync();
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
  assert.equal(
    lane.attempts(),
    0,
    "a lane still inside its give-up's re-arm window sends nothing on launch"
  );
});

test("ISS-8610: a same-account token renewal ends the 401 pacing window", async () => {
  // The regression this door exists to prevent. A 401 clears when the access
  // token is re-minted, and that renewal is a SAME-account event, so it never
  // reaches `noteLaneRecoverySignal` — which is behind an identity diff on
  // purpose. Without a door of its own, a lane bounced by the gate cannot even
  // mint the token that would release it: it waits out the rung, five minutes on
  // the first one where the retired flat window was thirty seconds.
  const lane = unauthenticatedLane("target-401-renewal");

  try {
    await runWithMockedNow(async () => {
      lane.service.start();
      await flushAgentSessionSync();
      assert.equal(lane.attempts(), 1, "the 401 opens the run");

      // The counterfactual, on an unmoved clock: the tick alone buys nothing, so
      // the attempt below is the RENEWAL's doing.
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        1,
        "an ordinary tick inside the backoff window attempts nothing"
      );

      lane.service.noteCredentialsRefreshed();
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "fresh credentials buy the attempt immediately, as the flat 30s used to"
      );
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
});

test("ISS-8610: a token renewal does NOT re-arm a lane that has GIVEN UP", async () => {
  // The narrowness is the whole point. A renewal is frequent, so if it re-armed
  // the give-up the 24h ceiling would become a function of the refresh cadence —
  // the defect `AuthSessionLaneKicks.noteLaneRecoverySignal` keeps its identity
  // diff to avoid. Pacing yes, terminal no.
  const lane = unauthenticatedLane("target-401-renewal-no-rearm");

  try {
    await runWithMockedNow(async ({ advance }) => {
      lane.service.start();
      await flushAgentSessionSync();

      advance(SESSION_LANE_STALL_CEILING_MS + 1);
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "the run crossed the ceiling and gave up"
      );

      lane.service.noteCredentialsRefreshed();
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        2,
        "a renewal clears the pacing it has a claim on and leaves the give-up standing"
      );

      // ...and the door that IS allowed to re-arm still works, so the case above
      // is not passing because nothing can release this lane any more.
      lane.service.noteLaneRecoverySignal();
      lane.service.refresh();
      await flushAgentSessionSync();
      assert.equal(
        lane.attempts(),
        3,
        "a genuine identity transition still buys the one attempt"
      );
    }, NOW_MS);
  } finally {
    lane.service.stop();
  }
});

test("ISS-8610: a compute-target switch drops the held run instead of inheriting it", () => {
  // A run is one lane's outage and a lane is (account, compute target), so the
  // new target must not serve the old one's sentence (invariant 2). This cannot
  // rely on the pass's own identity reset: that lives in the hydration path, and
  // a held tick is bounced before it. Driven at the fold runners because the
  // service fixture fixes its target at construction.
  const view = foldRunnerViewStub();
  let sourceKey: string | null = "source-a";
  view.sourceKey = () => sourceKey;
  const runners = createSessionFoldRunners(view);

  runners.deferLaneEnvironmental(["s1"], SyncReason.Unauthenticated);
  assert.equal(
    runners.heldEnvironmentally(),
    true,
    "the run it just opened holds its own lane"
  );

  // A key that has merely gone MISSING is not a switch: a dropped socket or a
  // pre-hello tick would otherwise reopen a 24h ceiling from zero on every blip.
  sourceKey = null;
  assert.equal(
    runners.heldEnvironmentally(),
    true,
    "an unresolved key leaves the run alone"
  );

  sourceKey = "source-b";
  assert.equal(
    runners.heldEnvironmentally(),
    false,
    "but a different target is a different lane, and it is not held"
  );
  assert.equal(
    view.nextRetryAfterMs.size,
    0,
    "and the previous identity's deadlines went with the run"
  );
});

test("ISS-8610: a capability renegotiation on the same target does not reopen the run", () => {
  // `sourceKey()` carries the negotiated monitored-activity revision as well as
  // the compute target, so a reconnect that renegotiates that capability changes
  // the KEY without changing the LANE. Tracking the run by the key made every
  // such renegotiation read as a target switch and drop a climbing ceiling —
  // unbounded retry (invariant 5) on a flapping link, which is the hole this
  // gate exists to close.
  const view = foldRunnerViewStub();
  const TARGET = "target-renegotiates";
  let sourceKey: string | null = buildAgentSessionSyncSourceKey(TARGET);
  view.sourceKey = () => sourceKey;
  const runners = createSessionFoldRunners(view);

  runners.deferLaneEnvironmental(["s1"], SyncReason.Unauthenticated);
  assert.equal(
    runners.heldEnvironmentally(),
    true,
    "the run it just opened holds its own lane"
  );

  sourceKey = buildAgentSessionSyncSourceKey(TARGET, true);
  assert.notEqual(
    sourceKey,
    buildAgentSessionSyncSourceKey(TARGET),
    "the renegotiation really does change the source key"
  );
  assert.equal(
    runners.heldEnvironmentally(),
    true,
    "but the same target is the same lane, and the run survives it"
  );
  assert.equal(
    view.nextRetryAfterMs.size,
    1,
    "and the deferral the run is holding survives with it"
  );
});

test("ISS-8610: an identity reset keeps the run across a same-target rekey and drops it across a real switch", () => {
  // `clearSourceDerivedState` — the hydration path's identity reset — compares
  // whole source keys, and the monitored-activity revision is part of that key.
  // Ending the run here on a rekey restarts a climbing 24h ceiling on every
  // capability renegotiation, which is the same hole the hold check avoids by
  // comparing targets. Everything else this reset clears IS payload-derived.
  const view = foldRunnerViewStub();
  const TARGET = "target-rekey-reset";
  let sourceKey: string | null = buildAgentSessionSyncSourceKey(TARGET);
  view.sourceKey = () => sourceKey;
  const runners = createSessionFoldRunners(view);

  const opened = runners.deferLaneEnvironmental(
    ["s1"],
    SyncReason.Unauthenticated
  );
  sourceKey = buildAgentSessionSyncSourceKey(TARGET, true);
  runners.resetForIdentity();
  const afterRekey = runners.deferLaneEnvironmental(
    ["s1"],
    SyncReason.Unauthenticated
  );
  assert.equal(
    afterRekey.opened,
    false,
    "a same-target rekey keeps the open run rather than starting a fresh day"
  );
  assert.equal(
    afterRekey.stalledSinceMs,
    opened.stalledSinceMs,
    "still anchored to the original run's start"
  );

  sourceKey = buildAgentSessionSyncSourceKey("target-rekey-reset-other");
  runners.resetForIdentity();
  const afterSwitch = runners.deferLaneEnvironmental(
    ["s1"],
    SyncReason.Unauthenticated
  );
  assert.equal(
    afterSwitch.opened,
    true,
    "but a genuine target switch still drops the run, so the new lane serves no part of the old one's sentence"
  );
});

test("ISS-8610: a run opened with no compute target releases when one resolves, without reopening the ceiling", () => {
  // `transport_unavailable` defers precisely BECAUSE no target is resolved, so
  // it opens its run with a null identity and the switch arm can never fire for
  // it. A resolved target must end the PACING window — otherwise the lane sits
  // out a rung it no longer owes — while keeping the RUN, because a target that
  // flaps resolved/unresolved would otherwise reopen the 24h ceiling from zero
  // on every blip.
  const view = foldRunnerViewStub();
  let sourceKey: string | null = null;
  view.sourceKey = () => sourceKey;
  const runners = createSessionFoldRunners(view);

  const opened = runners.deferLaneEnvironmental(
    ["s1"],
    SyncReason.Unauthenticated
  );
  assert.equal(
    runners.heldEnvironmentally(),
    true,
    "held while there is no target to send to"
  );

  sourceKey = buildAgentSessionSyncSourceKey("target-resolved");
  assert.equal(
    runners.heldEnvironmentally(),
    false,
    "a resolved target ends the pacing window, so this tick runs"
  );

  const continued = runners.deferLaneEnvironmental(
    ["s1"],
    SyncReason.Unauthenticated
  );
  assert.equal(
    continued.opened,
    false,
    "and the next failure continues the SAME run rather than opening a fresh ceiling"
  );
  assert.equal(
    continued.stalledSinceMs,
    opened.stalledSinceMs,
    "anchored to the original run's start"
  );
});
