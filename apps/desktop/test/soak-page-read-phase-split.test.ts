/**
 * @file soak-page-read-phase-split.test.ts
 * @description ISS-6102 — counterfactual coverage for WHERE a page read spent
 * its deadline.
 *
 * Criterion 4 ("page-data reads always answer within deadline") failed in every
 * cycle measured on 2026-08-12 and was unmoved by ISS-6079 (#4890), a change to
 * db-host lane admission. It could not have been otherwise decided: the harness
 * times the read in the Playwright RUNNER process, so one number covers the
 * db-host read, the renderer/main IPC, and the runner's own CDP round trip. A
 * fix that moves the first segment reads as neutral if the deadline was lost in
 * the third, which is how a hypothesis about this metric got argued, merged, and
 * measured neutral.
 *
 * The split here is what makes the next run decide it instead. Every test
 * induces the confusion its assertion exists to catch — a phase that cannot be
 * distinguished, or a latency series that silently reports the runner's number
 * as the renderer's, would leave criterion 4 exactly as arguable as before.
 *
 * Split from `soak-oracle-page-read-assertions.test.ts` (which owns ISS-6100
 * content grading and ISS-6098 membership) so each file carries one oracle
 * question.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildRecord,
  DEADLINE_AT,
  EXPECTED_DEADLINE,
  IMMEDIATELY,
  NEVER,
  OK_PAGE_DATA,
  READ_ID,
  READ_STARTED_AT,
  readBackEntry,
  readBackFixture,
  SETTLED_EARLY_AT,
  statsFixture,
} from "./soak/soak-oracle-test-support";
import {
  classifyTimeoutPhase,
  newPageReadStats,
  PAGE_READ_DEADLINE_MS,
  type PageReadEvaluation,
  PageReadTimeoutPhase,
  raceReadAgainstDeadline,
  recordPageReadSample,
} from "./soak/soak-page-read";

/**
 * The exact criterion-4 failure line the phase counts below must produce.
 *
 * The coverage suffix is part of the pinned string, not decoration: this
 * fixture measures ONE of its ten timeouts, so a line reading a bare
 * `dispatch p50 40ms` would present a 1-in-10 subset as the whole population.
 */
const PHASE_SPLIT_FAIL_LINE =
  /10 timeouts \(4 pre-renderer 1 in-renderer 2 above-renderer 3 unknown, dispatch p50 40ms \(1\/10 measured\)\)/;
/**
 * The same line when no timeout carried a readable mark. Pinned separately
 * because `n/a` and `0ms` are the two answers a lane would act on in opposite
 * directions, and only one of them is true of an unmeasured hop.
 */
const UNMEASURED_DISPATCH_FAIL_LINE =
  /unknown, dispatch p50 n\/a \(0\/10 measured\)\)/;
const SHORT_LIST = { list: { items: [{ id: "a" }], total: 12 } };

describe("ISS-6102: a timed-out read says where the deadline was lost", () => {
  test("a renderer call still outstanding at the deadline is IN-renderer", () => {
    assert.equal(
      classifyTimeoutPhase(
        { readId: READ_ID, settledAt: null, startedAt: READ_STARTED_AT },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.InRenderer
    );
  });

  test("COUNTERFACTUAL — a renderer call that ALREADY settled is ABOVE-renderer, not in it", () => {
    // The discriminating sample: the runner lost a 10s deadline while the
    // renderer's own `pageData` had settled 1.4s in. Under the old single
    // number this was indistinguishable from a 10s db-host read, and it is
    // exactly the case a db-host fix cannot move.
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: READ_ID,
          settledAt: SETTLED_EARLY_AT,
          startedAt: READ_STARTED_AT,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.AboveRenderer
    );
  });

  test("COUNTERFACTUAL — a call still outstanding at the deadline is IN-renderer whatever its duration", () => {
    // The case a duration cannot decide, and the reason this mark carries an
    // instant at all. Both samples below began the moment the read was issued
    // and were still outstanding when the 10s deadline fired, so both belong to
    // the renderer — but neither RAN for 10s, and a classifier comparing the
    // duration it ran against the budget would file them under "the db-host was
    // fine, the harness was the cost", inverting the split's whole output.
    //
    // These fixtures deliberately dispatch at t=0. A read whose dispatch
    // STALLS reaches the same verdict for a different reason, and what
    // separates the two is the dispatch NUMBER rather than the phase — see the
    // block below.
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: READ_ID,
          settledAt: READ_STARTED_AT + 10_500,
          startedAt: READ_STARTED_AT,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.InRenderer
    );
    // The mirrored shape: dispatched 500ms late, ran 9.7s, settled 200ms past
    // the deadline. Duration 9700 is under budget; the call was outstanding.
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: READ_ID,
          settledAt: READ_STARTED_AT + 10_200,
          startedAt: READ_STARTED_AT,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.InRenderer,
      "a call that had not settled at the deadline instant was in the renderer, whatever its duration"
    );
  });

  test("the deadline instant itself belongs to the phase the call had reached", () => {
    assert.equal(
      classifyTimeoutPhase(
        { readId: READ_ID, settledAt: DEADLINE_AT, startedAt: READ_STARTED_AT },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.AboveRenderer,
      "a call already settled when the deadline fired lost its time above the renderer"
    );
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: READ_ID,
          settledAt: DEADLINE_AT + 1,
          startedAt: READ_STARTED_AT,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.InRenderer,
      "and one millisecond later it was still outstanding"
    );
  });

  test("COUNTERFACTUAL — a mark left behind by an EARLIER read is UNKNOWN, not this read's evidence", () => {
    // The mark lives at one fixed `window` key and is published INSIDE the
    // evaluation, so a read whose CDP dispatch has not landed yet has published
    // nothing and the previous read's mark is still sitting there — settled,
    // and about a different read. Without the identity check that stale mark is
    // indistinguishable from a fast one and scores above-renderer.
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: "page-read-6",
          settledAt: READ_STARTED_AT - 30_000,
          startedAt: READ_STARTED_AT - 31_000,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.Unknown
    );
  });

  test("COUNTERFACTUAL — an unreadable mark is UNKNOWN, never guessed into a real phase", () => {
    assert.equal(
      classifyTimeoutPhase(null, EXPECTED_DEADLINE),
      PageReadTimeoutPhase.Unknown
    );
  });

  test("COUNTERFACTUAL — a mark carrying an unusable instant is UNKNOWN, not above-renderer", () => {
    // `settledAt !== null` is NOT the test. NaN, an infinity and a
    // non-positive value are all non-null and all mean the mark is broken;
    // attributing them would put a fabricated count behind the question this
    // split exists to answer.
    for (const settledAt of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
    ] as const) {
      assert.equal(
        classifyTimeoutPhase(
          { readId: READ_ID, settledAt, startedAt: READ_STARTED_AT },
          EXPECTED_DEADLINE
        ),
        PageReadTimeoutPhase.Unknown,
        `settledAt ${settledAt} is not an instant`
      );
    }
  });
});

describe("ISS-6102: the dispatch hop is a NUMBER beside the phase, never folded into it", () => {
  test("COUNTERFACTUAL — a 9.5s dispatch stall is still IN-renderer, and says so in its dispatch number", () => {
    // The sample the phase alone decides misleadingly, and the reason the
    // dispatch hop is reported separately. The renderer settled at 10.5s, past
    // the 10s deadline, so it WAS outstanding when the deadline fired and
    // `inRenderer` is the honest answer to the question the phase asks. What
    // the phase must not do is imply the db-host spent that budget: 9.5s of it
    // went to reaching the renderer. Folding that into `aboveRenderer` would
    // answer a second question under the same enum and make a 50.01% share
    // indistinguishable from a request that never arrived; publishing the
    // number leaves both facts recoverable.
    const mark = {
      readId: READ_ID,
      startedAt: READ_STARTED_AT + 9500,
      settledAt: READ_STARTED_AT + 10_500,
    };
    assert.equal(
      classifyTimeoutPhase(mark, EXPECTED_DEADLINE),
      PageReadTimeoutPhase.InRenderer
    );
  });

  test("COUNTERFACTUAL — a timed-out read measures dispatch from THIS read's mark and folds it into the timeout series", async () => {
    // The wiring the phase counts cannot prove: a timeout has no renderer-side
    // return value, so its dispatch number can only come from the mark the
    // probe fetched. A race that dropped it, or measured it from the runner's
    // own elapsed, would leave every cycle reporting phase counts with no way
    // to tell a cheap outbound hop from an expensive one.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: IMMEDIATELY,
      readRendererMark: () =>
        Promise.resolve({
          readId: READ_ID,
          startedAt: READ_STARTED_AT + 9500,
          settledAt: READ_STARTED_AT + 10_500,
        }),
    });

    assert.equal(sample.timedOut, true);
    assert.equal(sample.dispatchMs, 9500);
    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.InRenderer);

    const stats = newPageReadStats();
    recordPageReadSample(stats, sample);
    assert.deepEqual(stats.timeoutDispatchLatenciesMs, [9500]);
    assert.deepEqual(
      stats.dispatchLatenciesMs,
      [],
      "a timeout must not enter the ok-read dispatch series, which is population-matched to rendererLatenciesMs"
    );
  });

  test("COUNTERFACTUAL — a STALE mark measures no dispatch, rather than the previous read's", async () => {
    // The identity rule the phase already applies, applied to the number too. A
    // mark left by an earlier read carries a perfectly usable start instant;
    // billing it to this read would put a fabricated dispatch behind the very
    // question the number exists to answer.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: IMMEDIATELY,
      readRendererMark: () =>
        Promise.resolve({
          readId: "page-read-6",
          startedAt: READ_STARTED_AT + 40,
          settledAt: READ_STARTED_AT + 900,
        }),
    });

    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.Unknown);
    assert.equal(sample.dispatchMs, null);

    const stats = newPageReadStats();
    recordPageReadSample(stats, sample);
    assert.deepEqual(
      stats.timeoutDispatchLatenciesMs,
      [],
      "an unattributable timeout contributes no dispatch measurement, not a zero"
    );
  });

  test("COUNTERFACTUAL — an unreadable mark leaves the timeout counted but its dispatch unmeasured", async () => {
    // The wedged-renderer path. The timeout still has to be counted, and its
    // dispatch still has to be absent rather than zero, or a cycle whose marks
    // were all unreadable would report a 0ms dispatch p50 and read as having
    // ruled the outbound hop out.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: IMMEDIATELY,
      readRendererMark: () => Promise.resolve(null),
    });

    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.Unknown);
    assert.equal(sample.dispatchMs, null);

    const stats = newPageReadStats();
    recordPageReadSample(stats, sample);
    assert.equal(stats.timeouts, 1);
    assert.deepEqual(stats.timeoutDispatchLatenciesMs, []);
  });

  test("COUNTERFACTUAL — a mark whose start instant is unusable measures no dispatch but keeps its phase", async () => {
    // The two facts are independent: an unusable start instant says nothing
    // about where the read had got to. Dropping the phase along with the number
    // would lose a timeout the settle instant could perfectly well classify.
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
    assert.equal(
      sample.timeoutPhase,
      PageReadTimeoutPhase.AboveRenderer,
      "the settle instant still decides the phase when only the start instant is broken"
    );
  });
});

describe("ISS-6102: the cycle's timeout total reconciles with its phase split", () => {
  test("each timeout lands in exactly one phase, and the phases sum to the total", () => {
    const stats = newPageReadStats();
    for (const timeoutPhase of [
      PageReadTimeoutPhase.PreRenderer,
      PageReadTimeoutPhase.InRenderer,
      PageReadTimeoutPhase.AboveRenderer,
      PageReadTimeoutPhase.Unknown,
    ]) {
      recordPageReadSample(stats, {
        result: null,
        elapsedMs: 10_000,
        timedOut: true,
        rendererMs: null,
        dispatchMs: null,
        timeoutPhase,
      });
    }

    assert.deepEqual(stats.timeoutPhases, {
      preRenderer: 1,
      inRenderer: 1,
      aboveRenderer: 1,
      unknown: 1,
    });
    assert.equal(
      stats.timeouts,
      stats.timeoutPhases.preRenderer +
        stats.timeoutPhases.inRenderer +
        stats.timeoutPhases.aboveRenderer +
        stats.timeoutPhases.unknown,
      "a timeout counted in the total but in no phase would reintroduce the unattributable number"
    );
  });

  test("COUNTERFACTUAL — a timeout with no phase at all is counted as unknown, not dropped", () => {
    const stats = newPageReadStats();
    recordPageReadSample(stats, {
      result: null,
      elapsedMs: 10_000,
      timedOut: true,
      rendererMs: null,
      timeoutPhase: null,
      dispatchMs: null,
    });

    assert.equal(stats.timeouts, 1);
    assert.deepEqual(stats.timeoutPhases, {
      preRenderer: 0,
      inRenderer: 0,
      aboveRenderer: 0,
      unknown: 1,
    });
  });
});

describe("ISS-6102: the renderer latency series is the renderer's, and covers the same reads", () => {
  test("COUNTERFACTUAL — an ok read records the RUNNER number and the RENDERER number separately", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    recordPageReadSample(stats, {
      result: OK_PAGE_DATA,
      elapsedMs: 9000,
      timedOut: false,
      rendererMs: 480,
      timeoutPhase: null,
      dispatchMs: null,
    });

    assert.deepEqual(stats.latenciesMs, [9000]);
    assert.deepEqual(
      stats.rendererLatenciesMs,
      [480],
      "reporting the runner's 9000ms as the renderer's would hide the whole harness segment — the confound this split exists to remove"
    );
  });

  test("COUNTERFACTUAL — an ok read with no renderer measurement contributes nothing, not a zero", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    recordPageReadSample(stats, {
      result: OK_PAGE_DATA,
      elapsedMs: 42,
      timedOut: false,
      rendererMs: null,
      timeoutPhase: null,
      dispatchMs: null,
    });

    assert.equal(stats.ok, 1);
    assert.deepEqual(
      stats.rendererLatenciesMs,
      [],
      "a 0ms sample would drag the renderer percentile toward a read that never happened"
    );
  });

  test("COUNTERFACTUAL — a degenerate read contributes to NEITHER series, so the two describe one population", () => {
    const stats = newPageReadStats();
    stats.expectedTotal = 2962;
    recordPageReadSample(stats, {
      result: SHORT_LIST,
      elapsedMs: 30,
      timedOut: false,
      rendererMs: 25,
      timeoutPhase: null,
      dispatchMs: null,
    });

    assert.equal(stats.short, 1);
    assert.deepEqual(stats.latenciesMs, []);
    assert.deepEqual(
      stats.rendererLatenciesMs,
      [],
      "a renderer latency for a read the runner never graded ok would make the two percentiles incomparable"
    );
  });
});

describe("ISS-6102: the probe WIRING, not just the classifier", () => {
  /**
   * `raceReadAgainstDeadline` is the only part of the probe that decides
   * anything, and the two halves it decides between are Playwright-bound. These
   * cases drive it with injected halves: `sleep` that never settles pins the
   * answered branch, `sleep` that settles immediately pins the timed-out one.
   * No real clock is consulted, so nothing here is timing-dependent.
   */
  test("an answered read forwards the renderer's own duration and never consults the mark", async () => {
    let markReads = 0;
    const sample = await raceReadAgainstDeadline({
      evaluation: Promise.resolve({
        value: OK_PAGE_DATA,
        rendererMs: 480,
        rendererStartedAt: READ_STARTED_AT + 30,
      }),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => READ_STARTED_AT + 512,
      sleep: NEVER,
      readRendererMark: () => {
        markReads += 1;
        return Promise.resolve(null);
      },
    });

    assert.equal(sample.timedOut, false);
    assert.equal(
      sample.elapsedMs,
      512,
      "the runner latency is the injected clock's distance from this read's start"
    );
    assert.equal(sample.rendererMs, 480);
    assert.equal(sample.timeoutPhase, null);
    assert.deepEqual(
      sample.result,
      OK_PAGE_DATA,
      "the graded result must be the renderer's VALUE, not the {value, rendererMs} envelope the evaluation returns"
    );
    assert.equal(
      markReads,
      0,
      "the follow-up CDP probe must not be paid on a read that answered"
    );
    assert.equal(
      sample.dispatchMs,
      30,
      "dispatch is the renderer's START instant minus this read's issue instant — forwarding the renderer's DURATION, or the runner's elapsed, would report a segment that was never measured"
    );
  });

  test("COUNTERFACTUAL — a dispatch instant that precedes the read is dropped, not clamped to zero", async () => {
    // The two instants are `Date.now()` reads in two processes, so a wall-clock
    // step can order them backwards. Clamping a negative to 0 would publish a
    // confident "dispatch was instant" into the very percentile the split is
    // read from; absent is the only honest answer.
    const sample = await raceReadAgainstDeadline({
      evaluation: Promise.resolve({
        value: OK_PAGE_DATA,
        rendererMs: 480,
        rendererStartedAt: READ_STARTED_AT - 25,
      }),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => READ_STARTED_AT + 512,
      sleep: NEVER,
      readRendererMark: () => Promise.resolve(null),
    });

    assert.equal(sample.dispatchMs, null);
    assert.equal(
      sample.timedOut,
      false,
      "an unusable dispatch instant must not disturb the read's own outcome"
    );
  });

  test("the dispatch series carries only reads that were GRADED ok, like the renderer series beside it", () => {
    // The three series are read against each other to apportion a page read, so
    // they have to describe the same population. A short read folded into
    // dispatch but not into the other two would shift one leg of the split
    // against the others and quietly change the answer.
    const stats = newPageReadStats();
    // Without an established population a SHORT list grades ok, and the case
    // below would pass while proving nothing.
    stats.expectedTotal = 2962;
    recordPageReadSample(stats, {
      result: OK_PAGE_DATA,
      elapsedMs: 900,
      timedOut: false,
      rendererMs: 700,
      dispatchMs: 120,
      timeoutPhase: null,
    });
    recordPageReadSample(stats, {
      result: SHORT_LIST,
      elapsedMs: 800,
      timedOut: false,
      rendererMs: 600,
      dispatchMs: 150,
      timeoutPhase: null,
    });

    assert.deepEqual(stats.dispatchLatenciesMs, [120]);
    assert.deepEqual(stats.rendererLatenciesMs, [700]);
    assert.equal(stats.short, 1);
  });

  test("COUNTERFACTUAL — a timed-out read classifies from the mark the wiring actually fetches", async () => {
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: IMMEDIATELY,
      readRendererMark: () =>
        Promise.resolve({
          readId: READ_ID,
          settledAt: SETTLED_EARLY_AT,
          startedAt: READ_STARTED_AT,
        }),
    });

    assert.equal(sample.timedOut, true);
    assert.equal(sample.rendererMs, null);
    assert.equal(
      sample.timeoutPhase,
      PageReadTimeoutPhase.AboveRenderer,
      "hardcoding a phase, or never calling readRendererMark, would leave every timeout unattributed"
    );
  });

  test("COUNTERFACTUAL — the race judges the mark against THIS read's identity", async () => {
    // A mark from the previous read, which is what the fixed `window` key holds
    // whenever this read's dispatch has not landed. A race that dropped
    // `readId` on the way to the classifier would score it above-renderer.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: IMMEDIATELY,
      readRendererMark: () =>
        Promise.resolve({
          readId: "page-read-6",
          settledAt: READ_STARTED_AT - 30_000,
          startedAt: READ_STARTED_AT - 31_000,
        }),
    });

    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.Unknown);
  });

  test("COUNTERFACTUAL — the deadline INSTANT the phase is judged against is this read's own", async () => {
    // A non-default deadline: if the classifier were handed the module default
    // instead of the deadline this race actually ran, a call that settled 900ms
    // after the start — 100ms past an 800ms deadline — would read as
    // above-renderer.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => READ_STARTED_AT + 800,
      sleep: IMMEDIATELY,
      readRendererMark: () =>
        Promise.resolve({
          readId: READ_ID,
          settledAt: READ_STARTED_AT + 900,
          startedAt: READ_STARTED_AT,
        }),
      deadlineMs: 800,
    });

    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.InRenderer);
  });

  test("COUNTERFACTUAL — a mark probe that NEVER settles is bounded and scored unknown, not left to hang the cycle", async () => {
    // A wedged renderer, which is the state this probe is most likely to meet:
    // it is issued only after a read already blew its deadline. `page.evaluate`
    // then never answers, and the `try/catch` around it in `soak-app.ts` bounds
    // a rejection and nothing else — so an unbounded await here never builds
    // the sample, and the cycle emits no result at all for the timeout it was
    // called to explain. This test completing IS the assertion: pre-bound, it
    // hangs until the test runner kills it.
    const sleeps: number[] = [];
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      readRendererMark: NEVER,
      markProbeDeadlineMs: 250,
    });

    assert.equal(sample.timedOut, true);
    assert.equal(
      sample.timeoutPhase,
      PageReadTimeoutPhase.Unknown,
      "a mark that never arrived is not evidence for either real phase"
    );
    assert.deepEqual(
      sleeps,
      [PAGE_READ_DEADLINE_MS, 250],
      "the probe must be raced against its OWN short bound; reusing the read deadline would make a wedged renderer cost another full budget"
    );
  });

  test("COUNTERFACTUAL — a mark probe that answers WITHIN its bound is still what the phase is judged on", async () => {
    // The bound must not clobber a probe that works: only the read deadline
    // fires here, the probe's own bound never does.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: (ms) =>
        ms === PAGE_READ_DEADLINE_MS ? Promise.resolve() : NEVER(),
      readRendererMark: () =>
        Promise.resolve({
          readId: READ_ID,
          settledAt: SETTLED_EARLY_AT,
          startedAt: READ_STARTED_AT,
        }),
    });

    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.AboveRenderer);
  });

  test("a mark probe that REJECTS is scored unknown, not thrown out of the sample", async () => {
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: (ms) =>
        ms === PAGE_READ_DEADLINE_MS ? Promise.resolve() : NEVER(),
      readRendererMark: () => Promise.reject(new Error("renderer detached")),
    });

    assert.equal(
      sample.timeoutPhase,
      PageReadTimeoutPhase.Unknown,
      "throwing here would score an already-measured timeout as an error instead"
    );
  });

  test("a rejection that BEATS the deadline propagates, so the caller can count it as an error", async () => {
    const boom = new Error("renderer blew up");

    await assert.rejects(
      raceReadAgainstDeadline({
        evaluation: Promise.reject(boom),
        readId: READ_ID,
        startedAt: READ_STARTED_AT,
        now: () => READ_STARTED_AT + 5,
        sleep: NEVER,
        readRendererMark: () => Promise.resolve(null),
      }),
      (error) => {
        assert.equal(
          error,
          boom,
          "swallowing it into a sample would score a failed read as a graded one"
        );
        return true;
      }
    );
  });

  test("a rejection that arrives AFTER the deadline is already handled, not left unhandled", async () => {
    let rejectLate: (error: Error) => void = () => {
      throw new Error("late rejection never armed");
    };
    const evaluation = new Promise<PageReadEvaluation>((_resolve, reject) => {
      rejectLate = reject;
    });

    const sample = await raceReadAgainstDeadline({
      evaluation,
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT,
      sleep: IMMEDIATELY,
      readRendererMark: () => Promise.resolve(null),
    });
    assert.equal(sample.timedOut, true);
    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.Unknown);

    // Without the internal `.catch` this surfaces as an unhandled rejection and
    // takes the whole cycle down long after the sample was already recorded.
    rejectLate(new Error("renderer blew up late"));
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("ISS-6102: the cycle RECORD carries the split, not just the stats", () => {
  /**
   * The stats object is not what a lane reads — `buildCycleRecord` is. These
   * cases exist because the likeliest way this whole change goes wrong is a
   * one-token copy-paste in that builder: `rendererP50Ms` sourced from
   * `latenciesMs`. Every assertion above would stay green through it, and the
   * artifact would publish the runner number as the renderer number — exactly
   * the confound the split was built to remove.
   */
  function recordWithPageReads(
    pageReads: Parameters<typeof buildRecord>[0]["pageReads"]
  ) {
    return buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: readBackFixture([readBackEntry("session-a")]),
      pageReads,
    });
  }

  test("COUNTERFACTUAL — the renderer percentiles come from the RENDERER series, not the runner's", () => {
    const record = recordWithPageReads({
      ...newPageReadStats(),
      ok: 1,
      expectedTotal: 2962,
      latenciesMs: [9000],
      rendererLatenciesMs: [480],
    });

    assert.equal(record.pageReads.p50Ms, 9000);
    assert.equal(record.pageReads.maxMs, 9000);
    assert.equal(
      record.pageReads.rendererP50Ms,
      480,
      "sourcing this from latenciesMs would report the harness's own CDP cost as what a user waited for"
    );
    assert.equal(record.pageReads.rendererMaxMs, 480);
  });

  test("an absent renderer series reports null, never a zero standing in for it", () => {
    const record = recordWithPageReads({
      ...newPageReadStats(),
      ok: 1,
      expectedTotal: 2962,
      latenciesMs: [9000],
    });

    assert.equal(record.pageReads.rendererP50Ms, null);
    assert.equal(record.pageReads.rendererMaxMs, null);
  });

  test("COUNTERFACTUAL — each of the three latency series reaches its OWN pair of record fields", () => {
    // Three distinct values on purpose. The builder computes six percentiles
    // from three series in adjacent, near-identical lines, so the copy-paste
    // this block exists to catch has three more places to land than it did:
    // `dispatchP50Ms` sourced from `latenciesMs` would publish the runner's own
    // round trip as the outbound hop, which is the confound the split removes,
    // reintroduced on the segment that measures it.
    const record = recordWithPageReads({
      ...newPageReadStats(),
      ok: 1,
      expectedTotal: 2962,
      latenciesMs: [9000],
      rendererLatenciesMs: [480],
      dispatchLatenciesMs: [30],
      timeoutDispatchLatenciesMs: [9500],
    });

    assert.equal(record.pageReads.p50Ms, 9000);
    assert.equal(record.pageReads.rendererP50Ms, 480);
    assert.equal(record.pageReads.dispatchP50Ms, 30);
    assert.equal(record.pageReads.dispatchMaxMs, 30);
    assert.equal(
      record.pageReads.timeoutDispatchP50Ms,
      9500,
      "the timed-out reads' dispatch must not be sourced from the ok reads' series — they are the two populations the split is read across"
    );
    assert.equal(record.pageReads.timeoutDispatchMaxMs, 9500);
  });

  test("absent dispatch series report null, never a zero that reads as a cheap hop", () => {
    // A cycle whose marks were all unreadable has measured NO dispatch. A `0`
    // there is the difference between "the outbound hop is ruled out" and "the
    // outbound hop was never measured", on the number a lane rules it out with.
    const record = recordWithPageReads({
      ...newPageReadStats(),
      ok: 1,
      expectedTotal: 2962,
      latenciesMs: [9000],
    });

    assert.equal(record.pageReads.dispatchP50Ms, null);
    assert.equal(record.pageReads.dispatchMaxMs, null);
    assert.equal(record.pageReads.timeoutDispatchP50Ms, null);
    assert.equal(record.pageReads.timeoutDispatchMaxMs, null);
  });

  test("COUNTERFACTUAL — the phase split reaches the record AND the criterion-4 failure line", () => {
    // Distinct counts, so a builder that dropped the field, wired it to the
    // wrong source, or printed the four in the wrong order all go red.
    const record = recordWithPageReads({
      ...newPageReadStats(),
      timeouts: 10,
      expectedTotal: 2962,
      timeoutPhases: {
        preRenderer: 4,
        inRenderer: 1,
        aboveRenderer: 2,
        unknown: 3,
      },
      timeoutDispatchLatenciesMs: [40],
    });

    assert.deepEqual(record.pageReads.timeoutPhases, {
      preRenderer: 4,
      inRenderer: 1,
      aboveRenderer: 2,
      unknown: 3,
    });
    assert.equal(record.invariants.readsAnswer, false);
    const reason = record.failReasons.find((entry) =>
      entry.startsWith("page_reads:")
    );
    assert.ok(reason, JSON.stringify(record.failReasons));
    assert.match(
      reason,
      PHASE_SPLIT_FAIL_LINE,
      "the failure line is what a lane reads first; a bare timeout count is the number that made criterion 4 arguable"
    );
  });

  test("COUNTERFACTUAL — a cycle that measured NO dispatch says so on the failure line, not 0ms", () => {
    // The wedged-renderer cycle. Every timeout is counted and none carried a
    // readable mark, so the outbound hop is UNMEASURED — and a lane reading
    // `0ms` there would rule out the one candidate it has no evidence about.
    const record = recordWithPageReads({
      ...newPageReadStats(),
      timeouts: 10,
      expectedTotal: 2962,
      timeoutPhases: {
        preRenderer: 4,
        inRenderer: 1,
        aboveRenderer: 2,
        unknown: 3,
      },
    });

    const reason = record.failReasons.find((entry) =>
      entry.startsWith("page_reads:")
    );
    assert.ok(reason, JSON.stringify(record.failReasons));
    assert.match(reason, UNMEASURED_DISPATCH_FAIL_LINE);
  });
});
