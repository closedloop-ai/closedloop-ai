/**
 * @file soak-page-read-prerenderer-phase.test.ts
 * @description ISS-6102 — a timed-out read that had not REACHED the renderer is
 * never reported as time spent inside it.
 *
 * `soak-page-read-phase-split.test.ts` establishes that the phase is decided
 * instant-vs-instant rather than duration-vs-budget. This file owns the case
 * that rule left open: the settle instant alone cannot separate "the renderer
 * was working and had not finished" from "the renderer had not started". Both
 * present as `settledAt === null` at the probe, and the classifier scored both
 * `inRenderer` — a read still sitting in the outbound CDP hop, published as a
 * db-host cost.
 *
 * That window is not hypothetical. The mark probe runs for up to
 * `RENDERER_MARK_PROBE_DEADLINE_MS` AFTER the deadline has already been lost,
 * so an evaluation whose dispatch lands during the probe publishes exactly this
 * mark: this read's identity, a start instant past the deadline, and nothing
 * settled. It is the same axis collapse the phase split exists to remove, one
 * level down, and it inverts the answer in the direction that matters — a lane
 * chasing the db-host for time the harness spent.
 *
 * `startedAt` is what settles it, and the renderer has published it since the
 * mark was introduced. Every test below drives the confusion and asserts it
 * cannot survive.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildRecord,
  DEADLINE_AT,
  EXPECTED_DEADLINE,
  IMMEDIATELY,
  NEVER,
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
  PageReadTimeoutPhase,
  raceReadAgainstDeadline,
  recordPageReadSample,
} from "./soak/soak-page-read";

/** How far past the deadline the late evaluation begins executing. */
const LATE_START_OFFSET_MS = 500;
const LATE_STARTED_AT = DEADLINE_AT + LATE_START_OFFSET_MS;
/**
 * The failure line a pre-renderer cycle must produce. Pinned in full so a
 * builder that dropped the new count, or folded it into a neighbour, goes red
 * rather than printing three phases that no longer sum to the total.
 */
const PRE_RENDERER_FAIL_LINE =
  /3 timeouts \(3 pre-renderer 0 in-renderer 0 above-renderer 0 unknown, dispatch p50 10500ms\)/;

describe("ISS-6102: a read that had not reached the renderer says so", () => {
  test("COUNTERFACTUAL — a start instant PAST the deadline with nothing settled is PRE-renderer, not in-renderer", () => {
    // The review case, verbatim. `settledAt === null` is true here in the
    // trivial sense that there is no call to have settled yet: the evaluation
    // began 500ms after the deadline the runner already lost. Reporting it
    // `inRenderer` states that the time went at or below the renderer boundary
    // — the db-host, lane admission, the main IPC hop — when in fact none of it
    // did.
    const phase = classifyTimeoutPhase(
      { readId: READ_ID, startedAt: LATE_STARTED_AT, settledAt: null },
      EXPECTED_DEADLINE
    );

    assert.equal(phase, PageReadTimeoutPhase.PreRenderer);
    assert.notEqual(
      phase,
      PageReadTimeoutPhase.InRenderer,
      "the pre-fix classifier read the null settle instant and stopped there, reporting a read still in the outbound hop as time spent below the renderer"
    );
  });

  test("COUNTERFACTUAL — a start instant past the deadline is PRE-renderer even once the call has settled", () => {
    // The same mark one probe-tick later. A settle instant past the deadline is
    // the `inRenderer` signature, so this is where the two rules genuinely
    // disagree — and the start instant is the one that answers the question
    // asked, which is where the read had got to AT the deadline.
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: READ_ID,
          startedAt: LATE_STARTED_AT,
          settledAt: LATE_STARTED_AT + 900,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.PreRenderer,
      "a call that had not begun at the deadline lost none of its budget below the renderer, whenever it later settled"
    );
  });

  test("the deadline instant itself belongs to the renderer, and one millisecond later does not", () => {
    // Same boundary convention as the settle rule, so the two cannot drift into
    // disagreeing about which side of the deadline the instant itself is on.
    assert.equal(
      classifyTimeoutPhase(
        { readId: READ_ID, startedAt: DEADLINE_AT, settledAt: null },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.InRenderer,
      "a read that had begun by the deadline instant was in the renderer"
    );
    assert.equal(
      classifyTimeoutPhase(
        { readId: READ_ID, startedAt: DEADLINE_AT + 1, settledAt: null },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.PreRenderer,
      "and one millisecond later it had not"
    );
  });

  test("a read that began ON TIME and was still outstanding is untouched", () => {
    // The regression guard for the rule this one is layered over. A start
    // instant inside the deadline says nothing about where the read got to, so
    // the settle rule must still decide it — including the 9.5s dispatch stall
    // that is `inRenderer` with an expensive dispatch number beside it.
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: READ_ID,
          startedAt: READ_STARTED_AT + 9500,
          settledAt: READ_STARTED_AT + 10_500,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.InRenderer
    );
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: READ_ID,
          startedAt: READ_STARTED_AT,
          settledAt: SETTLED_EARLY_AT,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.AboveRenderer
    );
  });

  test("COUNTERFACTUAL — an UNUSABLE start instant still keeps its phase, and is not guessed pre-renderer", () => {
    // The distinction this change must not collapse. An unusable `startedAt`
    // leaves the DISPATCH question unanswerable and the PHASE question fully
    // answered by the settle instant; a usable one past the deadline answers
    // the phase question itself. Treating the first like the second would
    // fabricate a pre-renderer count out of a broken field, which is the same
    // failure in the opposite direction.
    for (const startedAt of [
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
    ] as const) {
      assert.equal(
        classifyTimeoutPhase(
          { readId: READ_ID, startedAt, settledAt: SETTLED_EARLY_AT },
          EXPECTED_DEADLINE
        ),
        PageReadTimeoutPhase.AboveRenderer,
        `startedAt ${startedAt} is not an instant, and the settle instant answers the phase without it`
      );
      assert.equal(
        classifyTimeoutPhase(
          { readId: READ_ID, startedAt, settledAt: null },
          EXPECTED_DEADLINE
        ),
        PageReadTimeoutPhase.InRenderer,
        `startedAt ${startedAt} must not turn an outstanding call into a pre-renderer one`
      );
    }
  });

  test("COUNTERFACTUAL — a late start on ANOTHER read's mark is still UNKNOWN", () => {
    // Identity is checked before either instant, and must stay that way: a
    // stale mark's start instant is arithmetic about a different read, so
    // reading a phase off it would be a fabricated count either way.
    assert.equal(
      classifyTimeoutPhase(
        {
          readId: "page-read-6",
          startedAt: LATE_STARTED_AT,
          settledAt: null,
        },
        EXPECTED_DEADLINE
      ),
      PageReadTimeoutPhase.Unknown
    );
  });
});

describe("ISS-6102: the pre-renderer phase reaches the sample, the stats and the row", () => {
  test("COUNTERFACTUAL — the race classifies a late-starting read pre-renderer AND measures the hop that cost it", async () => {
    // End to end through the production entry point, because the phase and the
    // dispatch number are read together: `preRenderer` says the read never
    // arrived, and the number says how long it had been trying. A wiring that
    // produced the phase but dropped the number would leave a lane knowing the
    // request was late without knowing by how much.
    const sample = await raceReadAgainstDeadline({
      evaluation: NEVER(),
      readId: READ_ID,
      startedAt: READ_STARTED_AT,
      now: () => DEADLINE_AT + 700,
      sleep: IMMEDIATELY,
      readRendererMark: () =>
        Promise.resolve({
          readId: READ_ID,
          startedAt: LATE_STARTED_AT,
          settledAt: null,
        }),
    });

    assert.equal(sample.timedOut, true);
    assert.equal(sample.timeoutPhase, PageReadTimeoutPhase.PreRenderer);
    assert.equal(
      sample.dispatchMs,
      PAGE_READ_DEADLINE_MS + LATE_START_OFFSET_MS,
      "the dispatch hop outran the whole read budget, which is the evidence the phase is claiming"
    );

    const stats = newPageReadStats();
    recordPageReadSample(stats, sample);

    assert.equal(stats.timeoutPhases.preRenderer, 1);
    assert.equal(stats.timeoutPhases.inRenderer, 0);
    assert.equal(stats.timeoutPhases.unknown, 0);
    assert.equal(stats.timeoutDispatchUnmeasured, 0);
  });

  test("COUNTERFACTUAL — the pre-renderer count reaches the record and the criterion-4 failure line", () => {
    // A phase counted in the stats but absent from the line a lane reads first
    // would leave the misattribution exactly where it was. The line is pinned
    // whole so the four counts must still sum to the timeout total.
    const record = buildRecord({
      stats: statsFixture({ syncedSessionIds: ["session-a"] }),
      readBack: readBackFixture([readBackEntry("session-a")]),
      pageReads: {
        ...newPageReadStats(),
        timeouts: 3,
        expectedTotal: 2962,
        timeoutPhases: {
          preRenderer: 3,
          inRenderer: 0,
          aboveRenderer: 0,
          unknown: 0,
        },
        timeoutDispatchLatenciesMs: [10_400, 10_500, 10_600],
      },
    });

    assert.equal(record.pageReads.timeoutPhases.preRenderer, 3);
    assert.equal(record.invariants.readsAnswer, false);
    const reason = record.failReasons.find((entry) =>
      entry.startsWith("page_reads:")
    );
    assert.ok(reason, JSON.stringify(record.failReasons));
    assert.match(reason, PRE_RENDERER_FAIL_LINE);
  });
});
