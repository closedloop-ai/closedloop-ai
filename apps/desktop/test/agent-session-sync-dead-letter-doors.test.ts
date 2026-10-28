/**
 * @file agent-session-sync-dead-letter-doors.test.ts
 * @description ISS-7564 coverage for the two RECOVERY exits and their re-arm.
 *
 * `recoverExpiredDeadLetters` claims the finite (transient) deadlines;
 * `promoteDeadLetterIfIdle` claims the infinite (permanently-stuck) ones. They
 * are DISJOINT BY DEADLINE, and that was the load-bearing invariant with
 * nothing asserting it: recovery skips only `retryAfterMs > nowMs`, so an
 * infinite deadline is excluded by arithmetic, while `firstPermanentlyStuckId`
 * picks only `=== POSITIVE_INFINITY`. A sign flip or a `>=` would let both
 * doors fire on the same id. The suite therefore drives the two over one mixed
 * set and asserts the partition is complementary AND order-independent.
 *
 * Unlike the cap (`-cap.test.ts`), these two re-queue the id onto a live lane
 * and deliberately DISCARD the durable re-pend's confirmation, so a failed
 * write costs only this process's hint — the fallback the cap does not have.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  promoteDeadLetterIfIdle,
  recoverExpiredDeadLetters,
  resetDeadLetterRevisitAfterDrainedAck,
} from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import {
  drainBackfillLane,
  FIXED_NOW_MS,
  type Harness,
  makeHarness,
  pinLifecycleClock,
  settleHandoffs,
} from "./agent-session-sync-dead-letter-fixtures.js";

pinLifecycleClock();

test("recoverExpiredDeadLetters recovers an elapsed deadline and skips one still inside its window", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("due", FIXED_NOW_MS);
  harness.deps.deadLetteredIds.set("early", FIXED_NOW_MS + 1);

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);

  assert.deepEqual(
    harness.deps.backfillQueue,
    ["due"],
    "a deadline exactly equal to now has elapsed"
  );
  assert.deepEqual([...harness.deps.deadLetteredIds.keys()], ["early"]);
});

test("recoverExpiredDeadLetters never recovers an infinite-deadline dead-letter", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);

  recoverExpiredDeadLetters(Number.MAX_SAFE_INTEGER, harness.deps);

  assert.equal(
    harness.deps.deadLetteredIds.has("stuck"),
    true,
    "a deterministic class must never be re-enqueued by the live recovery door"
  );
  assert.deepEqual(harness.deps.backfillQueue, []);
  assert.deepEqual(harness.outboxReEnqueues, []);
});

test("a recovered dead-letter clears its failure state, flips its outbox row, and re-enters the backfill lane", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("due", FIXED_NOW_MS - 1);
  harness.deps.deadLetterCountById.set("due", 3);

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);

  assert.deepEqual(harness.cleared, ["due"]);
  assert.deepEqual(harness.outboxReEnqueues, ["due"]);
  assert.deepEqual(harness.deps.backfillQueue, ["due"]);
  assert.equal(harness.deps.backfillQueuedIds.has("due"), true);
  assert.equal(
    harness.deps.deadLetterCountById.get("due"),
    3,
    "the progressive escalation counter survives recovery — only a verified ack clears it"
  );
});

test("recoverExpiredDeadLetters names the recovered ids in a warning and stays silent when nothing is due", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("early", FIXED_NOW_MS + 1);

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);
  // Length, not `deepEqual(…, [])`: under `node:assert/strict` that call is a
  // typed assertion, and matching against an empty literal narrows `warnings`
  // to `never[]` for the rest of the test body.
  assert.equal(
    harness.warnings.length,
    0,
    "an untouched retry window must not produce a recovery warning"
  );

  harness.deps.deadLetteredIds.set("due", FIXED_NOW_MS);
  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);

  assert.equal(harness.warnings.length, 1);
  assert.equal(
    harness.warnings.some((message) => message.includes("due")),
    true,
    "an abandoned session is never silently dropped — the warning must name it"
  );
});

test("recovery does not push an id already queued on the backfill lane a second time", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("dup", FIXED_NOW_MS);
  harness.deps.backfillQueuedIds.add("dup");
  harness.deps.backfillQueue.push("dup");

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);

  assert.deepEqual(harness.deps.backfillQueue, ["dup"]);
  assert.deepEqual(
    harness.outboxReEnqueues,
    ["dup"],
    "the durable outbox row still flips back to pending"
  );
  assert.equal(harness.deps.deadLetteredIds.has("dup"), false);
});

test("recovery does not push an id already queued on the incremental lane onto backfill", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("dup", FIXED_NOW_MS);
  harness.deps.incrementalQueuedIds.add("dup");
  harness.deps.incrementalQueue.push("dup");

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);

  assert.deepEqual(harness.deps.backfillQueue, []);
  assert.equal(harness.deps.backfillQueuedIds.has("dup"), false);
  assert.deepEqual(harness.outboxReEnqueues, ["dup"]);
});

/**
 * Each entry closes exactly ONE promotion gate with everything else open, so a
 * gate that stops blocking fails on its own line rather than hiding behind a
 * sibling.
 */
const PROMOTION_GATES: Array<{
  name: string;
  close: (harness: Harness) => void;
}> = [
  {
    name: "historical backfill is disabled",
    close: (harness) => {
      harness.scalars.backfillEnabled = false;
    },
  },
  {
    name: "a revisit already happened this idle cycle",
    close: (harness) => {
      harness.scalars.revisited = true;
    },
  },
  {
    name: "the incremental queue is not drained",
    close: (harness) => {
      harness.deps.incrementalQueue.push("live-a");
    },
  },
  {
    name: "the backfill queue is not drained",
    close: (harness) => {
      harness.deps.backfillQueue.push("catchup-a");
    },
  },
  {
    name: "a chunk send is still pending",
    close: (harness) => {
      harness.scalars.pendingChunks = true;
    },
  },
  {
    // Pins the OUTCOME, not the branch. `deadLetteredIds.size === 0` is a
    // fast path: delete it and `firstPermanentlyStuckId` walks the empty map
    // and returns null, which is the same observable result. No assertion
    // against these deps can separate the two, so this case does not claim to.
    name: "there is nothing set aside",
    close: (harness) => {
      harness.deps.deadLetteredIds.clear();
    },
  },
];

for (const gate of PROMOTION_GATES) {
  test(`promoteDeadLetterIfIdle promotes nothing while ${gate.name}`, () => {
    const harness = makeHarness();
    harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);
    gate.close(harness);
    const setAsideBefore = [...harness.deps.deadLetteredIds.keys()];
    const backfillBefore = [...harness.deps.backfillQueue];

    promoteDeadLetterIfIdle(harness.deps);

    assert.deepEqual([...harness.deps.deadLetteredIds.keys()], setAsideBefore);
    assert.deepEqual(harness.deps.backfillQueue, backfillBefore);
    assert.deepEqual(
      harness.guardWrites,
      [],
      "a blocked cycle must not burn the guard — that would strand the next promotion"
    );
    assert.deepEqual(harness.outboxReEnqueues, []);
    assert.deepEqual(harness.cleared, []);
  });
}

test("promoteDeadLetterIfIdle promotes exactly one permanently-stuck id, FIFO by insertion", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("stuck-first", Number.POSITIVE_INFINITY);
  harness.deps.deadLetteredIds.set("stuck-second", Number.POSITIVE_INFINITY);

  promoteDeadLetterIfIdle(harness.deps);

  assert.deepEqual(harness.deps.backfillQueue, ["stuck-first"]);
  assert.deepEqual(
    [...harness.deps.deadLetteredIds.keys()],
    ["stuck-second"],
    "a large stranded set drains one per idle cycle, not all at once"
  );
  assert.equal(harness.scalars.revisited, true);
  assert.deepEqual(harness.cleared, ["stuck-first"]);
  assert.deepEqual(harness.outboxReEnqueues, ["stuck-first"]);

  // Drain the lane so the queue gates re-open: only the once-per-idle-cycle
  // guard should still be holding the second id back.
  drainBackfillLane(harness.deps);
  promoteDeadLetterIfIdle(harness.deps);

  assert.deepEqual(harness.deps.backfillQueue, []);
  assert.deepEqual([...harness.deps.deadLetteredIds.keys()], ["stuck-second"]);
});

test("promoteDeadLetterIfIdle leaves a finite-deadline dead-letter alone and does not burn the idle-cycle guard", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("transient", FIXED_NOW_MS + 1000);

  promoteDeadLetterIfIdle(harness.deps);

  assert.equal(harness.deps.deadLetteredIds.has("transient"), true);
  assert.deepEqual(harness.deps.backfillQueue, []);
  assert.equal(
    harness.scalars.revisited,
    false,
    "burning the guard on a cycle that promoted nothing would strand the next permanently-stuck id"
  );
});

test("promoteDeadLetterIfIdle skips past finite-deadline entries to the first permanently-stuck id", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("transient", FIXED_NOW_MS + 1000);
  harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);

  promoteDeadLetterIfIdle(harness.deps);

  assert.deepEqual(harness.deps.backfillQueue, ["stuck"]);
  assert.deepEqual(
    [...harness.deps.deadLetteredIds.keys()],
    ["transient"],
    "the transient entry stays on its own progressive-backoff schedule"
  );
});

test("a promoted dead-letter already tracked on the incremental lane is not pushed onto backfill", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);
  // Tracked but not queued, so the drained-queue gate stays open and the
  // defensive duplicate-push guard is the only thing under test.
  harness.deps.incrementalQueuedIds.add("stuck");

  promoteDeadLetterIfIdle(harness.deps);

  assert.deepEqual(harness.deps.backfillQueue, []);
  assert.equal(harness.deps.deadLetteredIds.has("stuck"), false);
  assert.deepEqual(harness.outboxReEnqueues, ["stuck"]);
});

test("resetDeadLetterRevisitAfterDrainedAck re-arms the guard after a promoted dead-letter drains", () => {
  const harness = makeHarness();
  harness.scalars.revisited = true;
  harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);

  resetDeadLetterRevisitAfterDrainedAck(harness.deps);

  assert.deepEqual(harness.guardWrites, [false]);
  assert.equal(harness.scalars.revisited, false);
});

/**
 * The re-arm must fire only after a genuine drain. Each entry closes one of the
 * five conjunctive conditions, and every case asserts the guard was never
 * WRITTEN — reading the scalar back cannot distinguish "the gate blocked it"
 * from "it wrote the `false` that was already there", which is exactly the hole
 * the never-armed case would otherwise fall into.
 */
const RESET_BLOCKERS: Array<{
  name: string;
  close: (harness: Harness) => void;
}> = [
  {
    name: "the guard was never armed",
    close: (harness) => {
      harness.scalars.revisited = false;
    },
  },
  {
    name: "nothing is left set aside",
    close: (harness) => {
      harness.deps.deadLetteredIds.clear();
    },
  },
  {
    name: "the incremental queue is not drained",
    close: (harness) => {
      harness.deps.incrementalQueue.push("live-a");
    },
  },
  {
    name: "the backfill queue is not drained",
    close: (harness) => {
      harness.deps.backfillQueue.push("catchup-a");
    },
  },
  {
    name: "a chunk send is still pending",
    close: (harness) => {
      harness.scalars.pendingChunks = true;
    },
  },
];

for (const blocker of RESET_BLOCKERS) {
  test(`resetDeadLetterRevisitAfterDrainedAck does not re-arm while ${blocker.name}`, () => {
    const harness = makeHarness();
    harness.scalars.revisited = true;
    harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);
    blocker.close(harness);
    const guardBefore = harness.scalars.revisited;

    resetDeadLetterRevisitAfterDrainedAck(harness.deps);

    assert.deepEqual(
      harness.guardWrites,
      [],
      "re-arming outside a real drain would reopen the hot-loop the guard exists to stop"
    );
    assert.equal(harness.scalars.revisited, guardBefore);
  });
}

/** One mixed set-aside set: due transient, in-window transient, stuck. */
const MIXED_SET_ASIDE: ReadonlyArray<readonly [string, number]> = [
  ["transient-due", FIXED_NOW_MS],
  ["transient-early", FIXED_NOW_MS + 1],
  ["stuck", Number.POSITIVE_INFINITY],
];

function seedMixedSetAside(harness: Harness): void {
  for (const [id, deadline] of MIXED_SET_ASIDE) {
    harness.deps.deadLetteredIds.set(id, deadline);
  }
}

test("recover and promote claim disjoint halves of the same set-aside set", () => {
  // Two INDEPENDENTLY seeded harnesses, not one set run through both doors in
  // sequence. Run sequentially, the first door deletes what it claims, so the
  // second could not return the same id even if their predicates did overlap —
  // the emptiness of the intersection would be an artifact of the setup rather
  // than evidence about the predicates. Given each door the whole set, an
  // overlap can actually show up.
  const recoverOnly = makeHarness();
  seedMixedSetAside(recoverOnly);
  recoverExpiredDeadLetters(FIXED_NOW_MS, recoverOnly.deps);
  const recovered = [...recoverOnly.deps.backfillQueue];

  const promoteOnly = makeHarness();
  seedMixedSetAside(promoteOnly);
  promoteDeadLetterIfIdle(promoteOnly.deps);
  const promoted = [...promoteOnly.deps.backfillQueue];

  assert.deepEqual(recovered, ["transient-due"]);
  assert.deepEqual(promoted, ["stuck"]);
  assert.deepEqual(
    recovered.filter((id) => promoted.includes(id)),
    [],
    "a sign flip or a >= would let both doors fire on the same id"
  );
  assert.deepEqual(
    [...recovered, ...promoted].sort(),
    ["stuck", "transient-due"],
    "between them the two doors claim every id whose window has passed, and only those"
  );
});

test("running both doors over one set leaves only the id still inside its retry window", () => {
  const harness = makeHarness();
  seedMixedSetAside(harness);

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);
  const recovered = drainBackfillLane(harness.deps);

  promoteDeadLetterIfIdle(harness.deps);
  const promoted = drainBackfillLane(harness.deps);

  assert.deepEqual(recovered, ["transient-due"]);
  assert.deepEqual(promoted, ["stuck"]);
  assert.deepEqual(
    [...harness.deps.deadLetteredIds.keys()],
    ["transient-early"],
    "only the id still inside its retry window stays set aside"
  );
});

test("the deadline partition holds in either order — promoting first still leaves the due transient to recovery", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("transient-due", FIXED_NOW_MS);
  harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);

  promoteDeadLetterIfIdle(harness.deps);
  const promoted = drainBackfillLane(harness.deps);

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);
  const recovered = drainBackfillLane(harness.deps);

  assert.deepEqual(promoted, ["stuck"]);
  assert.deepEqual(recovered, ["transient-due"]);
  assert.equal(harness.deps.deadLetteredIds.size, 0);
});

test("both exit doors durably flip the outbox row back to pending", () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("transient-due", FIXED_NOW_MS);
  harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);
  drainBackfillLane(harness.deps);
  promoteDeadLetterIfIdle(harness.deps);

  assert.deepEqual(
    harness.outboxReEnqueues,
    ["transient-due", "stuck"],
    "a restart before the re-queued session re-syncs would otherwise strand it"
  );
});

test("a recovery door still frees the id when the durable re-pend reports failure", async () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("transient-due", FIXED_NOW_MS);
  harness.deps.deadLetteredIds.set("stuck", Number.POSITIVE_INFINITY);
  harness.handoff.respond = () => Promise.resolve(false);

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);
  drainBackfillLane(harness.deps);
  promoteDeadLetterIfIdle(harness.deps);
  await settleHandoffs();

  assert.equal(
    harness.deps.deadLetteredIds.size,
    0,
    "these two doors keep a live lane to retry on, so they release on the enqueue rather than on the confirmation"
  );
});

test("a recovery door does not surface a rejected durable re-pend to its caller", async () => {
  const harness = makeHarness();
  harness.deps.deadLetteredIds.set("transient-due", FIXED_NOW_MS);
  harness.handoff.respond = () =>
    Promise.reject(new Error("db-host IPC fault"));

  recoverExpiredDeadLetters(FIXED_NOW_MS, harness.deps);
  await settleHandoffs();

  assert.deepEqual(harness.deps.backfillQueue, ["transient-due"]);
  assert.equal(harness.deps.deadLetteredIds.has("transient-due"), false);
});
