/**
 * @file agent-session-sync-dead-letter-cap.test.ts
 * @description ISS-7564 coverage for `enforceDeadLetterCap` — the third exit.
 *
 * The cap bounds both the in-memory `deadLetteredIds` Map and the
 * `dead_lettered_ids` JSON that `persistCursorIfCaughtUp` serializes from its
 * keys. It evicts OLDEST-FIRST by Map insertion order and must drop the id from
 * all four per-id maps: a missed map is a slow leak plus a stale counter later
 * charged to a recycled id.
 *
 * ISS-7216 (#5708) made this exit confirmation-gated. It is the only door that
 * REMOVES an id rather than re-queueing it, so the durable outbox row is the
 * only record left once it acts — and an id is therefore released only after
 * `recordOutboxReEnqueue` resolves `true`, which is the source reading the row
 * back rather than the mere absence of a throw. That makes eviction
 * ASYNCHRONOUS, so every assertion here settles the hand-offs first; asserting
 * on the synchronous return would read the set before any eviction could have
 * happened and pass for the wrong reason.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_DEAD_LETTERED_IDS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { enforceDeadLetterCap } from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import {
  allPerIdMaps,
  makeHarness,
  pinLifecycleClock,
  seedDeadLetters,
  settleHandoffs,
} from "./agent-session-sync-dead-letter-fixtures.js";
import { deferred } from "./deferred.js";

pinLifecycleClock();

test("enforceDeadLetterCap evicts nothing at exactly MAX_DEAD_LETTERED_IDS", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS);

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.size, MAX_DEAD_LETTERED_IDS);
  assert.equal(harness.deps.deadLetteredIds.has("dl-0"), true);
  assert.deepEqual(
    harness.outboxReEnqueues,
    [],
    "at the cap nothing is over it, so no durable hand-off may be requested"
  );
});

test("enforceDeadLetterCap evicts the oldest id from ALL FOUR per-id maps at the cap + 1", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 1);
  const newestId = `dl-${MAX_DEAD_LETTERED_IDS}`;

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.size, MAX_DEAD_LETTERED_IDS);
  for (const { label, map } of allPerIdMaps(harness.deps)) {
    assert.equal(
      map.has("dl-0"),
      false,
      `${label} still holds the evicted id — a missed map is a slow leak plus a stale counter charged to a recycled id`
    );
    assert.equal(
      map.has(newestId),
      true,
      `${label} dropped the newest id instead of the oldest`
    );
  }
});

test("enforceDeadLetterCap evicts oldest-first for an overflow greater than one", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 3);

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.size, MAX_DEAD_LETTERED_IDS);
  for (const evicted of ["dl-0", "dl-1", "dl-2"]) {
    assert.equal(harness.deps.deadLetteredIds.has(evicted), false);
  }
  assert.equal(harness.deps.deadLetteredIds.has("dl-3"), true);
});

test("a re-set id keeps its original insertion slot, so eviction still targets the longest-ago dead-letter", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS);
  // Re-stamping the oldest id must NOT move it to the back of the queue.
  harness.deps.deadLetteredIds.set("dl-0", Number.POSITIVE_INFINITY);
  harness.deps.deadLetteredIds.set("dl-newest", Number.POSITIVE_INFINITY);

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.has("dl-0"), false);
  assert.equal(harness.deps.deadLetteredIds.has("dl-newest"), true);
});

test("eviction hands the row back to the durable outbox before releasing it", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 1);

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.deepEqual(
    harness.outboxReEnqueues,
    ["dl-0"],
    "the cap is a door out of deadLetteredIds, so it owes the same durable re-pend the other two perform"
  );
});

test("an unconfirmed hand-off keeps the id, its deadline and its escalation counter", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 1);
  const deadlineBefore = harness.deps.deadLetteredIds.get("dl-0");
  harness.handoff.respond = () => Promise.resolve(false);

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(
    harness.deps.deadLetteredIds.size,
    MAX_DEAD_LETTERED_IDS + 1,
    "an unconfirmed row is still owed, so memory yields to durability and nothing is dropped"
  );
  assert.equal(harness.deps.deadLetteredIds.get("dl-0"), deadlineBefore);
  for (const { label, map } of allPerIdMaps(harness.deps)) {
    assert.equal(
      map.has("dl-0"),
      true,
      `${label} dropped an id whose hand-off was never confirmed`
    );
  }
  assert.equal(
    harness.deps.deadLetterCountById.get("dl-0"),
    1,
    "a retried eviction must not restart the FEA-3795 progressive backoff"
  );
});

test("a hand-off that throws is folded into unconfirmed rather than escaping", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 1);
  harness.handoff.respond = () =>
    Promise.reject(new Error("db-host IPC fault"));

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(
    harness.deps.deadLetteredIds.has("dl-0"),
    true,
    "a rejected write is the failure mode that DOES throw; it must still leave the session in the set"
  );
  assert.equal(harness.deps.deadLetteredIds.size, MAX_DEAD_LETTERED_IDS + 1);
});

test("a stranded hand-off warns, naming how many of the batch stayed behind", async () => {
  const harness = makeHarness();
  // Three evicted, ONE stranded: an asymmetric batch. A symmetric one (1 of 2)
  // cannot tell the stranded tally from its own complement, so a counter that
  // filtered on confirmed-instead-of-stranded would report the same number and
  // the alarm would name the wrong sessions.
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 3);
  harness.handoff.respond = (id) => Promise.resolve(id !== "dl-0");

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.has("dl-0"), true);
  assert.equal(harness.deps.deadLetteredIds.has("dl-1"), false);
  assert.equal(harness.deps.deadLetteredIds.has("dl-2"), false);
  assert.equal(
    harness.warnings.some((message) => message.includes("1 of 3")),
    true,
    `a partially-stranded batch must say so; warnings were ${JSON.stringify(harness.warnings)}`
  );
});

test("a fully-confirmed eviction raises no stranded alarm", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 2);

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.size, MAX_DEAD_LETTERED_IDS);
  // Exactly one WARN — the "requested" line. The stranded line is an alarm on a
  // monitored log, so raising it on every clean eviction would train the reader
  // to ignore the case it exists to report. Counted rather than pattern-matched
  // so this does not become an assertion about log prose.
  assert.equal(
    harness.warnings.length,
    1,
    `a clean batch strands nothing; warnings were ${JSON.stringify(harness.warnings)}`
  );
});

test("a later cap pass retries an id whose earlier hand-off went unconfirmed", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 1);
  harness.handoff.respond = () => Promise.resolve(false);

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();
  assert.equal(harness.deps.deadLetteredIds.has("dl-0"), true);

  harness.handoff.respond = () => Promise.resolve(true);
  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.equal(
    harness.deps.deadLetteredIds.has("dl-0"),
    false,
    "the retry is what makes 'stays in the set' a deferral rather than a leak"
  );
  assert.deepEqual(harness.outboxReEnqueues, ["dl-0", "dl-0"]);
});

test("an in-flight hand-off is not requested a second time by an overlapping pass", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 1);
  const parked = deferred<boolean>();
  harness.handoff.respond = () => parked.promise;

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();
  // The first hand-off is still open, so the set is legitimately over the cap.
  // A second pass must recognize the id as already leaving rather than start a
  // duplicate durable write against a stalled ledger.
  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.deepEqual(
    harness.outboxReEnqueues,
    ["dl-0"],
    "an id already being handed off still counts against the overflow"
  );

  parked.resolve(true);
  await settleHandoffs();

  assert.equal(harness.deps.deadLetteredIds.has("dl-0"), false);
  assert.equal(harness.deps.deadLetteredIds.size, MAX_DEAD_LETTERED_IDS);
});

test("a later pass walks past the ids already in flight to the next unclaimed one", async () => {
  const harness = makeHarness();
  seedDeadLetters(harness, MAX_DEAD_LETTERED_IDS + 2);
  const parked = deferred<boolean>();
  harness.handoff.respond = () => parked.promise;

  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();
  assert.deepEqual(harness.outboxReEnqueues, ["dl-0", "dl-1"]);

  // A third id goes over the cap while the first two hand-offs are still open,
  // so this pass has real work to do — `starting` is 1, not 0. That is what
  // puts the two in-flight ids in front of the walk: skipping them is the only
  // thing standing between a stalled ledger and duplicate durable writes for
  // the same session.
  harness.deps.deadLetteredIds.set("dl-late", Number.POSITIVE_INFINITY);
  enforceDeadLetterCap(harness.deps);
  await settleHandoffs();

  assert.deepEqual(
    harness.outboxReEnqueues,
    ["dl-0", "dl-1", "dl-2"],
    "the walk must resume after the in-flight ids, not re-request the oldest"
  );
});
