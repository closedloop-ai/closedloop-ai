/**
 * @file autonomy-calibration-report.test.ts
 * @description ISS-5303 — behaviour coverage for the autonomy calibration
 * report renderer (`scripts/autonomy-calibration-report.ts`). The report IS the
 * deliverable of the calibration harness: FEA-3781 moved the tier boundaries on
 * the strength of the tables this file prints, and FEA-3266 moved them the wrong
 * way on the strength of an earlier reading. So the assertions here are on the
 * rendered strings and the real computed numbers — bucket edges, percentile
 * indices, the `?? 0` steering coalesce, the dead-tier marker — not on the shape
 * of the output.
 *
 * The module is pure over `ScoredSession[]` and has no module-level side
 * effects, so importing it is safe. Its sibling `autonomy-calibration.ts` has an
 * unguarded top-level `await main()` and is deliberately never imported here.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  renderCalibrationReport,
  type ScoredSession,
} from "../scripts/autonomy-calibration-report.js";

const HEADER_HISTOGRAM = "== score distribution ==";
const HEADER_PERCENTILES = "== percentiles ==";
const HEADER_TIER_SPLIT = "== tier split (AUTONOMY_TIER_MIN_SCORE) ==";
const HEADER_STEERING =
  "== steering-episode cross-tab (is the score still inverted?) ==";
const HEADER_CUT_POINTS = "== candidate cut-points ==";
const HEADER_ANCESTOR =
  "== ancestor reference (closedloop-ai/workflow report.ts) ==";
const HEADER_EXAMPLES = "== examples per tier ==";

const SECTION_HEADER_PREFIX = "== ";

function scoredSession(
  overrides: Partial<ScoredSession> & { id: string }
): ScoredSession {
  return {
    harness: "claude",
    headless: false,
    prompts: 1,
    autonomy: 50,
    steeringEpisodes: 0,
    ancestor: 50,
    wallMinutes: 1,
    ...overrides,
  };
}

/** Sessions differing only in autonomy score, ids derived from the score. */
function sessionsScored(scores: (number | null)[]): ScoredSession[] {
  return scores.map((autonomy, index) =>
    scoredSession({ id: `s${index}`, autonomy })
  );
}

/**
 * The lines of one report section: everything between its `== header ==` and
 * the next blank separator (or end of report, for the final section).
 */
function sectionLines(report: string, header: string): string[] {
  const lines = report.split("\n");
  const headerIndex = lines.indexOf(header);
  if (headerIndex < 0) {
    throw new Error(`report has no ${header} section`);
  }
  const rest = lines.slice(headerIndex + 1);
  const separator = rest.indexOf("");
  return separator < 0 ? rest : rest.slice(0, separator);
}

describe("renderCalibrationReport: report frame", () => {
  test("heads the report with the store path and the headless split", () => {
    const report = renderCalibrationReport(
      "/tmp/rehearsal/agent-dashboard.sqlite",
      [
        scoredSession({ id: "a", headless: true }),
        scoredSession({ id: "b" }),
        scoredSession({ id: "c", headless: true }),
      ]
    );

    const lines = report.split("\n");
    assert.equal(lines[0], "store:    /tmp/rehearsal/agent-dashboard.sqlite");
    assert.equal(lines[1], "sessions: 3 (headless: 2)");
  });

  test("emits every section in order and terminates with one newline", () => {
    const report = renderCalibrationReport("store", []);

    assert.deepEqual(
      report
        .split("\n")
        .filter((line) => line.startsWith(SECTION_HEADER_PREFIX)),
      [
        HEADER_HISTOGRAM,
        HEADER_PERCENTILES,
        HEADER_TIER_SPLIT,
        HEADER_STEERING,
        HEADER_CUT_POINTS,
        HEADER_ANCESTOR,
        HEADER_EXAMPLES,
      ]
    );
    assert.ok(report.endsWith("\n"), "report must end with a newline");
    assert.ok(
      !report.endsWith("\n\n"),
      "report must not end with a blank line — the entrypoint prints it verbatim"
    );
  });
});

describe("renderCalibrationReport: score histogram", () => {
  test("buckets by tens, pins 100 and null in their own rows, and sorts them", () => {
    // 100 is deliberately NOT folded into 090-99: "scores pinned at the ceiling"
    // is the exact pathology FEA-3781 was hunting, so it must stay visible as a
    // row of its own. 0-9 renders as "000-9" (the floor is zero-padded, the top
    // of the bucket is not) — pinned here because the report is read by eye.
    const report = renderCalibrationReport(
      "store",
      sessionsScored([null, 100, 0, 7, 10, 95])
    );

    assert.deepEqual(sectionLines(report, HEADER_HISTOGRAM), [
      "     000-9     2  ##",
      "    010-19     1  #",
      "    090-99     1  #",
      "       100     1  #",
      "      null     1  #",
    ]);
  });
});

describe("renderCalibrationReport: percentiles", () => {
  test("sorts the scored values and reports the ceiling-pinned share", () => {
    // Input order is shuffled so the sort is load-bearing. Index math is
    // floor(fraction * n) clamped to n-1: for n=6 that is p25 -> values[1],
    // p50 -> values[3], p75 -> values[4].
    const report = renderCalibrationReport(
      "store",
      sessionsScored([100, 7, 0, 100, 95, 10])
    );

    assert.deepEqual(sectionLines(report, HEADER_PERCENTILES), [
      "  n=6  min=0 p25=7 p50=95 p75=100 max=100  =100: 2 (33%)",
    ]);
  });

  test("says so rather than dividing by zero when nothing scored", () => {
    const report = renderCalibrationReport(
      "store",
      sessionsScored([null, null])
    );

    assert.deepEqual(sectionLines(report, HEADER_PERCENTILES), [
      "  (no scored sessions)",
    ]);
  });
});

describe("renderCalibrationReport: tier split", () => {
  test("counts each tier and its share of the corpus", () => {
    const report = renderCalibrationReport(
      "store",
      sessionsScored([90, 50, 10, null])
    );

    assert.deepEqual(sectionLines(report, HEADER_TIER_SPLIT), [
      "  high        1  (25%)",
      "  mixed       1  (25%)",
      "  guided      1  (25%)",
      "  unknown     1  (25%)",
    ]);
  });

  test("reports 0% rather than NaN% for an empty corpus", () => {
    const report = renderCalibrationReport("store", []);

    assert.deepEqual(sectionLines(report, HEADER_TIER_SPLIT), [
      "  high        0  (0%)",
      "  mixed       0  (0%)",
      "  guided      0  (0%)",
      "  unknown     0  (0%)",
    ]);
  });

  test("the ancestor section classifies on the ancestor score, not the live one", () => {
    // The whole point of the ancestor table is cross-repo divergence: every
    // session here is `high` under this repo's score and `guided`/`unknown`
    // under the ancestor's. A renderer that reused `autonomy` for both would
    // print two identical tables and hide the divergence it exists to show.
    const scored = [10, 20, null].map((ancestor, index) =>
      scoredSession({ id: `s${index}`, autonomy: 90, ancestor })
    );

    const report = renderCalibrationReport("store", scored);

    assert.deepEqual(sectionLines(report, HEADER_TIER_SPLIT), [
      "  high        3  (100%)",
      "  mixed       0  (0%)",
      "  guided      0  (0%)",
      "  unknown     0  (0%)",
    ]);
    assert.deepEqual(sectionLines(report, HEADER_ANCESTOR), [
      "  high        0  (0%)",
      "  mixed       0  (0%)",
      "  guided      2  (67%)",
      "  unknown     1  (33%)",
    ]);
  });
});

describe("renderCalibrationReport: steering cross-tab", () => {
  test("means each steering bucket, coalescing null steering into the 0 bucket", () => {
    // This is the table that proves the metric is not inverted, so its
    // population rules matter: a null steering count reads as zero episodes
    // (it joins the `0` bucket), while a null AUTONOMY score is excluded
    // outright — averaging it in as 0 would fabricate a downward slope.
    const report = renderCalibrationReport("store", [
      scoredSession({ id: "s1", steeringEpisodes: 0, autonomy: 100 }),
      scoredSession({ id: "s2", steeringEpisodes: 0, autonomy: 80 }),
      scoredSession({ id: "s3", steeringEpisodes: null, autonomy: 60 }),
      scoredSession({ id: "s4", steeringEpisodes: 2, autonomy: 40 }),
      scoredSession({ id: "s5", steeringEpisodes: 20, autonomy: 10 }),
      scoredSession({ id: "s6", steeringEpisodes: 16, autonomy: null }),
    ]);

    assert.deepEqual(sectionLines(report, HEADER_STEERING), [
      "  steers 0     n=  3  mean= 80  max=100",
      "  steers 1-2   n=  1  mean= 40  max=40",
      "  steers 3-5   n=0",
      "  steers 6-15  n=0",
      "  steers 16+   n=  1  mean= 10  max=10",
    ]);
  });
});

describe("renderCalibrationReport: candidate cut-points", () => {
  test("splits the corpus at each candidate pair", () => {
    // 95 / 75 / 60 / 20 straddles all four candidate pairs differently, so a
    // sweep that ignored one of its two boundaries would move a count here.
    const report = renderCalibrationReport(
      "store",
      sessionsScored([95, 75, 60, 20, null])
    );

    assert.deepEqual(sectionLines(report, HEADER_CUT_POINTS), [
      "  high>= 88 mixed>= 70   high=  1 mixed=  1 guided=  2",
      "  high>= 80 mixed>= 50   high=  1 mixed=  2 guided=  1",
      "  high>= 70 mixed>= 35   high=  2 mixed=  1 guided=  1",
      "  high>= 90 mixed>= 40   high=  1 mixed=  2 guided=  1",
    ]);
  });

  test("marks a pair that empties a tier, and only that pair", () => {
    // 88/70 leaves `mixed` empty on this corpus — the exact defect FEA-3781
    // found in the shipped boundaries. The other three pairs populate all
    // three tiers, so a marker that fired on every row would be worthless.
    const report = renderCalibrationReport(
      "store",
      sessionsScored([95, 60, 20])
    );

    assert.deepEqual(sectionLines(report, HEADER_CUT_POINTS), [
      "  high>= 88 mixed>= 70   high=  1 mixed=  0 guided=  2  <- DEAD TIER",
      "  high>= 80 mixed>= 50   high=  1 mixed=  1 guided=  1",
      "  high>= 70 mixed>= 35   high=  1 mixed=  1 guided=  1",
      "  high>= 90 mixed>= 40   high=  1 mixed=  1 guided=  1",
    ]);
  });
});

describe("renderCalibrationReport: per-tier examples", () => {
  test("shows the four busiest sessions per tier and (none) for empty tiers", () => {
    const scored = [1, 2, 3, 4, 5].map((prompts) =>
      scoredSession({ id: `h${prompts}`, autonomy: 90, prompts })
    );

    const report = renderCalibrationReport("store", scored);

    assert.deepEqual(sectionLines(report, HEADER_EXAMPLES), [
      "  high:",
      "    h5 score=  90 prompts=  5 steers=  0 wall=1m harness=claude",
      "    h4 score=  90 prompts=  4 steers=  0 wall=1m harness=claude",
      "    h3 score=  90 prompts=  3 steers=  0 wall=1m harness=claude",
      "    h2 score=  90 prompts=  2 steers=  0 wall=1m harness=claude",
      "  mixed:",
      "    (none)",
      "  guided:",
      "    (none)",
      "  unknown:",
      "    (none)",
    ]);
  });

  test("truncates the id, rounds wall minutes, and names missing fields", () => {
    const report = renderCalibrationReport("store", [
      scoredSession({
        id: "0123456789abcdefgh",
        autonomy: null,
        steeringEpisodes: null,
        harness: null,
        headless: true,
        prompts: 3,
        wallMinutes: 12.7,
      }),
    ]);

    assert.deepEqual(sectionLines(report, HEADER_EXAMPLES), [
      "  high:",
      "    (none)",
      "  mixed:",
      "    (none)",
      "  guided:",
      "    (none)",
      "  unknown:",
      "    0123456789ab score=null prompts=  3 steers=null wall=13m harness=? headless",
    ]);
  });
});
