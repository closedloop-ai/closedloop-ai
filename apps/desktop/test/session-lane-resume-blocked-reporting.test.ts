/**
 * @file session-lane-resume-blocked-reporting.test.ts
 * @description ISS-9823 — the session lane's resume-blocked LEVEL, driven end to
 * end through the real `AgentSessionSyncService`.
 *
 * The device this ticket is about is ALREADY CAUGHT UP. Its outbox is empty, so
 * `pending` is 0 and every count-based signal in the burn-down agrees the lane
 * is `drained` — and the abort is what keeps it that way, because it returns
 * before `enqueueIncrementalUpdates` and no row is ever written. So the only
 * thing that can tell the truth here is in-process state carried out of the
 * hydration, and the assertions below are all made against
 * `classifyLaneDrainState` over a caught-up lane's real counts: the exact
 * population where the old answer was a confident `drained`.
 *
 * THE NEGATIVE CASES ARE THE POINT OF THE SUITE. `hydratePersistedCursor` used
 * to answer one boolean for five conditions in two classes, and three of those
 * five — the adoption discard, the post-`loadSyncState` discard, and the
 * post-retry-state discard — are ordinary identity supersedes that happen on
 * every account and compute-target switch. A level derived from that boolean
 * would report a blocked lane on every sign-in, which trades a missing signal
 * for a false one. Each supersede below is produced by moving the world MID
 * HYDRATION through the real service rather than by calling the latch directly,
 * because a helper-level assertion is green against the collapsed boolean too
 * and proves nothing about the wiring.
 *
 * The positive and recovery cases exist so the negatives cannot pass against a
 * level hard-wired off.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  buildAgentSessionSyncSourceKey,
  type PersistedSyncState,
  type SessionOutboxEngineState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { OutboxResumeOutcome } from "../src/main/agent-sync/session-outbox-engine-state.js";
import { SessionResumeHealth } from "../src/main/agent-sync/session-resume-health.js";
import type { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import {
  classifyLaneDrainState,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
} from "../src/shared/sync-burndown-contract.js";
import { settle } from "./agent-session-sync-service-fixture.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET_A = "resume-blocked-target-a";
const TARGET_B = "resume-blocked-target-b";
const SOURCE_KEY_A = buildAgentSessionSyncSourceKey(TARGET_A);
/** A session the persisted cursor already covers — nothing is owed for it. */
const SETTLED_ID = "already-uploaded";
const TOP_UPDATED_AT = "2026-07-20T00:00:00.000Z";

/**
 * A source whose durable reads can move the world mid-hydration, and whose
 * retry-state read can be made to fail for the first N attempts.
 */
class ScriptedSource extends FakeSyncSource {
  retryStateReads = 0;
  pendingIdsReads = 0;
  syncStateReads = 0;
  /** How many leading retry-state reads throw before the read starts landing. */
  failingRetryStateReads = 0;
  /** How many leading pending-ids reads throw before the read starts landing. */
  failingPendingIdsReads = 0;
  /** How many leading CURSOR reads throw before the read starts landing. */
  failingSyncStateReads = 0;
  /** Runs synchronously before the cursor load resolves. */
  beforeSyncStateLoad: () => void = () => undefined;
  /** Runs synchronously before the pending-ids load resolves. */
  beforePendingIdsLoad: () => void = () => undefined;
  /** Runs synchronously before the retry-budget load resolves. */
  beforeRetryStateLoad: () => void = () => undefined;

  override loadSyncState(
    sourceKey: string
  ): PersistedSyncState | null | Promise<PersistedSyncState | null> {
    this.syncStateReads += 1;
    this.beforeSyncStateLoad();
    if (this.syncStateReads <= this.failingSyncStateReads) {
      // The reachable production fault the module's own comment names: the
      // `sync_state` table transiently unavailable.
      throw new Error("no such table: sync_state");
    }
    return super.loadSyncState(sourceKey);
  }

  override loadPendingOutboxIds(
    sourceKey: string
  ): string[] | Promise<string[]> {
    this.pendingIdsReads += 1;
    this.beforePendingIdsLoad();
    if (this.pendingIdsReads <= this.failingPendingIdsReads) {
      throw new Error("database is locked");
    }
    return super.loadPendingOutboxIds(sourceKey);
  }

  override loadPendingSessionOutboxEngineState(
    sourceKey: string
  ): SessionOutboxEngineState[] | Promise<SessionOutboxEngineState[]> {
    this.retryStateReads += 1;
    this.beforeRetryStateLoad();
    if (this.retryStateReads <= this.failingRetryStateReads) {
      // The reachable production fault: a migration that did not apply leaves
      // this one SELECT erroring on every tick while its siblings on the same
      // table keep working.
      throw new Error("no such column: lane_stalled_since");
    }
    return super.loadPendingSessionOutboxEngineState(sourceKey);
  }
}

/** A caught-up device: cursor persisted, outbox empty, nothing owed. */
function caughtUpSource(): ScriptedSource {
  const source = new ScriptedSource([
    makeSyncedSession(SETTLED_ID, TOP_UPDATED_AT),
  ]);
  source.advanceSyncState(SOURCE_KEY_A, {
    observedTopUpdatedAt: TOP_UPDATED_AT,
    observedIdsAtTopUpdatedAt: [SETTLED_ID],
    deadLetteredIds: [],
  });
  return source;
}

/**
 * What the burn-down says about a caught-up session lane RIGHT NOW.
 *
 * Every count here is the honest one for this device — an empty, fully measured
 * queue with nothing abandoned — so `resumeBlocked` is the only input that can
 * move the answer, which is precisely the claim under test.
 */
function caughtUpLaneState(health: SessionResumeHealth): SyncLaneDrainState {
  return classifyLaneDrainState({
    started: true,
    gateOpen: true,
    resumeBlocked: health.isResumeBlocked(),
    deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    itemsRemaining: 0,
    deadLetteredCount: 0,
    unmeasuredRows: 0,
  });
}

/**
 * The health level plus every outcome the service teed into it, in order.
 *
 * Both are asserted, and the second is what stops the negative cases being
 * vacuous: `isResumeBlocked() === false` is equally true of a tee that never
 * fired, so a case pinned on the level alone would stay green if
 * `onResumeOutcome` were deleted from the service outright.
 */
function makeService(
  source: FakeSyncSource,
  readComputeTarget: () => string | null,
  health: SessionResumeHealth,
  observed: OutboxResumeOutcome[]
): AgentSessionSyncService {
  const sendBatch = (
    _batch: AgentSessionSyncTransportPayload
  ): Promise<
    | { accepted: true }
    | { accepted: false; reason: DesktopAgentSessionsAckReason }
  > => Promise.resolve({ accepted: true });
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: readComputeTarget,
    sendBatch,
    // The production wiring: `desktop-sync-lane-composition.ts` tees this into
    // `syncBurndownReporter.recordSessionResumeOutcome`, which folds it into a
    // `SessionResumeHealth` exactly as this does.
    onResumeOutcome: (outcome) => {
      observed.push(outcome);
      health.record(outcome);
    },
  });
}

test("identity supersede: a COMPUTE-TARGET SWITCH mid-hydration must not report the lane blocked", async () => {
  // The false-alarm case. A bare target flip changes the identity WITHOUT
  // bumping the source-state generation, so `requeueResumeOutboxIds`'s live-key
  // half is what catches it — and before ISS-9823 it answered the same `false`
  // a failed durable read did. Flipping inside the pending-ids load puts the
  // switch exactly where a real account switch lands: across the await.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  let target = TARGET_A;
  const service = makeService(source, () => target, health, observed);
  source.beforePendingIdsLoad = () => {
    target = TARGET_B;
  };

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.Discarded],
    "the hydration was superseded and said so — the tee ran, and reported a race"
  );
  assert.equal(
    health.isResumeBlocked(),
    false,
    "an account switch is not a durable read failing, and must not latch"
  );
  assert.equal(
    caughtUpLaneState(health),
    SyncLaneDrainState.Drained,
    "and the lane still classifies exactly as it did before this ticket"
  );
  service.stop();
});

test("identity supersede: a stop() mid-hydration must not report the lane blocked", async () => {
  // The other half of the supersede class, and it takes a different route: a
  // `stop()` bumps the generation while leaving the compute target alone, so
  // the live-key half above cannot see it and the post-`loadSyncState` discard
  // is what fires. Both must stay silent, and they are separate code paths.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  const service = makeService(source, () => TARGET_A, health, observed);
  source.beforeSyncStateLoad = () => {
    service.stop();
  };

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.Discarded],
    "the post-loadSyncState discard reported a race, not a fault"
  );
  assert.equal(
    health.isResumeBlocked(),
    false,
    "a stopped lane is not a failing lane"
  );
  assert.equal(
    caughtUpLaneState(health),
    SyncLaneDrainState.Drained,
    "and the lane still classifies exactly as it did before this ticket"
  );
  service.stop();
});

test("identity supersede: a stop() during the RETRY-BUDGET read must not report the lane blocked", async () => {
  // The third supersede arm, and the easiest of the three to get wrong: it
  // shares its exit with the two genuine read faults, so mapping that whole
  // exit to `ReadFailed` would raise a false alarm here while mapping it to
  // `Discarded` would silence the real fault the next case asserts.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  const service = makeService(source, () => TARGET_A, health, observed);
  source.beforeRetryStateLoad = () => {
    service.stop();
  };

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.ok(
    source.retryStateReads >= 1,
    "the budget read was actually reached"
  );
  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.Discarded],
    "the arm shared with the two read faults reported a race"
  );
  assert.equal(
    health.isResumeBlocked(),
    false,
    "a budget read DISCARDED by a supersede is not a budget read that failed"
  );
  assert.equal(caughtUpLaneState(health), SyncLaneDrainState.Drained);
  service.stop();
});

test("a supersede that RACES a thrown pending-ids read reports a race, not a fault", async () => {
  // ISS-9823 review. The two failure arms of `requeueResumeOutboxIds` used to
  // answer `ReadFailed` before anything re-checked the identity, so this exact
  // interleaving latched a durable fault against the account the user had just
  // switched TO. It is not a contrived ordering: a compute-target switch tears
  // down the db-host channel the read is parked on, so the switch is a
  // plausible CAUSE of the rejection rather than a coincidence — which is what
  // makes the failure mode "pages on sign-in" rather than "pages rarely".
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  source.failingPendingIdsReads = 1;
  let target = TARGET_A;
  const service = makeService(source, () => target, health, observed);
  source.beforePendingIdsLoad = () => {
    target = TARGET_B;
  };

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(source.pendingIdsReads, 1, "the read ran, and it threw");
  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.Discarded],
    "the identity had already moved, so the throw is a race"
  );
  assert.equal(
    health.isResumeBlocked(),
    false,
    "and no fault is latched against the identity the user just switched to"
  );
  assert.equal(caughtUpLaneState(health), SyncLaneDrainState.Drained);
  service.stop();
});

test("a supersede that RACES a thrown budget read reports a race, not a fault", async () => {
  // The sibling arm, in the file the reporting path shares with it. Its success
  // path has re-checked `isCurrentSourceState()` since ISS-8116 — "a superseded
  // pass is not a read failure" — while its `catch` answered `ReadFailed`
  // unconditionally, so the rule held for a read that RESOLVED and not for the
  // one the supersede broke. A genuine fault is not lost by preferring the
  // benign answer: the read keeps failing, and the next tick re-reads it under
  // a stable identity, which the recovery case below drives.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  source.failingRetryStateReads = 1;
  const service = makeService(source, () => TARGET_A, health, observed);
  source.beforeRetryStateLoad = () => {
    service.stop();
  };

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(source.retryStateReads, 1, "the budget read ran, and it threw");
  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.Discarded],
    "a stop() that races the throw is the supersede, not the fault"
  );
  assert.equal(health.isResumeBlocked(), false);
  assert.equal(caughtUpLaneState(health), SyncLaneDrainState.Drained);
  service.stop();
});

test("a THROWING budget read reports the caught-up lane as remaining_unknown, not drained", async () => {
  // The case that is green today and should not be, and the counterfactual that
  // keeps the three negatives above honest: without it they would all pass
  // against a level that never latches at all.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  source.failingRetryStateReads = 1;
  const service = makeService(source, () => TARGET_A, health, observed);

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.ReadFailed],
    "the same tee that reports a race on a supersede reports a FAULT here"
  );
  assert.equal(
    health.isResumeBlocked(),
    true,
    "a durable read that did not happen is a fault, and the lane is wedged on it"
  );
  assert.equal(
    caughtUpLaneState(health),
    SyncLaneDrainState.RemainingUnknown,
    "the burn-down can no longer report this device as fully synced"
  );
  service.stop();
});

test("a THROWING pending-ids read reports the caught-up lane as remaining_unknown too", async () => {
  // The SECOND fault door, and the one a plausible mapping closes by accident.
  // `requeueResumeOutboxIds` shares ONE exit between its superseded arm and its
  // two failure arms, so answering `Discarded` for a thrown read still abandons
  // the pass, still sends nothing, and still satisfies every assertion that
  // predates this ticket — while the fault silently never latches and the
  // burn-down goes on calling the device fully synced. Nothing but an assertion
  // on the reported LEVEL separates those two, which is why this case exists
  // rather than a second "nothing was sent" one.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  source.failingPendingIdsReads = 1;
  const service = makeService(source, () => TARGET_A, health, observed);

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(source.pendingIdsReads, 1, "the pending-ids read ran");
  assert.equal(
    source.retryStateReads,
    0,
    "and the pass stopped there — this is the prefix read failing, not the budget"
  );
  assert.deepEqual(observed, [OutboxResumeOutcome.ReadFailed]);
  assert.equal(
    health.isResumeBlocked(),
    true,
    "an un-acked prefix that was never re-enqueued is a fault, not an account switch"
  );
  assert.equal(
    caughtUpLaneState(health),
    SyncLaneDrainState.RemainingUnknown,
    "so this device cannot be reported as fully synced either"
  );
  service.stop();
});

test("a THROWING cursor read reports the caught-up lane as remaining_unknown", async () => {
  // ISS-9823 re-review: the THIRD durable read, and the only one that leaves by
  // THROWING rather than by returning an outcome. `hydratePersistedCursor`
  // deliberately does not catch it — the un-hydrated identity is what makes the
  // next tick retry (ISS-8594) — so a tee that only saw returned outcomes
  // reported nothing at all here. On this caught-up device that is the whole
  // defect: the pass aborts before `enqueueIncrementalUpdates`, no outbox row is
  // ever written, `pending` stays 0, and the lane goes on classifying as
  // `drained` while nothing leaves the machine. Same symptom and same cause as
  // the two reads above, from the read neither of them covers.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  source.failingSyncStateReads = 1;
  const service = makeService(source, () => TARGET_A, health, observed);

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(source.syncStateReads, 1, "the cursor read ran, and it threw");
  assert.equal(
    source.pendingIdsReads,
    0,
    "and the pass ended there — this is the cursor read failing, not a later one"
  );
  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.ReadFailed],
    "the throw is reported on its way past, not swallowed and not silent"
  );
  assert.equal(
    health.isResumeBlocked(),
    true,
    "a durable read that did not happen is a fault, whichever exit it took"
  );
  assert.equal(
    caughtUpLaneState(health),
    SyncLaneDrainState.RemainingUnknown,
    "so the burn-down can no longer report this device as fully synced"
  );
  service.stop();
});

test("a supersede that RACES a thrown cursor read reports a race, not a fault", async () => {
  // The reported throw takes the same identity rule the other two reads take. A
  // `stop()` tears down the db-host channel this read is parked on, so it is a
  // plausible CAUSE of the rejection rather than a coincidence, and
  // `hydratePersistedCursor` already answers `Discarded` for this interleaving
  // when the read RESOLVES. Answering the same way when it throws is what stops
  // one await's two exits disagreeing about whether the identity held — and
  // without this case the fix above would be free to page on every sign-in.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  source.failingSyncStateReads = 1;
  const service = makeService(source, () => TARGET_A, health, observed);
  source.beforeSyncStateLoad = () => {
    service.stop();
  };

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(source.syncStateReads, 1, "the cursor read ran, and it threw");
  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.Discarded],
    "a stop() that races the throw is the supersede, not the fault"
  );
  assert.equal(health.isResumeBlocked(), false);
  assert.equal(caughtUpLaneState(health), SyncLaneDrainState.Drained);
  service.stop();
});

test("recovery: a healthy tick after a failed read returns the lane to drained", async () => {
  // A level, not a one-way latch. The failed read re-arms `hydratedSourceKey`,
  // so the full hydration re-runs on the next tick with no timer and no decay —
  // and the `Seeded` it then answers is what clears the level. Asserted on the
  // SECOND tick specifically: a level that could only ever be set would satisfy
  // the case above and fail here.
  const health = new SessionResumeHealth();
  const observed: OutboxResumeOutcome[] = [];
  const source = caughtUpSource();
  source.failingRetryStateReads = 1;
  const service = makeService(source, () => TARGET_A, health, observed);

  service.start({ historicalBackfill: false });
  await settle(service);
  assert.equal(health.isResumeBlocked(), true, "the failing tick latched");

  service.refresh();
  await settle(service);

  assert.ok(
    source.retryStateReads >= 2,
    "the identity was re-armed and the budget read retried"
  );
  assert.deepEqual(
    observed,
    [OutboxResumeOutcome.ReadFailed, OutboxResumeOutcome.Seeded],
    "the fault, then the read that landed — and it is the second that clears"
  );
  assert.equal(
    health.isResumeBlocked(),
    false,
    "the read landed, so the lane is no longer blocked"
  );
  assert.equal(
    caughtUpLaneState(health),
    SyncLaneDrainState.Drained,
    "and a genuinely caught-up device reports caught up again"
  );
  service.stop();
});
