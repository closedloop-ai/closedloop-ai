/**
 * @file agent-session-sync-ack-fold.test.ts
 * @description FEA-4375 unit coverage for the extracted bounded-retry-then-
 * dead-letter fold shared by the per-session ack-reason classes. Drives the pure
 * `applyBoundedFailureFold` over a recording fake collaborator and asserts the
 * three distinct shapes: counted-with-backoff (validation), counted-no-backoff
 * (ack_timeout), and defer-only-never-count (transport_unavailable).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  applyBoundedFailureFold,
  type BoundedFailureFoldDeps,
} from "../src/main/agent-sync/agent-session-sync-ack-fold.js";

const TRANSPORT_UNAVAILABLE_LABEL = /transport_unavailable/;

type DeadLetterCall = {
  id: string;
  recoverable: boolean;
  reason: string;
  attemptCount?: number;
};

function makeRecordingDeps(): {
  deps: BoundedFailureFoldDeps;
  cleared: string[];
  deadLettered: DeadLetterCall[];
  dequeued: string[];
  outboxRetries: Array<{ id: string; attemptCount: number }>;
  warnings: string[];
  infos: string[];
} {
  const cleared: string[] = [];
  const deadLettered: DeadLetterCall[] = [];
  const dequeued: string[] = [];
  const outboxRetries: Array<{ id: string; attemptCount: number }> = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const deps: BoundedFailureFoldDeps = {
    nextRetryAfterMs: new Map<string, number>(),
    clearFailureStateForId: (id) => cleared.push(id),
    markDeadLettered: (id, recoverable, reason, attemptCount) =>
      deadLettered.push({ id, recoverable, reason, attemptCount }),
    dequeue: (_syncMode, ids) => dequeued.push(...ids),
    recordOutboxRetry: (id, attemptCount) =>
      outboxRetries.push({ id, attemptCount }),
    queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
    logWarn: (message) => warnings.push(message),
    logInfo: (message) => infos.push(message),
    formatBytes: (bytes) => `${bytes} B`,
  };
  return {
    deps,
    cleared,
    deadLettered,
    dequeued,
    outboxRetries,
    warnings,
    infos,
  };
}

test("FEA-4375: below the budget, a counted reason defers with a backoff deadline", () => {
  const { deps, deadLettered, infos } = makeRecordingDeps();
  const counter = new Map<string, number>();
  applyBoundedFailureFold(
    {
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      counter,
      maxConsecutive: 3,
      reason: "validation_failed",
      recoverable: false,
      backoffMs: 30_000,
      recordOutboxOnDefer: false,
    },
    deps
  );

  assert.equal(counter.get("s1"), 1, "the counter incremented");
  assert.ok(deps.nextRetryAfterMs.has("s1"), "a retry deadline was stamped");
  assert.equal(deadLettered.length, 0, "not dead-lettered below the budget");
  assert.equal(infos.length, 1, "logged the deferral once");
});

test("FEA-4375: at the budget, a counted reason dead-letters and clears state", () => {
  const { deps, cleared, deadLettered, dequeued } = makeRecordingDeps();
  const counter = new Map<string, number>([["s1", 2]]);
  applyBoundedFailureFold(
    {
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      counter,
      maxConsecutive: 3,
      reason: "validation_failed",
      recoverable: false,
      backoffMs: 30_000,
      recordOutboxOnDefer: false,
    },
    deps
  );

  assert.deepEqual(deadLettered, [
    {
      id: "s1",
      recoverable: false,
      reason: "validation_failed",
      attemptCount: 0,
    },
  ]);
  assert.deepEqual(cleared, ["s1"], "failure state was cleared for the id");
  assert.deepEqual(dequeued, ["s1"], "the dead-lettered id was dequeued");
});

test("FEA-4375: an outbox-recording reason stamps the exhausted count on dead-letter", () => {
  const { deps, deadLettered, outboxRetries } = makeRecordingDeps();
  const counter = new Map<string, number>([["s1", 2]]);
  applyBoundedFailureFold(
    {
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      counter,
      maxConsecutive: 3,
      reason: "ingestion_failed",
      recoverable: true,
      backoffMs: 30_000,
      recordOutboxOnDefer: true,
    },
    deps
  );

  assert.equal(deadLettered[0].attemptCount, 3, "carried the exhausted count");
  assert.equal(outboxRetries.length, 0, "a dead-letter records no retry");
});

test("FEA-4375: an outbox-recording reason records the retry on a sub-budget defer", () => {
  const { deps, outboxRetries } = makeRecordingDeps();
  const counter = new Map<string, number>();
  applyBoundedFailureFold(
    {
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      counter,
      maxConsecutive: 3,
      reason: "ingestion_failed",
      recoverable: true,
      backoffMs: 30_000,
      recordOutboxOnDefer: true,
    },
    deps
  );

  assert.deepEqual(outboxRetries, [{ id: "s1", attemptCount: 1 }]);
});

test("FEA-4375: a no-backoff reason (ack_timeout) defers without a retry deadline", () => {
  const { deps } = makeRecordingDeps();
  const counter = new Map<string, number>();
  applyBoundedFailureFold(
    {
      ids: ["s1"],
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      counter,
      maxConsecutive: 3,
      reason: "ack_timeout",
      recoverable: true,
      backoffMs: null,
      recordOutboxOnDefer: false,
    },
    deps
  );

  assert.equal(counter.get("s1"), 1, "the counter incremented");
  assert.equal(
    deps.nextRetryAfterMs.has("s1"),
    false,
    "no retry deadline for a null-backoff reason — it re-attempts next tick"
  );
});

test("FEA-4375: countsToward:false defers every id and never counts or dead-letters", () => {
  const { deps, deadLettered, infos } = makeRecordingDeps();
  const counter = new Map<string, number>([
    ["s1", 4],
    ["s2", 9],
  ]);
  applyBoundedFailureFold(
    {
      ids: ["s1", "s2"],
      syncMode: AgentSessionSyncMode.Backfill,
      payloadBytes: 100,
      counter,
      maxConsecutive: 3,
      reason: "rate_limited",
      recoverable: true,
      backoffMs: 30_000,
      recordOutboxOnDefer: false,
      countsToward: false,
      deferLabel: "transport_unavailable (no compute target)",
    },
    deps
  );

  assert.equal(
    deadLettered.length,
    0,
    "no id dead-letters even though the counters exceed the budget"
  );
  assert.equal(counter.get("s1"), 4, "the counter was not mutated");
  assert.equal(counter.get("s2"), 9, "the counter was not mutated");
  assert.ok(
    deps.nextRetryAfterMs.has("s1"),
    "each id still deferred with backoff"
  );
  assert.ok(deps.nextRetryAfterMs.has("s2"));
  assert.match(
    infos[0],
    TRANSPORT_UNAVAILABLE_LABEL,
    "the deferLabel is used in the info log"
  );
});
