/**
 * @file soak-page-read-dispatch-coverage.test.ts
 * @description ISS-6102 — a dispatch percentile never outruns the population it
 * was measured over.
 *
 * The phase split (`soak-page-read-phase-split.test.ts`) answers WHERE a timed
 * out read lost its deadline, and reports the outbound hop as a number beside
 * that answer. This file owns the question that number raises about itself:
 * how much of the population it was actually computed over.
 *
 * BOTH populations, because the defect is the same on each. A timeout only
 * contributes a dispatch number when its in-flight mark was readable, and an ok
 * read only when its start instant yields a usable cross-process delta — so
 * each series is a subset, and on a wedged or heavily loaded renderer it can be
 * a very small and very non-random one. A p50 published off that subset reads
 * as a statement about every read in its population, which is the same
 * false-completeness defect the phase split exists to remove, reintroduced one
 * level up in the split's own output. A biased subset presented as the whole is
 * worse than no metric at all here, because this number is what a lane rules
 * the outbound hop out with.
 *
 * Every test below induces that misreading and asserts it cannot survive.
 *
 * Split from `soak-page-read-phase-split.test.ts` so each file carries one
 * oracle question, and to keep both under the repo's 1,000-line ceiling.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildRecord,
  DEADLINE_AT,
  IMMEDIATELY,
  NEVER,
  OK_PAGE_DATA,
  okSample,
  READ_ID,
  READ_STARTED_AT,
  readBackEntry,
  readBackFixture,
  SETTLED_EARLY_AT,
  statsFixture,
  timeoutSample,
} from "./soak/soak-oracle-test-support";
import {
  newPageReadStats,
  PageReadTimeoutPhase,
  raceReadAgainstDeadline,
  recordPageReadSample,
} from "./soak/soak-page-read";
import type { PageReadStats } from "./soak/soak-types";

/**
 * A 20ms dispatch p50 stated BARE — no population behind it.
 *
 * Asserted both ways on purpose. On a partially measured cycle this is the
 * pre-fix output and must be gone; on a fully measured one it is the correct
 * output and must be present. One regex, opposite expectations, is what proves
 * the annotation tracks coverage instead of being pasted onto every line.
 */
const BARE_20MS_DISPATCH = /dispatch p50 20ms\)/;
/**
 * The case raised in review on PR #5211, verbatim: one readable 20ms mark and
 * 99 unreadable ones, every timeout in a REAL phase so `unknown` reads 0 and
 * the coverage cannot be recovered from the phase counts either.
 */
const ONE_IN_HUNDRED_DISPATCH_FAIL_LINE =
  /100 timeouts \(0 pre-renderer 100 in-renderer 0 above-renderer 0 unknown, dispatch p50 20ms \(1\/100 measured\)\)/;
/** The annotation itself, in any shape, for the no-noise assertion. */
const COVERAGE_SUFFIX = /\d+\/\d+ measured/;
/** The ok population's coverage annotation, which rides the cycle's notes. */
const OK_DISPATCH_COVERAGE_NOTE = /^page_read_dispatch_unmeasured:/;

function recordFromPageReads(stats: PageReadStats) {
  return buildRecord({
    stats: statsFixture({ syncedSessionIds: ["session-a"] }),
    readBack: readBackFixture([readBackEntry("session-a")]),
    pageReads: stats,
  });
}

function findPageReadsFailLine(record: ReturnType<typeof recordFromPageReads>) {
  return record.failReasons.find((entry) => entry.startsWith("page_reads:"));
}

describe("ISS-6102: a dispatch percentile never outruns the population it was measured over", () => {
  test("COUNTERFACTUAL — 1 measured 20ms dispatch beside 99 unreadable marks reports its coverage, not a bare p50", () => {
    // The exact case raised in review. Pre-fix this cycle printed
    // `dispatch p50 20ms`, which a lane reads as having ruled the outbound hop
    // out — on evidence covering one timeout in a hundred. The 99 omissions are
    // deliberately given a REAL phase here, so `unknown` reads 0 and the phase
    // counts offer no way to notice the subset either: coverage has to be
    // stated by the number itself or it is not stated anywhere.
    const stats = newPageReadStats();
    recordPageReadSample(
      stats,
      timeoutSample(20, PageReadTimeoutPhase.InRenderer)
    );
    for (let index = 0; index < 99; index += 1) {
      recordPageReadSample(
        stats,
        timeoutSample(null, PageReadTimeoutPhase.InRenderer)
      );
    }

    assert.equal(stats.timeouts, 100);
    assert.equal(stats.timeoutPhases.unknown, 0);
    assert.equal(stats.timeoutDispatchUnmeasured, 99);

    const record = recordFromPageReads(stats);
    assert.equal(record.pageReads.timeoutDispatchP50Ms, 20);
    assert.equal(record.pageReads.timeoutDispatchMeasured, 1);
    assert.equal(record.pageReads.timeoutDispatchUnmeasured, 99);
    assert.equal(
      record.pageReads.timeoutDispatchMeasured +
        record.pageReads.timeoutDispatchUnmeasured,
      record.pageReads.timeouts,
      "a timeout counted in the total but in neither dispatch tally would put the coverage claim back out of reach"
    );

    const reason = findPageReadsFailLine(record);
    assert.ok(reason, JSON.stringify(record.failReasons));
    assert.match(reason, ONE_IN_HUNDRED_DISPATCH_FAIL_LINE);
    assert.doesNotMatch(
      reason,
      BARE_20MS_DISPATCH,
      "the pre-fix line stated 20ms with nothing behind it; a percentile over 1% of the population must never be presented as the population's"
    );
  });

  test("COUNTERFACTUAL — a usable settledAt with an unusable startedAt is counted as unmeasured, not lost", async () => {
    // The second half of the same defect. This mark answers the PHASE question
    // perfectly well, so it is correctly not `unknown` — and that is exactly
    // why its missing dispatch used to vanish: it appeared in no counter at
    // all. It has to land in the tally that is about dispatch.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: IMMEDIATELY,
      readRendererMark: () =>
        Promise.resolve({
          readId: READ_ID,
          startedAt: Number.NaN,
          settledAt: SETTLED_EARLY_AT,
        }),
    });

    assert.equal(sample.dispatchMs, null);
    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.AboveRenderer);

    const stats = newPageReadStats();
    recordPageReadSample(stats, sample);

    assert.equal(
      stats.timeoutDispatchUnmeasured,
      1,
      "the omission has to be visible in a counter; keeping only the phase is how it escaped"
    );
    assert.deepEqual(stats.timeoutDispatchLatenciesMs, []);
    assert.equal(
      stats.timeoutPhases.aboveRenderer,
      1,
      "and the sound phase must survive: reclassifying it `unknown` to signal the missing NUMBER would discard a measurement the settle instant fully supports"
    );
    assert.equal(stats.timeoutPhases.unknown, 0);
  });

  test("COUNTERFACTUAL — a fully measured population reports a plain percentile, with no coverage noise", () => {
    // The annotation must be a signal, not a decoration. A line that carried
    // `(3/3 measured)` on every cycle would be ignored within a week, and the
    // partial case would stop standing out — which is the only thing it is for.
    const stats = newPageReadStats();
    for (const dispatchMs of [10, 20, 30]) {
      recordPageReadSample(
        stats,
        timeoutSample(dispatchMs, PageReadTimeoutPhase.InRenderer)
      );
    }

    assert.equal(stats.timeoutDispatchUnmeasured, 0);

    const record = recordFromPageReads(stats);
    assert.equal(record.pageReads.timeoutDispatchP50Ms, 20);
    assert.equal(record.pageReads.timeoutDispatchMeasured, 3);
    assert.equal(record.pageReads.timeoutDispatchUnmeasured, 0);

    const reason = findPageReadsFailLine(record);
    assert.ok(reason, JSON.stringify(record.failReasons));
    assert.match(reason, BARE_20MS_DISPATCH);
    assert.doesNotMatch(
      reason,
      COVERAGE_SUFFIX,
      "a complete population states its percentile and nothing else"
    );
  });
});

describe("ISS-6102: the SETTLED reads' dispatch percentile carries its coverage too", () => {
  test("COUNTERFACTUAL — 1 measured 20ms dispatch beside 99 unmeasured ok reads publishes its coverage, not a bare p50", () => {
    // The sibling of the timeout case above, on the population nothing was
    // reporting coverage for. `recordPageReadSample` drops an otherwise-ok
    // sample whose `dispatchMs` is null, so `dispatchP50Ms: 20` used to be the
    // row's ONLY statement about a hundred reads — indistinguishable from a
    // cycle that measured every one of them, and read the same way: as having
    // ruled the outbound hop out.
    const stats = newPageReadStats();
    recordPageReadSample(stats, okSample(20));
    for (let index = 0; index < 99; index += 1) {
      recordPageReadSample(stats, okSample(null));
    }

    assert.equal(stats.ok, 100);
    assert.equal(stats.dispatchUnmeasured, 99);
    assert.deepEqual(stats.dispatchLatenciesMs, [20]);

    const record = recordFromPageReads(stats);
    assert.equal(record.pageReads.dispatchP50Ms, 20);
    assert.equal(record.pageReads.dispatchMeasured, 1);
    assert.equal(record.pageReads.dispatchUnmeasured, 99);
    assert.equal(
      record.pageReads.dispatchMeasured + record.pageReads.dispatchUnmeasured,
      record.pageReads.ok,
      "an ok read counted in the total but in neither dispatch tally would put the coverage claim back out of reach"
    );
    assert.notEqual(
      record.pageReads.dispatchMeasured,
      record.pageReads.ok,
      "the fixture has to be PARTIALLY measured or it proves nothing about partial coverage"
    );
    // A cycle whose reads all answered prints no `page_reads:` line at all, so
    // the row's own note is where a partial ok population has to say so.
    assert.equal(record.invariants.readsAnswer, true);
    assert.ok(
      record.notes.some((note) => OK_DISPATCH_COVERAGE_NOTE.test(note)),
      `a passing cycle must still state its ok-dispatch coverage: ${JSON.stringify(record.notes)}`
    );
    assert.ok(record.notes.includes("page_read_dispatch_unmeasured:99/100"));
  });

  test("COUNTERFACTUAL — a fully measured ok population states a plain percentile and adds no note", () => {
    // Same discipline as the timeout side: the annotation is a signal, so it
    // must be absent whenever coverage is complete. A note on every cycle would
    // be ignored within a week and the partial case would stop standing out.
    const stats = newPageReadStats();
    for (const dispatchMs of [10, 20, 30]) {
      recordPageReadSample(stats, okSample(dispatchMs));
    }

    assert.equal(stats.ok, 3);
    assert.equal(stats.dispatchUnmeasured, 0);

    const record = recordFromPageReads(stats);
    assert.equal(record.pageReads.dispatchP50Ms, 20);
    assert.equal(record.pageReads.dispatchMeasured, 3);
    assert.equal(record.pageReads.dispatchUnmeasured, 0);
    assert.equal(record.pageReads.dispatchMeasured, record.pageReads.ok);
    assert.deepEqual(
      record.notes.filter((note) => OK_DISPATCH_COVERAGE_NOTE.test(note)),
      [],
      "a complete population states its percentile and nothing else"
    );
  });

  test("COUNTERFACTUAL — a settled read whose instants order backwards is counted as unmeasured, not dropped", async () => {
    // The reachable production path the tally exists for, driven end to end
    // rather than hand-built: the renderer reports a start instant, the two
    // `Date.now()` reads come from different processes, and a wall-clock step
    // between them orders the delta negative. `dispatchLatency` refuses to
    // clamp that to a confident `0`, so the settled path really can hand the
    // recorder an ok sample with no dispatch number — and before this it landed
    // in no counter at all.
    const sample = await raceReadAgainstDeadline({
      evaluation: Promise.resolve({
        value: OK_PAGE_DATA,
        rendererMs: 18,
        rendererStartedAt: READ_STARTED_AT - 25,
      }),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => READ_STARTED_AT + 40,
      sleep: NEVER,
      readRendererMark: () => Promise.resolve(null),
    });

    assert.equal(sample.timedOut, false);
    assert.equal(sample.dispatchMs, null);

    const stats = newPageReadStats();
    recordPageReadSample(stats, sample);

    assert.equal(stats.ok, 1);
    assert.equal(
      stats.dispatchUnmeasured,
      1,
      "an ok read that measured no dispatch has to be visible in a counter; being merely absent from the series is how the omission escaped"
    );
    assert.deepEqual(stats.dispatchLatenciesMs, []);
    assert.equal(
      stats.timeoutDispatchUnmeasured,
      0,
      "and it must not leak into the timeout population's tally — the two coverages are read against different denominators"
    );
  });
});
