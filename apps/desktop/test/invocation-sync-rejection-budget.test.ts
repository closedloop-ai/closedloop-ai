/**
 * @file invocation-sync-rejection-budget.test.ts
 * @description ISS-5789 (PRD-634): how the invocation lane CLASSIFIES a rejection
 * ack — which reasons may exhaust a part's retry budget, which must never, and how
 * large the `session_missing` budget has to be.
 *
 * Its own suite rather than more blocks in the service tests, which cover drain
 * mechanics (readiness gates, single-flight prepare, ack matching). This file is
 * about one decision: given a reason, does the part eventually stop retrying? Both
 * suites share the fake source in `helpers/invocation-sync-service-fixtures.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { AgentComponentInvocationSyncService } from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import {
  DEAD_LETTER_RETRY_MAX_MS,
  deadLetterRetryDelayMs,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { SESSION_MISSING_MAX_RETRY_AGE_MS } from "../src/main/agent-sync/invocation-sync-rejection-policy.js";
import {
  FakeSource,
  part,
  SESSION_MISSING_HORIZON_INTACT_AT,
  SESSION_MISSING_HORIZON_SPENT_AT,
} from "./helpers/invocation-sync-service-fixtures.js";

/**
 * An attempt count past EVERY ceiling the lane defines, so a case built on it
 * isolates the `permanent` flag: whatever `maxAttempts` a reason carries is
 * already spent, and the only remaining question is whether the reason is allowed
 * to spend it at all.
 */
const BEYOND_EVERY_BUDGET = 500;

/**
 * The terminal behaviour each declared reason must produce once its budget is
 * spent. Deliberately restates the classification the production `Record` encodes
 * rather than importing it: a test that read the same table it is checking would
 * pass no matter how that table changed.
 */
const TERMINAL_BEHAVIOUR_BY_REASON: ReadonlyArray<{
  reason: AgentComponentInvocationSyncRejectReason;
  deadLetters: boolean;
}> = [
  {
    reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    deadLetters: true,
  },
  {
    reason: AgentComponentInvocationSyncRejectReason.PartConflict,
    deadLetters: true,
  },
  {
    reason: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    deadLetters: true,
  },
  {
    reason: AgentComponentInvocationSyncRejectReason.ProtocolUnsupported,
    deadLetters: false,
  },
  {
    reason: AgentComponentInvocationSyncRejectReason.IngestionFailed,
    deadLetters: false,
  },
];

/**
 * Reasons the TYPE forbids but the WIRE can deliver. Held as `string` first so the
 * narrowing cast is a single `as` rather than a double: the point of both values is
 * that they are unreachable through the type system and reachable at runtime, from
 * a cloud newer than this desktop build.
 */
const UNKNOWN_REASON_WIRE_VALUE: string = "reason_added_after_this_build";
const PROTOTYPE_REASON_WIRE_VALUE: string = "__proto__";

const UNKNOWN_FUTURE_REJECT_REASON =
  UNKNOWN_REASON_WIRE_VALUE as AgentComponentInvocationSyncRejectReason;

const PROTOTYPE_SHAPED_REJECT_REASON =
  PROTOTYPE_REASON_WIRE_VALUE as AgentComponentInvocationSyncRejectReason;

describe("ISS-5789 invocation sync rejection budget", () => {
  // ISS-5789: every reason the enum declares, pinned to the terminal behaviour its
  // budget is supposed to produce. `session_missing` and `rate_limited` are covered
  // in depth by the `ISS-5789:`-prefixed cases in
  // `agent-component-invocation-sync-service.test.ts` and by the horizon suite at
  // the bottom of this file; this covers the four that were otherwise asserted
  // NOWHERE, so a future edit to `REJECTION_BUDGETS` cannot silently reclassify
  // `part_conflict` or `ingestion_failed` with the suite still green. Each case is
  // driven far past every ceiling, so the only thing that decides the outcome is
  // the `permanent` flag.
  for (const { reason, deadLetters } of TERMINAL_BEHAVIOUR_BY_REASON) {
    it(`ISS-5789: ${reason} ${deadLetters ? "dead-letters" : "keeps retrying"} once every budget is spent`, async () => {
      const source = new FakeSource(part(), BEYOND_EVERY_BUDGET);
      const service = new AgentComponentInvocationSyncService({
        isReady: () => true,
        getSource: () => source,
        getComputeTargetId: () => "target-1",
        sendPart: (pending) =>
          Promise.resolve({
            kind: "ack" as const,
            ack: {
              accepted: false as const,
              protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
              externalGenerationId: pending.externalGenerationId,
              partIndex: pending.partIndex,
              partHash: pending.partHash,
              reason,
            },
          }),
        now: () => new Date("2026-08-10T12:00:00.000Z"),
      });

      await service.syncOnce();

      assert.equal(
        source.deadLetterCalls,
        deadLetters ? 1 : 0,
        `${reason} must ${deadLetters ? "exhaust" : "never exhaust"} the row's budget`
      );
      assert.equal(
        source.entries.length,
        deadLetters ? 0 : 1,
        deadLetters
          ? "a permanently rejected part must leave the queue"
          : "a transiently rejected part must stay queued for another attempt"
      );
    });
  }

  // ISS-5789, DEFENSE IN DEPTH. The live cross-repo boundary is NOT here: the
  // client's `isRejectReason` already rejects an unrecognized wire reason and
  // degrades it to a plain retry before an ack ever reaches this classifier (that
  // boundary is covered in `desktop-agent-component-invocations-client.test.ts`).
  // This case pins the classifier's OWN behaviour if a future caller is wired up
  // without that filter — the safe degradation is TRANSIENT, because a reason we
  // cannot interpret is not one we can attribute to this row, so dead-lettering on
  // it would discard data over a version skew.
  it("ISS-5789: an unrecognized reason defers instead of dead-lettering", async () => {
    const source = new FakeSource(part(), BEYOND_EVERY_BUDGET);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) =>
        Promise.resolve({
          kind: "ack" as const,
          ack: {
            accepted: false as const,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            reason: UNKNOWN_FUTURE_REJECT_REASON,
          },
        }),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    await service.syncOnce();

    assert.equal(
      source.deadLetterCalls,
      0,
      "a reason this build cannot interpret must never strand the part"
    );
    assert.equal(source.entries.length, 1);
  });

  // The `hasOwn` guard rather than a bare index: a value shaped like an inherited
  // property must not resolve to one. `__proto__` reaches Object.prototype on a
  // bare lookup, which would return a non-budget object and make `permanent`
  // undefined — falsy, so it would happen to defer, but by accident rather than by
  // decision, and `maxAttempts` would be undefined too. Same defense-in-depth
  // standing as the case above.
  it("ISS-5789: a prototype-shaped reason resolves to the transient default, not an inherited property", async () => {
    const source = new FakeSource(part(), BEYOND_EVERY_BUDGET);
    const service = new AgentComponentInvocationSyncService({
      isReady: () => true,
      getSource: () => source,
      getComputeTargetId: () => "target-1",
      sendPart: (pending) =>
        Promise.resolve({
          kind: "ack" as const,
          ack: {
            accepted: false as const,
            protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
            externalGenerationId: pending.externalGenerationId,
            partIndex: pending.partIndex,
            partHash: pending.partHash,
            reason: PROTOTYPE_SHAPED_REJECT_REASON,
          },
        }),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    await service.syncOnce();

    assert.equal(source.deadLetterCalls, 0);
    assert.equal(source.entries.length, 1);
  });
});

/**
 * ISS-5789: the cross-lane relationship the `session_missing` budget exists to
 * hold, and the boundary at which it gives up.
 *
 * One of the three conditions that produce `session_missing` is "the parent session
 * was dead-lettered upstream", and the SESSION lane re-attempts a dead-lettered
 * session on its own progressive ladder. If this lane's budget expired first, the
 * part would be abandoned while its parent was still on a recovery path that would
 * have made it deliverable — and since this lane has no dead-letter recovery that
 * loss is permanent.
 *
 * Recomputed here from the session lane's ladder rather than read back from the
 * production constant, so the two would disagree if either were changed to stop
 * honouring the relationship.
 */
describe("ISS-5789 session_missing horizon vs the session lane's recovery ladder", () => {
  it("outlasts the parent's entire escalating dead-letter ladder", () => {
    let cumulativeMs = 0;
    for (let cycle = 1; cycle <= PARENT_RECOVERY_CYCLES_COVERED; cycle++) {
      cumulativeMs += deadLetterRetryDelayMs(cycle);
    }

    assert.ok(
      SESSION_MISSING_MAX_RETRY_AGE_MS > cumulativeMs,
      `the horizon spans ${SESSION_MISSING_MAX_RETRY_AGE_MS}ms but the parent's first ${PARENT_RECOVERY_CYCLES_COVERED} recovery cycles span ${cumulativeMs}ms`
    );
  });

  // @wongk: `DEAD_LETTER_RETRY_MAX_MS` caps ONE parent retry delay; it is not a
  // total recovery horizon, and the ladder re-arms after every failed cycle. This
  // pins the fact the doc now states plainly — the parent's ladder is pinned at
  // the cap and keeps going, so no finite budget outlasts it and this one does not
  // claim to.
  it("does not claim to outlast an unbounded sequence of parent recovery cycles", () => {
    assert.equal(
      deadLetterRetryDelayMs(PARENT_RECOVERY_CYCLES_COVERED + 50),
      DEAD_LETTER_RETRY_MAX_MS,
      "the parent ladder is pinned at its cap and still re-arming"
    );
    assert.ok(
      SESSION_MISSING_MAX_RETRY_AGE_MS <
        DEAD_LETTER_RETRY_MAX_MS * PARENT_RECOVERY_CYCLES_COVERED,
      "the budget must stay bounded, not chase an unbounded horizon"
    );
  });

  it("still terminates well short of the runaway this ticket was filed for", () => {
    assert.ok(
      SESSION_MISSING_MAX_RETRY_AGE_MS < RUNAWAY_RETRY_SPAN_MS,
      "the budget must stay bounded, not merely larger"
    );
  });
});

/**
 * ISS-5789 — the budget end to end, driven ADVERSARIALLY through the real service.
 *
 * The failure these replace was not a wrong number, it was a budget read off the
 * wrong column: `attempt_count` is shared with every transient failure, so a
 * lane-wide outage could spend a row-attributable budget before the first real
 * rejection ever arrived. Every case here therefore preloads an attempt count far
 * past any ceiling the lane declares — if the terminal decision were an attempt
 * count, all three would dead-letter.
 */
describe("ISS-5789 session_missing is bounded by row age, not by the shared attempt counter", () => {
  it("defers while the horizon holds, however many transient attempts preceded it", async () => {
    const source = new FakeSource(part(), BEYOND_EVERY_BUDGET);
    const service = sessionMissingService(
      source,
      SESSION_MISSING_HORIZON_INTACT_AT
    );

    await service.syncOnce();

    assert.equal(
      source.deadLetterCalls,
      0,
      "an outage's own retries must not strand a part on its first session_missing"
    );
    assert.equal(source.entries.length, 1);
  });

  it("dead-letters once the part has outlived the horizon", async () => {
    const source = new FakeSource(part(), BEYOND_EVERY_BUDGET);
    const service = sessionMissingService(
      source,
      SESSION_MISSING_HORIZON_SPENT_AT
    );

    await service.syncOnce();

    assert.equal(
      source.deadLetterCalls,
      1,
      "past the horizon the part must reach a terminal state"
    );
    assert.equal(source.entries.length, 0);
  });

  // Handling-bad-data: `created_at` is NOT NULL, but it is a text column, so a
  // corrupt value is reachable at runtime. Abandoning a part on the strength of a
  // timestamp the lane could not read would discard data over a parse failure.
  it("keeps retrying rather than abandoning a part whose created_at cannot be read", async () => {
    const source = new FakeSource(part(), BEYOND_EVERY_BUDGET);
    source.createdAt = "not-a-timestamp";
    const service = sessionMissingService(
      source,
      SESSION_MISSING_HORIZON_SPENT_AT
    );

    await service.syncOnce();

    assert.equal(
      source.deadLetterCalls,
      0,
      "an unreadable created_at must not be treated as an expired horizon"
    );
    assert.equal(source.entries.length, 1);
  });
});

/** A service that answers every send with `session_missing` at a pinned clock. */
function sessionMissingService(
  source: FakeSource,
  nowIso: string
): AgentComponentInvocationSyncService {
  return new AgentComponentInvocationSyncService({
    isReady: () => true,
    getSource: () => source,
    getComputeTargetId: () => "target-1",
    sendPart: (pending) =>
      Promise.resolve({
        kind: "ack" as const,
        ack: {
          accepted: false as const,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: pending.externalGenerationId,
          partIndex: pending.partIndex,
          partHash: pending.partHash,
          reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
        },
      }),
    now: () => new Date(nowIso),
  });
}

/**
 * How many of the parent lane's dead-letter recovery cycles this horizon covers.
 * Ten is its whole escalation: the delay doubles from 5 minutes and cycle 10 is the
 * first one served at the 24h cap, so a parent recovering at ANY rung of the
 * escalation finds this part still trying.
 */
const PARENT_RECOVERY_CYCLES_COVERED = 10;

/**
 * How long the jammed part had actually been retrying when ISS-5789 was filed —
 * about two weeks, over 729 attempts. The budget has to sit far below this or it
 * has not really replaced "unbounded" with "bounded".
 */
const RUNAWAY_RETRY_SPAN_MS = 14 * 24 * 60 * 60 * 1000;
