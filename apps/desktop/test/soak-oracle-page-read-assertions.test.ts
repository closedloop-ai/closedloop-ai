/**
 * @file soak-oracle-page-read-assertions.test.ts
 * @description Counterfactual coverage for how a cycle is GRADED — ISS-6100 (an
 * empty list scored as a successful read, and the population-establishment step
 * that short-detection depends on) and ISS-6098 (the baseline encoded the
 * pending-outbox subset rather than the population that may legitimately reach
 * the cloud).
 *
 * Split from `soak-oracle-content-assertions.test.ts`, which covers the other
 * oracle: what the cloud retained of a payload's CONTENT. Shared fixtures live
 * in `soak/soak-oracle-test-support.ts`.
 *
 * As there, every test induces the failure its assertion exists to catch: a
 * grading rule that cannot fail is the bug these tickets are about.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildRecord,
  readBackEntry,
  readBackFixture,
  statsFixture,
} from "./soak/soak-oracle-test-support";
import {
  applyPageReadGrade,
  establishPageReadPopulation,
  gradePageRead,
  newPageReadStats,
  PageReadOutcome,
  recordPageReadSample,
} from "./soak/soak-page-read";

describe("ISS-6100: a page read is graded on content, not on the presence of a key", () => {
  test("COUNTERFACTUAL — an empty list no longer scores ok", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    const grade = gradePageRead({ list: { items: [], total: 0 } }, 2962);
    assert.equal(grade.outcome, PageReadOutcome.Empty);
    applyPageReadGrade(stats, grade, 12);
    assert.equal(stats.ok, 0);
    assert.equal(stats.empty, 1);
  });

  test('COUNTERFACTUAL — the pre-fix shape `{ list: [] }` that satisfied `"list" in result` is malformed', () => {
    const grade = gradePageRead({ list: [] }, 2962);
    assert.equal(grade.outcome, PageReadOutcome.Malformed);
  });

  test("COUNTERFACTUAL — a NaN total is malformed, not a passing read", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    // `typeof NaN === "number"`, so a bare type check admits it — and then
    // `NaN < expectedTotal` is false, so the short-read check waves it through
    // and the cycle scores a read that answered with nothing meaningful.
    const grade = gradePageRead(
      { list: { items: [{ id: "s1" }], total: Number.NaN } },
      2962
    );
    assert.equal(grade.outcome, PageReadOutcome.Malformed);
    applyPageReadGrade(stats, grade, 12);
    assert.equal(stats.ok, 0);
    assert.equal(stats.errors, 1);
    // And it never reaches `Math.min`, so it cannot poison the cycle's
    // shortest-total for every later comparison.
    assert.equal(stats.shortestTotal, null);
  });

  test("COUNTERFACTUAL — a NaN establishing read establishes nothing rather than disabling short-detection", async () => {
    const stats = newPageReadStats();
    const established = await establishPageReadPopulation(
      async () => ({
        result: { list: { items: [{ id: "s1" }], total: Number.NaN } },
        timedOut: false,
        elapsedMs: 5,
      }),
      stats
    );
    // An established `NaN` would make every later `total < expectedTotal`
    // false — short-detection silently off for the whole cycle.
    assert.equal(established, null);
    assert.equal(stats.expectedTotal, null);
  });

  test("COUNTERFACTUAL — a total below the item count it just returned is malformed", () => {
    const grade = gradePageRead(
      { list: { items: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], total: 2 } },
      null
    );
    assert.equal(grade.outcome, PageReadOutcome.Malformed);
  });

  test("COUNTERFACTUAL — a negative or fractional total is malformed", () => {
    assert.equal(
      gradePageRead({ list: { items: [{ id: "s1" }], total: -1 } }, null)
        .outcome,
      PageReadOutcome.Malformed
    );
    assert.equal(
      gradePageRead({ list: { items: [{ id: "s1" }], total: 12.5 } }, null)
        .outcome,
      PageReadOutcome.Malformed
    );
  });

  test("a genuine zero total with zero items is EMPTY, not malformed", () => {
    // The other direction: 0 is a legitimate population, and tightening the
    // total check must not turn a real empty page into a parse error.
    const grade = gradePageRead({ list: { items: [], total: 0 } }, null);
    assert.equal(grade.outcome, PageReadOutcome.Empty);
    assert.equal(grade.total, 0);
  });

  test("a total exactly equal to the item count is a legitimate complete read", () => {
    const grade = gradePageRead(
      { list: { items: [{ id: "s1" }, { id: "s2" }], total: 2 } },
      2
    );
    assert.equal(grade.outcome, PageReadOutcome.Ok);
    assert.equal(grade.total, 2);
  });

  test("COUNTERFACTUAL — a partial answer below the established population is short", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    const grade = gradePageRead(
      { list: { items: [{ id: "s1" }], total: 1400 } },
      2962
    );
    assert.equal(grade.outcome, PageReadOutcome.Short);
    applyPageReadGrade(stats, grade, 9);
    assert.equal(stats.ok, 0);
    assert.equal(stats.short, 1);
    assert.equal(stats.shortestTotal, 1400);
  });

  test("a complete answer scores ok and records its latency", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    const grade = gradePageRead(
      { list: { items: [{ id: "s1" }], total: 2962 } },
      2962
    );
    assert.equal(grade.outcome, PageReadOutcome.Ok);
    applyPageReadGrade(stats, grade, 42);
    assert.equal(stats.ok, 1);
    assert.deepEqual(stats.latenciesMs, [42]);
  });

  test("legitimate growth of the population is not a failure", () => {
    const grade = gradePageRead(
      { list: { items: [{ id: "s1" }], total: 2970 } },
      2962
    );
    assert.equal(grade.outcome, PageReadOutcome.Ok);
  });

  test("an empty or short read fails the readsAnswer invariant that previously passed", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: readBackFixture([readBackEntry("session-a")]),
      pageReads: {
        ...newPageReadStats(),
        ok: 30,
        empty: 4,
        expectedTotal: 2962,
      },
    });
    assert.equal(record.invariants.readsAnswer, false);
    assert.ok(
      record.failReasons.some((reason) => reason.includes("4 empty")),
      JSON.stringify(record.failReasons)
    );
  });
});

describe("ISS-6100: the population-establishment step itself", () => {
  test("a healthy establishing read pins the population for the rest of the cycle", async () => {
    const stats = newPageReadStats();
    const total = await establishPageReadPopulation(
      async () => ({
        result: { list: { items: [{ id: "s1" }], total: 2962 } },
        elapsedMs: 12,
        timedOut: false,
      }),
      stats
    );
    assert.equal(total, 2962);
    assert.equal(stats.expectedTotal, 2962);
  });

  test("COUNTERFACTUAL — a DEGENERATE establishing read establishes nothing, so short-detection is not silently disabled", async () => {
    const stats = newPageReadStats();
    const total = await establishPageReadPopulation(
      async () => ({
        result: { list: { items: [], total: 0 } },
        elapsedMs: 12,
        timedOut: false,
      }),
      stats
    );
    assert.equal(total, null);
    assert.equal(stats.expectedTotal, null);
  });

  test("COUNTERFACTUAL — a timed-out or throwing establishing read establishes nothing", async () => {
    const timedOutStats = newPageReadStats();
    assert.equal(
      await establishPageReadPopulation(
        async () => ({ result: null, elapsedMs: 10_000, timedOut: true }),
        timedOutStats
      ),
      null
    );
    const throwingStats = newPageReadStats();
    assert.equal(
      await establishPageReadPopulation(() => {
        throw new Error("IPC gone");
      }, throwingStats),
      null
    );
    assert.equal(throwingStats.expectedTotal, null);
  });

  test("recordPageReadSample folds a timeout as a timeout and a degenerate answer as empty", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    recordPageReadSample(stats, {
      result: null,
      elapsedMs: 10_000,
      timedOut: true,
    });
    recordPageReadSample(stats, {
      result: { list: { items: [], total: 0 } },
      elapsedMs: 8,
      timedOut: false,
    });
    assert.equal(stats.timeouts, 1);
    assert.equal(stats.empty, 1);
    assert.equal(stats.ok, 0);
  });
});

describe("ISS-6098: membership is asserted against baseline ∪ local corpus", () => {
  test("a session delivered outside the pending baseline but present locally is a backfill, not a fail", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a", "backfilled-1"] }),
      readBack: readBackFixture([
        readBackEntry("session-a"),
        readBackEntry("backfilled-1"),
      ]),
      baseline: ["session-a"],
      localSessionIds: ["session-a", "backfilled-1"],
    });
    assert.equal(record.backfilledSyncedCount, 1);
    assert.equal(record.extraSyncedCount, 0);
    assert.ok(
      !record.failReasons.some((reason) => reason.startsWith("extra_synced")),
      JSON.stringify(record.failReasons)
    );
  });

  test("COUNTERFACTUAL — a delivered id present in NEITHER the baseline nor the local corpus still fails", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a", "ghost-1"] }),
      readBack: readBackFixture([
        readBackEntry("session-a"),
        readBackEntry("ghost-1"),
      ]),
      baseline: ["session-a"],
      localSessionIds: ["session-a"],
    });
    assert.equal(record.extraSyncedCount, 1);
    assert.deepEqual(record.unknownSyncedSample, ["ghost-1"]);
    assert.ok(
      record.failReasons.includes("extra_synced:1"),
      JSON.stringify(record.failReasons)
    );
  });

  test("ISS-6101 NON-MASKING — the corrected baseline still catches a genuine duplicate delivery", () => {
    const record = buildRecord({
      mode: "clean",
      stats: statsFixture({
        syncedSessionIds: ["session-a", "backfilled-1"],
        // The ISS-6101 axis: a session fully delivered TWICE in a clean cycle at
        // the SAME revision — the same payload arriving twice, which the upsert
        // cannot justify as a rebuild. The session-level count carries the same
        // volume, but it is the (session, revision) map that scores the dup.
        deliveriesBySession: { "session-a": 2, "backfilled-1": 1 },
        deliveriesBySessionRevision: {
          "session-a#7": 2,
          "backfilled-1#7": 1,
        },
      }),
      readBack: readBackFixture([
        readBackEntry("session-a"),
        readBackEntry("backfilled-1"),
      ]),
      baseline: ["session-a"],
      localSessionIds: ["session-a", "backfilled-1"],
    });
    // The ISS-6098 narrowing applied…
    assert.equal(record.extraSyncedCount, 0);
    assert.equal(record.backfilledSyncedCount, 1);
    // …and the duplicate-delivery signal is untouched.
    assert.equal(record.invariants.noDup, false);
    assert.ok(
      record.failReasons.includes("dup:1"),
      JSON.stringify(record.failReasons)
    );
  });

  test("loss is still asserted against the pending outbox, which the narrowing does not widen", () => {
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: readBackFixture([readBackEntry("session-a")]),
      baseline: ["session-a", "session-b"],
      localSessionIds: ["session-a", "session-b", "session-c"],
    });
    assert.equal(record.lostSessionCount, 1);
    assert.ok(
      record.failReasons.includes("loss:1"),
      JSON.stringify(record.failReasons)
    );
  });
});
