import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import type { BoundedFailureFoldConfig } from "../src/main/agent-sync/agent-session-sync-ack-fold.js";
import { SessionEnvironmentalDeferClass } from "../src/main/agent-sync/agent-session-sync-lane-stall-fold.js";
import {
  dispatchRejectedAck,
  type RejectedAckDispatchDeps,
  type RejectedAgentSessionsAck,
} from "../src/main/agent-sync/agent-session-sync-rejection-dispatch.js";
import {
  DesktopAgentSessionsAckReason,
  type DesktopAgentSessionsAckReason as DesktopAgentSessionsAckReasonType,
  UNKNOWN_ACK_REASON,
} from "../src/main/cloud/cloud-protocol.js";

test("dispatchRejectedAck routes every declared reason to its required collaborators", async () => {
  for (const reason of Object.values(DesktopAgentSessionsAckReason)) {
    const harness = createHarness();

    await dispatchRejectedAck(
      {
        ack: { accepted: false, reason },
        ids: [sessionId],
        syncMode: AgentSessionSyncMode.Incremental,
        payloadBytes: 1024,
        multiPartEnvelope: false,
      },
      harness.deps
    );

    const expected = expectationFor(reason);
    assert.deepEqual(harness.calls.order, expected.order, reason);
    assert.deepEqual(harness.calls.foldReasons, expected.foldReasons, reason);
    assert.deepEqual(
      harness.calls.laneStallClasses,
      expected.laneStallClasses,
      reason
    );
    // ISS-8610: WHICH ids the lane-wide fold was handed, not merely that it ran.
    // The gate paces the whole lane, so a dispatch that handed it the wrong ids
    // — or none — passes every timing assertion above while the rows quietly
    // lose the deadline the progress surface reads.
    assert.deepEqual(
      harness.calls.laneDeferredIds,
      expected.laneDeferredIds,
      reason
    );
    assert.deepEqual(harness.counterSnapshot(), expected.counters, reason);
  }
});

/**
 * ISS-8595 — BEHAVIOUR CHANGE, not a weakened expectation. This test previously
 * asserted the old contract ("logs at debug and returns"), which was the defect:
 * the batch was left queued with NO retry deadline, so the 5s tick re-sent it
 * immediately and forever against a server already refusing it. The expectation
 * changed because the behaviour deliberately changed in this diff; the ONE thing
 * the old test proved that still holds — no budget is charged — is asserted
 * below, and strengthened from a snapshot into a named terminal-path claim.
 *
 * ISS-8605 (whitlockk review): and it reaches the branch through a REAL value, not a
 * cast. `UNKNOWN_ACK_REASON` is what the HTTP transport resolves a version-skewed
 * rejection to — `desktop-agent-sessions-client.test.ts` covers that half — so
 * this is the ack production actually delivers here. The cast this test used to
 * need was the tell that nothing else could produce one.
 */
test("ISS-8595: an ack reason this build cannot name defers as environmental, with budgets intact", async () => {
  const harness = createHarness();
  const ack: RejectedAgentSessionsAck = {
    accepted: false,
    reason: UNKNOWN_ACK_REASON,
    unrecognizedReason: futureAckReason,
  };

  await dispatchRejectedAck(
    {
      ack,
      ids: [sessionId],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      multiPartEnvelope: false,
    },
    harness.deps
  );

  assert.deepEqual(
    harness.calls.order,
    [DispatchCollaborator.LogWarn, DispatchCollaborator.ApplyLaneStallFold],
    "an unknown reason is folded, not merely logged — logging and returning is the hot-retry defect"
  );
  assert.deepEqual(
    harness.calls.laneStallClasses,
    [SessionEnvironmentalDeferClass.UnknownAckReason],
    "and it is folded as the UNKNOWN class, so its evidence is not filed under another reason's tally"
  );
  assert.deepEqual(
    harness.calls.laneStallSettled,
    [SessionEnvironmentalDeferClass.UnknownAckReason],
    "and the dispatch waited for that fold — its durable stall clock is this class's only terminal bound"
  );
  assert.ok(
    harness.calls.warnMessages[0]?.includes(futureAckReason),
    "the reason the PEER used is still named in the log, though the classification is a fixed spelling"
  );
  assert.deepEqual(
    harness.counterSnapshot(),
    emptyCounterSnapshot(),
    "and no row budget is charged for a reason this build cannot even classify"
  );
});

/**
 * The second line, and a DIFFERENT branch from the one above: the `never`
 * fallthrough that catches an ack which reached the service without passing the
 * transport that resolves skew (an injected `sendBatch`, a future transport).
 * Reachable only by a cast, which is the honest signal that nothing production
 * wires can produce it — the typed path above is what covers real skew.
 */
test("ISS-8595: an ack that bypassed the transport's resolution still degrades to the same safe default", async () => {
  const harness = createHarness();
  const ack = {
    accepted: false,
    reason: futureAckReason,
  } as unknown as RejectedAgentSessionsAck;

  await dispatchRejectedAck(
    {
      ack,
      ids: [sessionId],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      multiPartEnvelope: false,
    },
    harness.deps
  );

  assert.deepEqual(harness.calls.order, [
    DispatchCollaborator.LogWarn,
    DispatchCollaborator.ApplyLaneStallFold,
  ]);
  assert.deepEqual(harness.calls.laneStallClasses, [
    SessionEnvironmentalDeferClass.UnknownAckReason,
  ]);
  assert.deepEqual(
    harness.counterSnapshot(),
    emptyCounterSnapshot(),
    "it must never throw and never charge a row — the fallthrough is a degrade, not a trap"
  );
});

test("ISS-8595: a KNOWN reason is unaffected by the unknown-reason fallback", async () => {
  // The regression half. A fallback that swallowed everything would satisfy the
  // test above while silently rerouting `validation_failed` — the one class that
  // genuinely IS the row's fault — away from its bounded fold.
  const harness = createHarness();

  await dispatchRejectedAck(
    {
      ack: {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      },
      ids: [sessionId],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      multiPartEnvelope: false,
    },
    harness.deps
  );

  assert.deepEqual(harness.calls.order, [
    DispatchCollaborator.NoteLaneAnswered,
    DispatchCollaborator.ApplyBoundedFold,
  ]);
  assert.deepEqual(
    harness.calls.laneStallClasses,
    [],
    "a row-attributable rejection never reaches the environmental fold"
  );
  assert.equal(
    harness.counterSnapshot().validationFailed,
    1,
    "and it still charges the budget it is supposed to charge"
  );
});

test("ISS-10014: a Retry-After on the ack reaches the fold that can honor it", async () => {
  const harness = createHarness();

  await dispatchRejectedAck(
    {
      ack: {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.RateLimited,
        retryAfterMs: 600_000,
      },
      ids: [sessionId],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      multiPartEnvelope: false,
    },
    harness.deps
  );

  // The transport parses the header and the fold paces the row by it, but
  // between them sits this dispatch — and a hint dropped HERE is invisible to
  // both of those suites, which is exactly the seam that leaves the whole
  // feature inert while every other test stays green.
  assert.deepEqual(
    harness.calls.laneStallRetryAfters,
    [600_000],
    "the wait the server asked for is handed to the fold, not dropped in the hop that connects them"
  );
});

test("ISS-10014: a Retry-After on a lane-gate reason reaches the gate, not only the stall fold", async () => {
  const harness = createHarness();

  await dispatchRejectedAck(
    {
      ack: {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.TargetNotOwned,
        retryAfterMs: 3_600_000,
      },
      ids: [sessionId],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      multiPartEnvelope: false,
    },
    harness.deps
  );

  // A 403 is Appendix A ENVIRONMENTAL and routes to the lane gate, whose own
  // ladder opens at the 5-minute floor: a dropped hint here would retry a
  // dozen times into the hour the server asked for.
  assert.deepEqual(
    harness.calls.laneDeferRetryAfters,
    [3_600_000],
    "the wait the server asked for is handed to the lane gate"
  );
});

test("ISS-10014: an ack with no hint hands the fold no wait at all", async () => {
  const harness = createHarness();

  await dispatchRejectedAck(
    {
      ack: {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.RateLimited,
      },
      ids: [sessionId],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      multiPartEnvelope: false,
    },
    harness.deps
  );

  assert.deepEqual(
    harness.calls.laneStallRetryAfters,
    [ABSENT_RETRY_AFTER],
    "an older cloud sends no header, and the dispatch must pass that absence through as an absence rather than manufacture a wait of zero"
  );
});

/**
 * ISS-10014 (whitlockk review) — the class gate, asserted from its NEGATIVE side.
 *
 * The transport reads `Retry-After` off every rejection, so a permanently-bad
 * request now arrives here carrying a wait. This dispatch is the only thing that
 * keeps that wait off the lane, and it does it by branch ORDER: both terminal
 * classes return before any honoring collaborator is reached. Nothing else pins
 * that — the reason-routing sweep above builds its acks WITHOUT a hint, so a
 * future widening that forwarded one on these two classes would leave it green
 * while a 400 held the session queue open for as long as the server asked.
 *
 * Both classes in one case because they share the one property under test: a
 * wait fixes neither, so neither may spend one.
 */
test("ISS-10014: a hint on a class a wait cannot fix holds nothing at all", async () => {
  for (const reason of [
    DesktopAgentSessionsAckReason.ValidationFailed,
    DesktopAgentSessionsAckReason.FeatureDisabled,
  ]) {
    const harness = createHarness();

    await dispatchRejectedAck(
      {
        ack: { accepted: false, reason, retryAfterMs: 600_000 },
        ids: [sessionId],
        syncMode: AgentSessionSyncMode.Incremental,
        payloadBytes: 1024,
        multiPartEnvelope: false,
      },
      harness.deps
    );

    assert.deepEqual(
      harness.calls.laneStallRetryAfters,
      [],
      `${reason}: a rejection the row itself caused must never reach the stall fold, hint or no hint`
    );
    assert.deepEqual(
      harness.calls.laneDeferRetryAfters,
      [],
      `${reason}: nor the lane gate — a bad request carrying Retry-After must not hold the session queue open`
    );
  }
});

/**
 * PLN-2028 (ISS-9963) — each lane-wide class names its OWN cause.
 *
 * The cause is what the durable `lane_gave_up_reason` column records beside the
 * give-up, so it is what a process relaunching inside the same outage announces
 * instead of "cause UNKNOWN". Asserted per class rather than once: the three
 * share one gate and one column, so a dispatch that passed a single constant
 * would be green on any one of them and would tell an operator to go and look at
 * the wrong precondition.
 */
test("PLN-2028: each lane-wide environmental class defers with its own cause", async () => {
  const expectedReasons: [DesktopAgentSessionsAckReasonType, SyncReason][] = [
    [DesktopAgentSessionsAckReason.Unauthenticated, SyncReason.Unauthenticated],
    [DesktopAgentSessionsAckReason.TargetNotOwned, SyncReason.TargetNotOwned],
    [
      DesktopAgentSessionsAckReason.TransportUnavailable,
      SyncReason.TransportUnavailable,
    ],
  ];

  for (const [ackReason, expected] of expectedReasons) {
    const harness = createHarness();

    await dispatchRejectedAck(
      {
        ack: { accepted: false, reason: ackReason },
        ids: [sessionId],
        syncMode: AgentSessionSyncMode.Incremental,
        payloadBytes: 1024,
        multiPartEnvelope: false,
      },
      harness.deps
    );

    assert.deepEqual(
      harness.calls.laneDeferReasons,
      [expected],
      `${ackReason} must defer with its own cause, not a shared placeholder`
    );
  }
});

function createHarness(): Harness {
  const validationFailedCountById = new Map<string, number>();
  const transportTimeoutCountById = new Map<string, number>();
  /*
   * Keyed by fold REASON, not by counter-map identity, and that is the whole
   * point. `ack_timeout` no longer has a per-row counter for the dispatch to
   * pass, so a map-identity snapshot of it could never move and the
   * "no budget is charged" assertions below would hold against ANY
   * implementation. Counting bounded-fold entries by reason instead means the
   * ackTimeout slot goes to 1 the moment `AckTimeout` reaches a bounded fold
   * again, whichever counter that fold is handed.
   */
  const boundedFoldCountsByReason = new Map<string, number>();
  const calls: RecordedCalls = {
    laneDeferredIds: [],
    laneDeferReasons: [],
    order: [],
    foldReasons: [],
    laneStallClasses: [],
    laneStallSettled: [],
    laneStallRetryAfters: [],
    laneDeferRetryAfters: [],
    warnMessages: [],
  };
  const deps: RejectedAckDispatchDeps = {
    nextRetryAfterMs: new Map(),
    applyBoundedFold: (config) => {
      calls.order.push(DispatchCollaborator.ApplyBoundedFold);
      calls.foldReasons.push(config.reason);
      increment(config.counter, sessionId);
      increment(boundedFoldCountsByReason, config.reason);
    },
    // ISS-8710: the dispatch now takes the shared `validation_failed`
    // collaborator instead of assembling one from four loose members.
    validationFailureDeps: () => ({
      counter: validationFailedCountById,
      recoverableDeadLetterCountFor: () => 0,
      markForBisection: () => undefined,
      clearBisectionFlag: () => undefined,
      applyBoundedFold: (config) => {
        calls.order.push(DispatchCollaborator.ApplyBoundedFold);
        calls.foldReasons.push(config.reason);
        increment(config.counter, sessionId);
      },
      logInfo: () => undefined,
      formatBytes: (bytes) => String(bytes),
    }),
    applyLaneStallFold: (input) => {
      calls.order.push(DispatchCollaborator.ApplyLaneStallFold);
      calls.laneStallClasses.push(input.deferClass);
      calls.laneStallRetryAfters.push(input.retryAfterMs ?? ABSENT_RETRY_AFTER);
      // ISS-8605: settles a microtask LATER, and records that it did. The fold's
      // durable stall write is the environmental classes' only terminal bound,
      // so "the dispatch waited for it" has to be assertable — a fold that
      // resolved synchronously would look identical to one nobody awaited.
      return Promise.resolve().then(() => {
        calls.laneStallSettled.push(input.deferClass);
      });
    },
    transportTimeoutFoldPolicy: () => {
      calls.order.push(DispatchCollaborator.TransportTimeoutFoldPolicy);
      return transportTimeoutFoldPolicy(transportTimeoutCountById);
    },
    deferLaneEnvironmental: (ids, reason, retryAfterMs) => {
      calls.order.push(DispatchCollaborator.DeferLaneEnvironmental);
      calls.laneDeferredIds.push(...ids);
      calls.laneDeferReasons.push(reason);
      calls.laneDeferRetryAfters.push(retryAfterMs ?? ABSENT_RETRY_AFTER);
      return {
        stalledSinceMs: 0,
        elapsedMs: 0,
        nextAttemptAtMs: 0,
        opened: true,
        givenUp: false,
        gaveUpAtMs: null,
      };
    },
    noteLaneAnswered: () => {
      calls.order.push(DispatchCollaborator.NoteLaneAnswered);
    },
    noteTransportLoss: () => {
      calls.order.push(DispatchCollaborator.NoteTransportLoss);
    },
    pauseForFeatureDisabled: () => {
      calls.order.push(DispatchCollaborator.PauseForFeatureDisabled);
    },
    logInfo: () => {
      calls.order.push(DispatchCollaborator.LogInfo);
    },
    logWarn: (message) => {
      calls.order.push(DispatchCollaborator.LogWarn);
      calls.warnMessages.push(message);
    },
  };

  return {
    deps,
    calls,
    counterSnapshot: () => ({
      validationFailed: validationFailedCountById.get(sessionId) ?? 0,
      ackTimeout:
        boundedFoldCountsByReason.get(
          DesktopAgentSessionsAckReason.AckTimeout
        ) ?? 0,
      transportTimeout: transportTimeoutCountById.get(sessionId) ?? 0,
    }),
  };
}

function expectationFor(
  reason: DesktopAgentSessionsAckReasonType
): Expectation {
  const counters = emptyCounterSnapshot();
  if (reason === DesktopAgentSessionsAckReason.ValidationFailed) {
    counters.validationFailed = 1;
    return {
      order: [
        DispatchCollaborator.NoteLaneAnswered,
        DispatchCollaborator.ApplyBoundedFold,
      ],
      foldReasons: [DesktopAgentSessionsAckReason.ValidationFailed],
      laneStallClasses: [],
      laneDeferredIds: [],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.FeatureDisabled) {
    return {
      order: [
        DispatchCollaborator.PauseForFeatureDisabled,
        DispatchCollaborator.LogInfo,
      ],
      foldReasons: [],
      laneStallClasses: [],
      laneDeferredIds: [],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.Unauthenticated) {
    // ISS-8610: a 401 is LANE-wide, so it reaches the lane gate rather than a
    // flat per-row deadline. Still no bounded fold and still no counter — what
    // changed is that the defer now carries a clock and a terminal.
    return {
      order: [
        DispatchCollaborator.DeferLaneEnvironmental,
        DispatchCollaborator.LogInfo,
      ],
      foldReasons: [],
      laneStallClasses: [],
      laneDeferredIds: [sessionId],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.TargetNotOwned) {
    return {
      order: [
        DispatchCollaborator.DeferLaneEnvironmental,
        DispatchCollaborator.LogWarn,
      ],
      foldReasons: [],
      laneStallClasses: [],
      laneDeferredIds: [sessionId],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.AckTimeout) {
    // ISS-8605 (F2): 408 is ENVIRONMENTAL. Two things changed and both are
    // asserted here rather than one standing in for the other — it no longer
    // reaches the bounded fold (so `counters.ackTimeout` stays 0, the budget
    // this class used to burn), and it no longer calls `noteLaneAnswered` (an
    // intermediary's 408 is not the server answering about the row, so it must
    // not end a stall run it did not disprove).
    return {
      order: [DispatchCollaborator.ApplyLaneStallFold],
      foldReasons: [],
      laneStallClasses: [SessionEnvironmentalDeferClass.AckTimeout],
      laneDeferredIds: [],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.TransportTimeout) {
    counters.transportTimeout = 1;
    return {
      order: [
        DispatchCollaborator.TransportTimeoutFoldPolicy,
        DispatchCollaborator.ApplyBoundedFold,
      ],
      foldReasons: [DesktopAgentSessionsAckReason.TransportTimeout],
      laneStallClasses: [],
      laneDeferredIds: [],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.RateLimited) {
    // ISS-8605 (F1): 429 is ENVIRONMENTAL. The route's limiter keys on the
    // compute target, never a session, so no row may be charged for it.
    return {
      order: [DispatchCollaborator.ApplyLaneStallFold],
      foldReasons: [],
      laneStallClasses: [SessionEnvironmentalDeferClass.RateLimited],
      laneDeferredIds: [],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.TransportUnavailable) {
    // ISS-8610: it used to reach `applyBoundedFold` with `countsToward: false`
    // and an infinite ceiling — a fold whose only terminal path is the counter
    // it was told not to advance. `foldReasons` staying EMPTY is what pins that
    // it no longer goes through the bounded fold at all.
    return {
      order: [
        DispatchCollaborator.NoteTransportLoss,
        DispatchCollaborator.DeferLaneEnvironmental,
        DispatchCollaborator.LogInfo,
      ],
      foldReasons: [],
      laneStallClasses: [],
      laneDeferredIds: [sessionId],
      counters,
    };
  }
  if (reason === DesktopAgentSessionsAckReason.IngestionFailed) {
    // ISS-7730: `ingestion_failed` is lane-wide, not row-attributable, so it no
    // longer spends the per-row bounded fold — it defers with every budget
    // intact and is bounded by the durable wall clock instead. Reaching
    // `applyBoundedFold` here again would be the invariant-4 violation.
    return {
      order: [DispatchCollaborator.ApplyLaneStallFold],
      foldReasons: [],
      laneStallClasses: [SessionEnvironmentalDeferClass.IngestionFailed],
      laneDeferredIds: [],
      counters,
    };
  }
  throw new Error(`missing expectation for ${reason satisfies never}`);
}

function emptyCounterSnapshot(): CounterSnapshot {
  return {
    validationFailed: 0,
    ackTimeout: 0,
    transportTimeout: 0,
  };
}

function increment(counter: Map<string, number>, id: string): void {
  counter.set(id, (counter.get(id) ?? 0) + 1);
}

function transportTimeoutFoldPolicy(
  counter: Map<string, number>
): Omit<BoundedFailureFoldConfig, "ids" | "syncMode" | "payloadBytes"> {
  return {
    counter,
    maxConsecutive: 3,
    reason: DesktopAgentSessionsAckReason.TransportTimeout,
    recoverable: true,
    backoffMs: 1000,
    recordOutboxOnDefer: false,
  };
}

const DispatchCollaborator = {
  ApplyBoundedFold: "applyBoundedFold",
  ApplyLaneStallFold: "applyLaneStallFold",
  DeferLaneEnvironmental: "deferLaneEnvironmental",
  LogInfo: "logInfo",
  LogWarn: "logWarn",
  NoteLaneAnswered: "noteLaneAnswered",
  NoteTransportLoss: "noteTransportLoss",
  PauseForFeatureDisabled: "pauseForFeatureDisabled",
  TransportTimeoutFoldPolicy: "transportTimeoutFoldPolicy",
} as const;

const futureAckReason = "future_ack_reason";
const sessionId = "session-1";

/** ISS-10014: "the fold was handed no wait at all", distinct from a wait of 0. */
const ABSENT_RETRY_AFTER = "absent" as const;

type DispatchCollaborator =
  (typeof DispatchCollaborator)[keyof typeof DispatchCollaborator];

type RecordedCalls = {
  order: DispatchCollaborator[];
  foldReasons: string[];
  laneStallClasses: SessionEnvironmentalDeferClass[];
  /**
   * ISS-8610: the ids handed to the LANE-wide environmental fold. Recorded, not
   * just counted: the gate paces the whole lane, so a dispatch that deferred the
   * wrong ids — or none — would still look like a working lane from every timing
   * assertion, and the rows would silently lose their own deadlines.
   */
  laneDeferredIds: string[];
  /** ISS-8605: classes whose durable stall fold actually SETTLED. */
  laneStallSettled: SessionEnvironmentalDeferClass[];
  /**
   * ISS-10014: the server's `Retry-After` as the stall fold RECEIVED it, the
   * absent case as a sentinel so a list of waits reads as one when compared.
   */
  /**
   * PLN-2028 (ISS-9963): the CAUSE each lane-wide defer passed, which is what
   * the durable column records beside the give-up and what a relaunch inside the
   * same outage announces instead of silence.
   */
  laneDeferReasons: SyncReason[];
  laneStallRetryAfters: (number | typeof ABSENT_RETRY_AFTER)[];
  /** ISS-10014: the same, as the LANE GATE received it. */
  laneDeferRetryAfters: (number | typeof ABSENT_RETRY_AFTER)[];
  warnMessages: string[];
};

type CounterSnapshot = {
  validationFailed: number;
  ackTimeout: number;
  transportTimeout: number;
};

type Expectation = {
  order: DispatchCollaborator[];
  foldReasons: string[];
  laneStallClasses: SessionEnvironmentalDeferClass[];
  /** ISS-8610: the ids the LANE-wide environmental fold must have been given. */
  laneDeferredIds: string[];
  counters: CounterSnapshot;
};

type Harness = {
  deps: RejectedAckDispatchDeps;
  calls: RecordedCalls;
  counterSnapshot: () => CounterSnapshot;
};
