/**
 * @file outbox-retry-rehydration.test.ts
 * @description Unit coverage for `rehydrateSessionOutboxEngineState` — the resume step
 * that seeds the session lane's in-memory retry budgets, backoff deadlines, and
 * (ISS-7730) the lane-wide stall clock from the durable outbox.
 *
 * The stall clock is the case that needs its own test: it is the ONLY bound a
 * lane-wide failure has, and it lives on disk precisely so a desktop relaunched
 * inside a long outage keeps accruing toward the ceiling instead of restarting
 * it every launch. A persisted row is a trust boundary — the column is TEXT and
 * nothing in the type system stops a corrupt or half-written stamp reaching this
 * parse — so the malformed case is reachable and is covered here alongside the
 * well-formed one, as is the finite-but-FUTURE stamp, which is worse: it parses
 * fine and keeps elapsed time negative, so the ceiling is never crossed at all.
 * Both now report on the monitored telemetry lane before degrading.
 */
import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import { MAX_TRACKED_LANE_STALLS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type { SessionOutboxEngineState } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  CHUNK_VALIDATION_EXHAUSTED_REASON,
  CHUNK_VALIDATION_FAILED_REASON,
  VALIDATION_FAILED_REASON,
} from "../src/main/agent-sync/agent-session-sync-validation-failure.js";
import {
  LaneStallClockAnomaly,
  rehydrateSessionOutboxEngineState,
  retryCounterMapForReason,
} from "../src/main/agent-sync/session-outbox-engine-state.js";
import { runWithMockedNow } from "./agent-session-sync-service-fixtures.js";

const STALLED_SINCE = "2026-07-17T23:00:00.000Z";
const NOW_MS = Date.parse("2026-08-20T00:00:00.000Z");

function makeTarget() {
  const laneStalledSinceMsById = new Map<string, number>();
  const nextRetryAfterMs = new Map<string, number>();
  const reportedAnomalies: LaneStallClockAnomaly[] = [];
  const counters = {
    ackOmitted: new Map<string, number>(),
    ackTimeout: new Map<string, number>(),
    ingestionFailed: new Map<string, number>(),
    rateLimited: new Map<string, number>(),
    unknownAckReason: new Map<string, number>(),
    validationFailed: new Map<string, number>(),
  };
  return {
    counters,
    nextRetryAfterMs,
    laneStalledSinceMsById,
    deadLetterRecoveryCountById: new Map<string, number>(),
    ackOmittedCycleById: new Map<string, number>(),
    reportedAnomalies,
    deadLetteredIds: { has: () => false },
    logInfo: () => undefined,
    reportInvalidStallClock: (anomaly: LaneStallClockAnomaly) =>
      reportedAnomalies.push(anomaly),
  };
}

function row(
  overrides: Partial<SessionOutboxEngineState>
): SessionOutboxEngineState {
  return {
    id: "s1",
    attemptCount: 3,
    permanentAttemptCount: 0,
    deadLetterRecoveryCount: 0,
    nextAttemptAt: "2026-07-18T00:05:00.000Z",
    lastError: "ingestion_failed",
    laneStalledSince: null,
    ...overrides,
  };
}

test("ISS-7730: a persisted stall clock is seeded, so a relaunch resumes the run", () => {
  const target = makeTarget();
  rehydrateSessionOutboxEngineState(
    [row({ laneStalledSince: STALLED_SINCE })],
    target
  );
  assert.equal(
    target.laneStalledSinceMsById.get("s1"),
    Date.parse(STALLED_SINCE),
    "the run resumes from where it started, not from this launch"
  );
  assert.equal(
    target.counters.ingestionFailed.get("s1"),
    3,
    "and the attempt tally is re-seeded alongside it"
  );
});

test("ISS-7730: a malformed persisted stall stamp seeds no run rather than a NaN one", () => {
  // The column is TEXT on a durable row, so a corrupt value is reachable at this
  // boundary whatever the types say. Seeding NaN would make every later
  // `now - startedAt >= ceiling` comparison false — silently REMOVING the bound,
  // which is the invariant-5 violation this whole change exists to avoid. The
  // honest degradation is "no run in progress": the row simply starts a fresh
  // clock on its next lane-wide failure.
  const target = makeTarget();
  rehydrateSessionOutboxEngineState(
    [row({ laneStalledSince: "not-a-timestamp" })],
    target
  );
  assert.equal(
    target.laneStalledSinceMsById.has("s1"),
    false,
    "no entry at all — never a NaN entry that would read as 'never expires'"
  );
  assert.equal(
    target.counters.ingestionFailed.get("s1"),
    3,
    "the rest of the row still rehydrates; one bad column is not a lost resume"
  );
  assert.deepEqual(
    target.reportedAnomalies,
    [LaneStallClockAnomaly.Unreadable],
    "and the degradation is REPORTED on the monitored lane — the bound it restarts is otherwise invisible"
  );
});

test("ISS-7730: a row with no stall stamp seeds no clock", () => {
  const target = makeTarget();
  rehydrateSessionOutboxEngineState([row({})], target);
  assert.equal(target.laneStalledSinceMsById.size, 0);
  assert.equal(
    target.nextRetryAfterMs.get("s1"),
    Date.parse("2026-07-18T00:05:00.000Z"),
    "the backoff deadline still rehydrates (FEA-3659)"
  );
});

test("ISS-8617: a row-attributable permanent attempt count owns the resumed retry budget", () => {
  const target = makeTarget();
  const seeded = rehydrateSessionOutboxEngineState(
    [
      row({
        attemptCount: 1,
        permanentAttemptCount: 4,
        deadLetterRecoveryCount: 2,
        lastError: SyncReason.AckOmitted,
      }),
    ],
    target
  );

  assert.equal(seeded, 1);
  assert.equal(
    target.counters.ackOmitted.get("s1"),
    4,
    "the durable permanent budget wins over the volatile attempt_count"
  );
  assert.equal(
    target.deadLetterRecoveryCountById.get("s1"),
    2,
    "the progressive dead-letter ladder resumes with the same row"
  );
});

test("ISS-8617: an environmental retry ignores a stale permanent attempt count", () => {
  const target = makeTarget();
  const seeded = rehydrateSessionOutboxEngineState(
    [
      row({
        attemptCount: 2,
        permanentAttemptCount: 4,
        lastError: SyncReason.RateLimited,
      }),
    ],
    target
  );

  assert.equal(seeded, 1);
  assert.equal(
    target.counters.rateLimited.get("s1"),
    2,
    "environmental retries resume from attempt_count, not a row-attributable budget"
  );
});

test("ISS-8617: a recovered row with attempt_count reset still resumes its recovery ladder", () => {
  const target = makeTarget();
  const seeded = rehydrateSessionOutboxEngineState(
    [
      row({
        id: "recovering",
        attemptCount: 0,
        permanentAttemptCount: 0,
        deadLetterRecoveryCount: 3,
        nextAttemptAt: null,
      }),
    ],
    target
  );

  assert.equal(seeded, 1);
  assert.equal(target.deadLetterRecoveryCountById.get("recovering"), 3);
  assert.equal(
    target.counters.ingestionFailed.has("recovering"),
    false,
    "a row with no remaining attempt budget does not fabricate one"
  );
  assert.equal(
    target.nextRetryAfterMs.has("recovering"),
    false,
    "the cleared retry deadline stays cleared after recovery"
  );
});

test("ISS-7730: a stall stamp from the FUTURE is reported and clamped, not accepted as-is", async () => {
  // The other half of the same trust boundary, and the more dangerous one. A
  // stamp ahead of the clock that reads it (a corrupt row, or a machine whose
  // clock stepped backwards) keeps `now - startedAt` NEGATIVE, so the ceiling is
  // never crossed and the row defers forever — the terminal path is gone with
  // nothing failing. Accepting it silently is what this rejects; clamping to now
  // is the honest reading of "the run started no later than this", and it repairs
  // the column on the next defer.
  await runWithMockedNow(() => {
    const target = makeTarget();
    const aheadOfTheClock = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    rehydrateSessionOutboxEngineState(
      [row({ laneStalledSince: aheadOfTheClock })],
      target
    );

    assert.deepEqual(
      target.reportedAnomalies,
      [LaneStallClockAnomaly.Future],
      "an impossible stamp reaches the monitored lane"
    );
    assert.equal(
      target.laneStalledSinceMsById.get("s1"),
      NOW_MS,
      "and is clamped to now, so elapsed time is zero rather than negative"
    );
    return Promise.resolve();
  }, NOW_MS);
});

test("ISS-7730: a well-formed stall stamp reports nothing", () => {
  // The counterpart that keeps the two cases above from passing on a reporter
  // that fires unconditionally.
  const target = makeTarget();
  rehydrateSessionOutboxEngineState(
    [row({ laneStalledSince: STALLED_SINCE })],
    target
  );
  assert.deepEqual(target.reportedAnomalies, []);
});

// ---------------------------------------------------------------------------
// ISS-7985 item 4: retryCounterMapForReason — every arm of the routing table.
// Only ingestion_failed was exercised before this; ISS-8605/ISS-8595 added the
// ack_timeout and unknown_ack_reason arms.
// ---------------------------------------------------------------------------

test("ISS-7985: retryCounterMapForReason routes each reason to the correct budget", () => {
  const counters = {
    ackOmitted: new Map<string, number>(),
    ackTimeout: new Map<string, number>(),
    ingestionFailed: new Map<string, number>(),
    rateLimited: new Map<string, number>(),
    unknownAckReason: new Map<string, number>(),
    validationFailed: new Map<string, number>(),
  };

  assert.equal(
    retryCounterMapForReason("ingestion_failed", counters),
    counters.ingestionFailed,
    "ingestion_failed → ingestionFailed"
  );
  assert.equal(
    retryCounterMapForReason("rate_limited", counters),
    counters.rateLimited,
    "rate_limited → rateLimited"
  );
  assert.equal(
    retryCounterMapForReason("ack_omitted", counters),
    counters.ackOmitted,
    "ack_omitted → ackOmitted"
  );
  // ISS-8605 / ISS-8595: both classes became durably-recorded environmental
  // defers, so a resume has to find their tallies. Spelled as literals on
  // purpose — reading them from the enum the routing switches on would make the
  // assertion agree with the code by construction and prove nothing.
  assert.equal(
    retryCounterMapForReason("ack_timeout", counters),
    counters.ackTimeout,
    "ack_timeout → ackTimeout"
  );
  assert.equal(
    retryCounterMapForReason("unknown_ack_reason", counters),
    counters.unknownAckReason,
    "unknown_ack_reason → unknownAckReason"
  );
  assert.equal(
    retryCounterMapForReason(VALIDATION_FAILED_REASON, counters),
    counters.validationFailed,
    "validation_failed → validationFailed"
  );
  assert.equal(
    retryCounterMapForReason(CHUNK_VALIDATION_FAILED_REASON, counters),
    counters.validationFailed,
    "chunk_validation_failed → validationFailed"
  );
  assert.equal(
    retryCounterMapForReason(CHUNK_VALIDATION_EXHAUSTED_REASON, counters),
    counters.validationFailed,
    "chunk_validation_exhausted → validationFailed"
  );
});

test("ISS-7985: retryCounterMapForReason returns null for an unrecognized or absent reason", () => {
  const counters = {
    ackOmitted: new Map<string, number>(),
    ackTimeout: new Map<string, number>(),
    ingestionFailed: new Map<string, number>(),
    rateLimited: new Map<string, number>(),
    unknownAckReason: new Map<string, number>(),
    validationFailed: new Map<string, number>(),
  };

  assert.equal(
    retryCounterMapForReason(null, counters),
    null,
    "null reason seeds no budget"
  );
  assert.equal(
    retryCounterMapForReason("quota_exceeded", counters),
    null,
    "a reason this build does not recognize seeds no budget"
  );
});

// ---------------------------------------------------------------------------
// ISS-7985 item 5: rehydrateSessionOutboxEngineState skip branches at the persistence
// trust boundary. Tests cover rows with no durable engine state,
// deadLetteredIds.has() true, and corrupt next_attempt_at.
//
// Not covered, deliberately: a non-finite attemptCount. It cannot arrive from
// the real producer because attempt_count is `Int @default(0)` NOT NULL, and it
// cannot arrive from the db-host boundary because the row schema rejects
// non-integer and unsafe numeric counters before hydrate sees them.
// ---------------------------------------------------------------------------

test("ISS-7985: a row with no durable engine state is skipped during rehydration", () => {
  const target = makeTarget();
  const seeded = rehydrateSessionOutboxEngineState(
    [
      row({ id: "zero", attemptCount: 0 }),
      row({ id: "neg", attemptCount: -1 }),
    ],
    target
  );
  assert.equal(seeded, 0, "neither row is seeded");
  assert.equal(target.counters.ingestionFailed.size, 0);
  assert.equal(target.nextRetryAfterMs.size, 0);
});

test("ISS-7985: a row already in the resumed dead-letter set is skipped", () => {
  const deadIds = new Set(["dead"]);
  const target = { ...makeTarget(), deadLetteredIds: deadIds };
  const seeded = rehydrateSessionOutboxEngineState(
    [
      row({ id: "dead", attemptCount: 5 }),
      row({ id: "live", attemptCount: 3 }),
    ],
    target
  );
  assert.equal(seeded, 1, "only the non-dead-lettered row is seeded");
  assert.equal(
    target.counters.ingestionFailed.has("dead"),
    false,
    "the dead-lettered row's budget is not re-seeded"
  );
  assert.equal(target.counters.ingestionFailed.get("live"), 3);
});

test("ISS-7985: an unparseable next_attempt_at arms no deferred-retry deadline", () => {
  const target = makeTarget();
  rehydrateSessionOutboxEngineState(
    [row({ nextAttemptAt: "not-a-timestamp" })],
    target
  );
  assert.equal(
    target.nextRetryAfterMs.has("s1"),
    false,
    "corrupt next_attempt_at does not seed a deadline"
  );
  assert.equal(
    target.counters.ingestionFailed.get("s1"),
    3,
    "the rest of the row still rehydrates"
  );
});

// ---------------------------------------------------------------------------
// ISS-7985 item 9: the resume-path admission cap on seedStallClock. The live
// fold cap is covered at agent-session-sync-lane-stall-fold.test.ts:342; this
// pins the RESUME cap in session-outbox-engine-state.ts:174-176.
// ---------------------------------------------------------------------------

test("ISS-7985: seedStallClock respects MAX_TRACKED_LANE_STALLS on resume", async () => {
  await runWithMockedNow(() => {
    const target = makeTarget();
    for (let i = 0; i < MAX_TRACKED_LANE_STALLS; i += 1) {
      target.laneStalledSinceMsById.set(`pre-${i}`, NOW_MS - 1000);
    }

    rehydrateSessionOutboxEngineState(
      [
        row({
          id: "overflow",
          laneStalledSince: STALLED_SINCE,
          attemptCount: 2,
        }),
      ],
      target
    );

    assert.equal(
      target.laneStalledSinceMsById.size,
      MAX_TRACKED_LANE_STALLS,
      "the map does not grow past the cap on resume"
    );
    assert.equal(
      target.laneStalledSinceMsById.has("overflow"),
      false,
      "the overflow row's stall clock is not seeded"
    );
    assert.equal(
      target.counters.ingestionFailed.get("overflow"),
      2,
      "the row's retry budget is still seeded — the cap bounds the clock, not the retry"
    );
    return Promise.resolve();
  }, NOW_MS);
});

test("ISS-9182: a re-pended row resumes the ack-omitted cycles it already spent", () => {
  const target = makeTarget();
  const seeded = rehydrateSessionOutboxEngineState(
    [
      // A recovery door re-pended it with its live budget reset, so the spent
      // cycles are the only durable state it carries.
      row({
        id: "spent",
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
        ackOmittedCycleCount: 3,
      }),
      // An older db-host peer omits the field: nothing to seed, not a zero.
      row({ id: "older-peer", attemptCount: 0, nextAttemptAt: null }),
    ],
    target
  );

  assert.equal(seeded, 1);
  assert.deepEqual([...target.ackOmittedCycleById], [["spent", 3]]);
});
