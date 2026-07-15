/**
 * @file attribution-metrics.test.ts
 * @description FEA-2266 unit tests for the PURE metric module
 * (`src/main/attribution-metrics.ts`). Pins the taxonomy/confidence/cohort
 * vocabularies (drift guard), the band cut-point functions, and exact Coverage —
 * including the `idle`/gap exclusion, per-cohort slicing/reconciliation, and
 * totality over empty/edge input. Coverage runs on the classifier's own output;
 * no human ground truth is involved.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACTIVITY_STATE_VALUES,
  ActivityState,
  ATTRIBUTION_METRIC_VERSION,
  AutonomyBand,
  attributeSegmentSpendUsd,
  autonomyBandFor,
  type ClassifiedSegment,
  COHORT_AXIS_VALUES,
  CONFIDENCE_BUCKET_VALUES,
  ConfidenceBucket,
  type CoverageSession,
  computeCoverage,
  confidenceBucketFor,
  isConfident,
  LengthBand,
  type SessionCohort,
  type SpendSegmentSpan,
  sessionLengthBandFor,
  sessionTotalSpendUsd,
  TAXONOMY_VERSION,
  type TokenSpendEvent,
} from "../src/main/attribution-metrics.js";
import { Harness } from "../src/main/collectors/types.js";

function cohort(overrides: Partial<SessionCohort> = {}): SessionCohort {
  return {
    harness: Harness.Claude,
    autonomyBand: AutonomyBand.Agentic,
    closedloopUser: true,
    lengthBand: LengthBand.Long,
    ...overrides,
  };
}

function seg(
  state: ActivityState,
  confidence: ConfidenceBucket,
  spendUsd: number
): ClassifiedSegment {
  return { state, confidence, spendUsd };
}

function coverageSession(
  sessionId: string,
  segments: ClassifiedSegment[],
  c: SessionCohort = cohort()
): CoverageSession {
  return { sessionId, cohort: c, segments };
}

describe("vocabulary pins (drift guards)", () => {
  test("taxonomy member set is pinned", () => {
    assert.deepEqual(
      [...ACTIVITY_STATE_VALUES],
      [
        "explore",
        "plan",
        "implement",
        "review",
        "validate",
        "rework",
        "other",
        "idle",
      ]
    );
    assert.equal(TAXONOMY_VERSION, 1);
    assert.equal(ATTRIBUTION_METRIC_VERSION, 1);
  });

  test("confidence buckets are ordered low→high", () => {
    assert.deepEqual([...CONFIDENCE_BUCKET_VALUES], ["low", "medium", "high"]);
  });

  test("cohort axes are the PLN-1196 minimum set", () => {
    assert.deepEqual(
      [...COHORT_AXIS_VALUES],
      ["harness", "autonomy_band", "closedloop_user", "length_band"]
    );
  });

  test("the harness cohort vocabulary IS the imported Harness SSOT", () => {
    assert.deepEqual(Object.values(Harness).sort(), [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "opencode",
    ]);
  });
});

describe("band + confidence helpers", () => {
  test("confidenceBucketFor bins (and clamps) a 0..1 confidence", () => {
    assert.equal(confidenceBucketFor(0.2), ConfidenceBucket.Low);
    assert.equal(confidenceBucketFor(0.49), ConfidenceBucket.Low);
    assert.equal(confidenceBucketFor(0.5), ConfidenceBucket.Medium); // boundary
    assert.equal(confidenceBucketFor(0.84), ConfidenceBucket.Medium);
    assert.equal(confidenceBucketFor(0.85), ConfidenceBucket.High); // boundary
    assert.equal(confidenceBucketFor(-1), ConfidenceBucket.Low); // clamp
    assert.equal(confidenceBucketFor(2), ConfidenceBucket.High); // clamp
  });

  test("isConfident threshold is medium-or-higher", () => {
    assert.equal(isConfident(ConfidenceBucket.Low), false);
    assert.equal(isConfident(ConfidenceBucket.Medium), true);
    assert.equal(isConfident(ConfidenceBucket.High), true);
  });

  test("autonomyBandFor uses the shared cut-points", () => {
    assert.equal(autonomyBandFor(0), AutonomyBand.HumanSteered);
    assert.equal(autonomyBandFor(33), AutonomyBand.HumanSteered);
    assert.equal(autonomyBandFor(34), AutonomyBand.Mixed); // boundary
    assert.equal(autonomyBandFor(66), AutonomyBand.Mixed);
    assert.equal(autonomyBandFor(67), AutonomyBand.Agentic); // boundary
    assert.equal(autonomyBandFor(100), AutonomyBand.Agentic);
  });

  test("sessionLengthBandFor uses the shared cut-points (ms)", () => {
    assert.equal(sessionLengthBandFor(0), LengthBand.Short);
    assert.equal(sessionLengthBandFor(5 * 60_000 - 1), LengthBand.Short);
    assert.equal(sessionLengthBandFor(5 * 60_000), LengthBand.Medium); // boundary
    assert.equal(sessionLengthBandFor(30 * 60_000 - 1), LengthBand.Medium);
    assert.equal(sessionLengthBandFor(30 * 60_000), LengthBand.Long); // boundary
  });
});

describe("Coverage", () => {
  test("covered = confident, non-other, non-idle spend / total", () => {
    const result = computeCoverage([
      coverageSession("a", [
        seg(ActivityState.Implement, ConfidenceBucket.High, 6), // covered
        seg(ActivityState.Other, ConfidenceBucket.High, 2), // excluded: other
        seg(ActivityState.Explore, ConfidenceBucket.Low, 2), // excluded: not confident
      ]),
    ]);
    assert.equal(result.overall.coveredSpendUsd, 6);
    assert.equal(result.overall.totalSpendUsd, 10);
    assert.equal(result.overall.coverage, 0.6);
    assert.equal(result.overall.sessionCount, 1);
    assert.equal(result.overall.lowSample, true); // 1 < MIN_COHORT_CELL_SESSIONS
  });

  test("a confident idle segment is excluded from covered spend", () => {
    const result = computeCoverage([
      coverageSession("a", [
        seg(ActivityState.Implement, ConfidenceBucket.High, 5), // covered
        seg(ActivityState.Idle, ConfidenceBucket.High, 5), // excluded despite high conf
      ]),
    ]);
    assert.equal(result.overall.coveredSpendUsd, 5);
    assert.equal(result.overall.coverage, 0.5);

    const idleOnly = computeCoverage([
      coverageSession("b", [seg(ActivityState.Idle, ConfidenceBucket.High, 4)]),
    ]);
    assert.equal(idleOnly.overall.coverage, 0);
    assert.equal(idleOnly.overall.coveredSpendUsd, 0);
  });

  test("gap spend counts toward the denominator but is never covered", () => {
    const result = computeCoverage([
      {
        sessionId: "a",
        cohort: cohort(),
        segments: [seg(ActivityState.Implement, ConfidenceBucket.High, 6)],
        gapSpendUsd: 4, // unlabeled-turn spend = implicit `other`
      },
    ]);
    assert.equal(result.overall.coveredSpendUsd, 6);
    assert.equal(
      result.overall.totalSpendUsd,
      10,
      "gap spend is in the total, so it cannot be silently dropped"
    );
    assert.equal(result.overall.coverage, 0.6);
  });

  test("empty corpus and all-other are zero, never NaN", () => {
    const empty = computeCoverage([]);
    assert.equal(empty.overall.coverage, 0);
    assert.equal(empty.overall.totalSpendUsd, 0);
    assert.equal(empty.overall.sessionCount, 0);
    assert.ok(!Number.isNaN(empty.overall.coverage));

    const allOther = computeCoverage([
      coverageSession("a", [
        seg(ActivityState.Other, ConfidenceBucket.High, 3),
      ]),
    ]);
    assert.equal(allOther.overall.coverage, 0);
    assert.equal(allOther.overall.totalSpendUsd, 3);
  });

  test("per-cohort cells reconcile to the overall totals", () => {
    const result = computeCoverage([
      coverageSession(
        "a",
        [seg(ActivityState.Implement, ConfidenceBucket.High, 6)],
        cohort({ harness: Harness.Claude })
      ),
      coverageSession(
        "b",
        [seg(ActivityState.Implement, ConfidenceBucket.High, 4)],
        cohort({ harness: Harness.Codex })
      ),
    ]);
    const claude = result.byCohort.harness.claude;
    const codex = result.byCohort.harness.codex;
    assert.equal(
      claude.coveredSpendUsd + codex.coveredSpendUsd,
      result.overall.coveredSpendUsd
    );
    assert.equal(
      claude.totalSpendUsd + codex.totalSpendUsd,
      result.overall.totalSpendUsd
    );
    // Every required axis is present in the slice.
    for (const axis of COHORT_AXIS_VALUES) {
      assert.ok(Object.keys(result.byCohort[axis]).length > 0, axis);
    }
  });

  test("an unknown harness lands in the 'unknown' cohort key", () => {
    const result = computeCoverage([
      coverageSession(
        "a",
        [seg(ActivityState.Implement, ConfidenceBucket.High, 1)],
        cohort({ harness: null })
      ),
    ]);
    assert.ok(result.byCohort.harness.unknown);
    assert.equal(result.byCohort.harness.unknown.sessionCount, 1);
  });
});

describe("spend attribution", () => {
  const segments: SpendSegmentSpan[] = [
    { startTs: "2026-06-01T10:00:00.000Z", endTs: "2026-06-01T10:10:00.000Z" },
    { startTs: "2026-06-01T10:10:00.000Z", endTs: "2026-06-01T10:20:00.000Z" },
  ];
  const events: TokenSpendEvent[] = [
    { createdAt: "2026-06-01T10:05:00.000Z", costUsd: 1 }, // → segment 0
    { createdAt: "2026-06-01T10:15:00.000Z", costUsd: 2 }, // → segment 1
    { createdAt: "2026-06-01T10:18:00.000Z", costUsd: 0.5 }, // → segment 1
    { createdAt: "2026-06-01T10:25:00.000Z", costUsd: 4 }, // outside → gap (dropped)
  ];

  test("attributes per-segment spend by created_at interval (half-open)", () => {
    assert.deepEqual(attributeSegmentSpendUsd(events, segments), [1, 2.5]);
  });

  test("a turn exactly at endTs belongs to the next segment, not the prior", () => {
    const boundary: TokenSpendEvent[] = [
      { createdAt: "2026-06-01T10:10:00.000Z", costUsd: 7 },
    ];
    // 10:10 is the end of segment 0 and the start of segment 1 → segment 1.
    assert.deepEqual(attributeSegmentSpendUsd(boundary, segments), [0, 7]);
  });

  test("sessionTotalSpendUsd sums every turn (incl. gap turns)", () => {
    assert.equal(sessionTotalSpendUsd(events), 7.5);
  });

  test("gap spend = total − Σ(attributed)", () => {
    const attributed = attributeSegmentSpendUsd(events, segments).reduce(
      (sum, usd) => sum + usd,
      0
    );
    assert.equal(sessionTotalSpendUsd(events) - attributed, 4);
  });
});
