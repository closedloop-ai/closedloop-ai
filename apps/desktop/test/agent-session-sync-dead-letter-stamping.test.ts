/**
 * @file agent-session-sync-dead-letter-stamping.test.ts
 * @description ISS-7564 coverage for `markDeadLettered` — the lifecycle's entry.
 *
 * What a dead-letter is STAMPED with decides which of the three exits can ever
 * claim it: a finite FEA-3363 retry-after belongs to `recoverExpiredDeadLetters`,
 * an infinite one to `promoteDeadLetterIfIdle`. This suite owns that stamp plus
 * the per-class allowances charged alongside it; the exits themselves are
 * `-doors.test.ts` and the bound is `-cap.test.ts`.
 *
 * Prior suites only ever stubbed `markDeadLettered` as a service dependency
 * (`agent-session-sync-ack-fold.test.ts:45`), which proves the service's
 * contract and nothing about this module.
 */

import assert from "node:assert/strict";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import {
  deadLetterRetryDelayMs,
  MAX_DEAD_LETTERED_IDS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { markDeadLettered } from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import { CHUNK_VALIDATION_FAILED_REASON } from "../src/main/agent-sync/agent-session-sync-validation-failure.js";
import {
  DETERMINISTIC_REASON,
  FIXED_NOW_MS,
  makeHarness,
  pinLifecycleClock,
  seedDeadLetters,
  settleHandoffs,
  TRANSIENT_REASON,
} from "./agent-session-sync-dead-letter-fixtures.js";

pinLifecycleClock();

test("markDeadLettered stamps a recoverable id with the first progressive retry window", () => {
  const harness = makeHarness();

  markDeadLettered("dl-a", true, TRANSIENT_REASON, 5, null, harness.deps);

  assert.equal(harness.deps.deadLetterCountById.get("dl-a"), 1);
  assert.equal(
    harness.deps.deadLetteredIds.get("dl-a"),
    FIXED_NOW_MS + deadLetterRetryDelayMs(1)
  );
  assert.deepEqual(harness.outboxDeadLetters, [
    { id: "dl-a", reason: TRANSIENT_REASON, attemptCount: 5 },
  ]);
});

test("markDeadLettered escalates the retry window on each re-dead-letter of the same id", () => {
  const harness = makeHarness();

  markDeadLettered("dl-a", true, TRANSIENT_REASON, 3, null, harness.deps);
  markDeadLettered("dl-a", true, TRANSIENT_REASON, 3, null, harness.deps);

  assert.equal(harness.deps.deadLetterCountById.get("dl-a"), 2);
  assert.equal(
    harness.deps.deadLetteredIds.get("dl-a"),
    FIXED_NOW_MS + deadLetterRetryDelayMs(2),
    "the second dead-letter of an id must stamp the NEXT rung of the ladder"
  );
});

test("markDeadLettered stamps a deterministic class with an infinite deadline and no escalation counter", () => {
  const harness = makeHarness();

  markDeadLettered("dl-b", false, DETERMINISTIC_REASON, 3, null, harness.deps);

  assert.equal(
    harness.deps.deadLetteredIds.get("dl-b"),
    Number.POSITIVE_INFINITY
  );
  assert.equal(
    harness.deps.deadLetterCountById.has("dl-b"),
    false,
    "a terminal class never participates in the progressive escalation"
  );
  assert.deepEqual(harness.outboxDeadLetters, [
    { id: "dl-b", reason: DETERMINISTIC_REASON, attemptCount: 3 },
  ]);
});

test("markDeadLettered accumulates the chunk-validation allowance on its own class only", () => {
  const harness = makeHarness();

  markDeadLettered(
    "dl-a",
    true,
    CHUNK_VALIDATION_FAILED_REASON,
    1,
    null,
    harness.deps
  );
  assert.equal(harness.deps.chunkValidationCycleById.get("dl-a"), 1);

  // The second charge must ADVANCE the count. A charge that re-stamped 1 would
  // never reach the class's terminal bound, so a genuinely-invalid row would
  // be re-driven forever — the unbounded retry the bound exists to stop.
  markDeadLettered(
    "dl-a",
    true,
    CHUNK_VALIDATION_FAILED_REASON,
    1,
    null,
    harness.deps
  );
  assert.equal(harness.deps.chunkValidationCycleById.get("dl-a"), 2);

  assert.equal(harness.deps.ackOmittedCycleById.has("dl-a"), false);
});

test("markDeadLettered accumulates the ack-omitted allowance on its own class only", () => {
  const harness = makeHarness();

  markDeadLettered("dl-a", true, SyncReason.AckOmitted, 1, null, harness.deps);
  assert.equal(harness.deps.ackOmittedCycleById.get("dl-a"), 1);

  markDeadLettered("dl-a", true, SyncReason.AckOmitted, 1, null, harness.deps);
  assert.equal(
    harness.deps.ackOmittedCycleById.get("dl-a"),
    2,
    "the allowance advances — a re-stamped 1 would never go terminal"
  );

  assert.equal(harness.deps.chunkValidationCycleById.has("dl-a"), false);
});

test("markDeadLettered charges neither per-class allowance for an unrelated recoverable class", () => {
  const harness = makeHarness();

  markDeadLettered("dl-a", true, TRANSIENT_REASON, 1, null, harness.deps);

  assert.equal(harness.deps.chunkValidationCycleById.has("dl-a"), false);
  assert.equal(harness.deps.ackOmittedCycleById.has("dl-a"), false);
  assert.equal(
    harness.deps.deadLetterCountById.get("dl-a"),
    1,
    "the escalation counter is still charged — only the per-class ones are not"
  );
});

test("markDeadLettered charges no per-class allowance when the dead-letter is not recoverable", () => {
  const harness = makeHarness();

  markDeadLettered(
    "dl-a",
    false,
    CHUNK_VALIDATION_FAILED_REASON,
    1,
    null,
    harness.deps
  );

  assert.equal(
    harness.deps.chunkValidationCycleById.has("dl-a"),
    false,
    "the per-class allowances live inside the recoverable branch"
  );
  assert.equal(harness.deps.ackOmittedCycleById.has("dl-a"), false);
});

test("markDeadLettered enforces the cap as part of recording a new id", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS);

  markDeadLettered("dl-newest", true, TRANSIENT_REASON, 1, null, harness.deps);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.size, MAX_DEAD_LETTERED_IDS);
  assert.equal(harness.deps.deadLetteredIds.has("dl-0"), false);
  assert.equal(harness.deps.deadLetteredIds.has("dl-newest"), true);
  assert.deepEqual(
    harness.outboxDeadLetters.map((call) => call.id),
    ["dl-newest"],
    "the outbox record still fires for the id that triggered the eviction"
  );
});
