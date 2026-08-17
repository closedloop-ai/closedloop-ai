/**
 * @file durable-outbox.test.ts
 * @description Unit coverage for the shared durable-outbox mechanics (PLN-1562
 * WS1) — the crash-correct discipline the per-session and invocation-parts lanes
 * both compose. Each test asserts a specific invariant the two lanes previously
 * carried by copy-paste plus review vigilance.
 *
 * The per-lane suites remain the behavioral-invariance oracle for the adoption
 * itself; these pin the shared substrate directly so a future lane inherits
 * tested mechanics rather than re-deriving them.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decideOutboxFailure,
  OutboxFailureOutcome,
  outboxDeadLetterFields,
  outboxRePendFields,
  outboxRetryFields,
  readyOutboxWhere,
} from "../src/main/sync/durable-outbox.js";
import {
  asOutboxStatus,
  OutboxStatus,
} from "../src/shared/sync-lane-contract.js";

const NOW_ISO = "2026-08-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const BASE_MS = 30_000;
const MAX_MS = 15 * 60_000;

describe("sync-lane contract: OutboxStatus", () => {
  test("narrows both members and rejects anything else", () => {
    assert.equal(asOutboxStatus("pending"), OutboxStatus.Pending);
    assert.equal(asOutboxStatus("dead_lettered"), OutboxStatus.DeadLettered);
    // The column is unconstrained TEXT in both outbox tables, so a value written
    // by a skewed build must surface as "unknown" rather than silently passing
    // through as a status the caller will mislabel.
    assert.equal(asOutboxStatus("uploading"), null);
    assert.equal(asOutboxStatus(""), null);
  });
});

describe("readyOutboxWhere", () => {
  test("scopes to the sourceKey, pending only, and past-due backoff", () => {
    const where = readyOutboxWhere("agent_sessions:target-1", NOW_ISO);
    // sourceKey scoping is the invariant that stops one account/machine from
    // draining another's queue — it is not optional and must always be present.
    assert.equal(where.sourceKey, "agent_sessions:target-1");
    assert.equal(where.status, OutboxStatus.Pending);
    // A never-deferred row (null deadline) is ready; a deferred one is ready only
    // once its deadline has elapsed.
    assert.deepEqual(where.OR, [
      { nextAttemptAt: null },
      { nextAttemptAt: { lte: NOW_ISO } },
    ]);
  });
});

describe("outboxDeadLetterFields", () => {
  test("records the reason, clears the scheduled retry, keeps the burned count", () => {
    const fields = outboxDeadLetterFields({
      reason: "validation_failed",
      nowIso: NOW_ISO,
      attemptCount: 4,
    });
    assert.equal(fields.status, OutboxStatus.DeadLettered);
    assert.equal(fields.lastError, "validation_failed");
    // A dead-lettered row is no longer awaiting a scheduled retry.
    assert.equal(fields.nextAttemptAt, null);
    // FEA-3659: the real burned budget, not a misleading 0.
    assert.equal(fields.attemptCount, 4);
    assert.equal(fields.updatedAt, NOW_ISO);
  });

  test("omits attemptCount entirely when the caller has none to report", () => {
    const fields = outboxDeadLetterFields({
      reason: "invalid_persisted_payload",
      nowIso: NOW_ISO,
    });
    // The invocation lane's payload-parse quarantine is not a delivery attempt.
    // Writing `attemptCount: undefined` would blank the persisted count; the key
    // must be absent so the column is left untouched.
    assert.equal("attemptCount" in fields, false);
  });
});

describe("outboxRetryFields", () => {
  test("never writes status, so a retry cannot resurrect a dead-lettered row", () => {
    const fields = outboxRetryFields({
      attemptCount: 2,
      nextAttemptAt: "2026-08-03T12:01:00.000Z",
      reason: "ingestion_failed",
      nowIso: NOW_ISO,
    });
    // FEA-3659: the omission IS the invariant. If `status` were present this
    // write would flip a dead_lettered row back to pending behind the lane's back.
    assert.equal("status" in fields, false);
    assert.deepEqual(fields, {
      attemptCount: 2,
      nextAttemptAt: "2026-08-03T12:01:00.000Z",
      lastError: "ingestion_failed",
      updatedAt: NOW_ISO,
    });
  });
});

describe("outboxRePendFields", () => {
  test("restores pending and restarts the bounded budget from scratch", () => {
    assert.deepEqual(outboxRePendFields(NOW_ISO), {
      status: OutboxStatus.Pending,
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: NOW_ISO,
    });
  });
});

describe("decideOutboxFailure", () => {
  test("retries a transient failure on the shared exponential ladder", () => {
    const decision = decideOutboxFailure({
      attemptCount: 0,
      maxAttempts: 5,
      permanent: false,
      nowMs: NOW_MS,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
    });
    assert.equal(decision.outcome, OutboxFailureOutcome.Retry);
    assert.equal(decision.attemptCount, 1);
    assert.equal(
      decision.outcome === OutboxFailureOutcome.Retry
        ? decision.nextAttemptAtMs
        : null,
      NOW_MS + BASE_MS
    );
  });

  test("doubles the backoff per attempt and pins at the cap", () => {
    const delayAt = (attemptCount: number): number => {
      const decision = decideOutboxFailure({
        attemptCount,
        maxAttempts: 999,
        permanent: false,
        nowMs: NOW_MS,
        baseMs: BASE_MS,
        maxMs: MAX_MS,
      });
      assert.equal(decision.outcome, OutboxFailureOutcome.Retry);
      return decision.outcome === OutboxFailureOutcome.Retry
        ? decision.nextAttemptAtMs - NOW_MS
        : Number.NaN;
    };
    assert.equal(delayAt(0), BASE_MS);
    assert.equal(delayAt(1), BASE_MS * 2);
    assert.equal(delayAt(2), BASE_MS * 4);
    // Pinned at the cap rather than growing without bound.
    assert.equal(delayAt(40), MAX_MS);
  });

  test("dead-letters a permanent failure once the budget is exhausted", () => {
    const decision = decideOutboxFailure({
      attemptCount: 4,
      maxAttempts: 5,
      permanent: true,
      nowMs: NOW_MS,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
    });
    assert.equal(decision.outcome, OutboxFailureOutcome.DeadLetter);
    // Post-increment: the count persisted alongside the dead-letter.
    assert.equal(decision.attemptCount, 5);
  });

  test("a permanent failure still retries while budget remains", () => {
    const decision = decideOutboxFailure({
      attemptCount: 3,
      maxAttempts: 5,
      permanent: true,
      nowMs: NOW_MS,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
    });
    assert.equal(decision.outcome, OutboxFailureOutcome.Retry);
    assert.equal(decision.attemptCount, 4);
  });

  test("a TRANSIENT failure never dead-letters, however many attempts it burned", () => {
    // The load-bearing case: a lane-wide outage (auth loss, transport error, 5xx)
    // must not walk healthy rows into the dead-letter set. Without the `permanent`
    // guard this input would dead-letter — that regression is what this pins.
    const decision = decideOutboxFailure({
      attemptCount: 99,
      maxAttempts: 5,
      permanent: false,
      nowMs: NOW_MS,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
    });
    assert.equal(decision.outcome, OutboxFailureOutcome.Retry);
    assert.equal(decision.attemptCount, 100);
  });
});
