/**
 * FEA-2274 (PRD-488): unit tests for the pure offline linguistic-distillation
 * modules — residual selection, the deterministic linguistic labeler, and the
 * coverage-uplift report core. These pin the measurement's semantics (what counts
 * as residual, which prose yields which candidate phase, and that the report is a
 * reproducible upper-bound uplift) independently of the corpus harness.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import {
  buildDistillationReport,
  type DistillSessionInput,
} from "../src/main/collectors/parsing/linguistic/distill-report.js";
import {
  detectLinguisticSignal,
  LINGUISTIC_RULES,
} from "../src/main/collectors/parsing/linguistic/linguistic-features.js";
import {
  isResidualSegment,
  selectResidualSegments,
} from "../src/main/collectors/parsing/linguistic/residual-selector.js";
import {
  createNormalizedSession,
  Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";
import {
  AutonomyBand,
  LengthBand,
  type SessionCohort,
} from "../src/main/telemetry/attribution-metrics.js";
import { hasClosedloopSignal } from "./golden/derive-linguistic-distillation.js";

const APPROX = 1e-9;
function approx(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < APPROX;
}

function cohort(): SessionCohort {
  return {
    harness: Harness.Claude,
    autonomyBand: AutonomyBand.Mixed,
    closedloopUser: false,
    lengthBand: LengthBand.Medium,
  };
}

// ── cohort signals (closed-set matching) ──────────────────────────────────────

function sessionWithTools(tools: NormalizedToolUse[]): NormalizedSession {
  return createNormalizedSession({ sessionId: "cohort-test", toolUses: tools });
}

test("hasClosedloopSignal detects both the mcp__ prefix and Codex's mcpServer field", () => {
  // Claude-style: the `mcp__closedloop__` name prefix.
  assert.equal(
    hasClosedloopSignal(
      sessionWithTools([
        { name: "mcp__closedloop__create-loop", timestamp: null },
      ])
    ),
    true
  );
  // Codex-style: the name carries NO `mcp__` prefix; the server is on mcpServer.
  assert.equal(
    hasClosedloopSignal(
      sessionWithTools([
        { name: "create-loop", timestamp: null, mcpServer: "closedloop" },
      ])
    ),
    true
  );
  // A name that merely CONTAINS "closedloop" (no prefix, no mcpServer) must not
  // match — closed-set discrimination per apps/desktop/AGENTS.md.
  assert.equal(
    hasClosedloopSignal(
      sessionWithTools([{ name: "team_closedloop_sync", timestamp: null }])
    ),
    false
  );
});

// ── residual-selector ─────────────────────────────────────────────────────────

test("isResidualSegment: `other` is always residual, `idle` never is", () => {
  assert.equal(
    isResidualSegment({ phase: ACTIVITY_PHASE.Other, confidence: 0.99 }),
    true
  );
  assert.equal(
    isResidualSegment({ phase: ACTIVITY_PHASE.Idle, confidence: 0 }),
    false
  );
});

test("isResidualSegment: an active phase is residual only below the confident floor", () => {
  // Confident floor is `medium` = confidence ≥ 0.5 (Q-003 cut-points).
  assert.equal(
    isResidualSegment({ phase: ACTIVITY_PHASE.Implement, confidence: 0.9 }),
    false
  );
  assert.equal(
    isResidualSegment({ phase: ACTIVITY_PHASE.Implement, confidence: 0.5 }),
    false
  );
  assert.equal(
    isResidualSegment({ phase: ACTIVITY_PHASE.Implement, confidence: 0.49 }),
    true
  );
});

test("selectResidualSegments preserves order and keeps caller fields", () => {
  const segs = [
    { phase: ACTIVITY_PHASE.Implement, confidence: 0.9, tag: "a" },
    { phase: ACTIVITY_PHASE.Other, confidence: 0.9, tag: "b" },
    { phase: ACTIVITY_PHASE.Plan, confidence: 0.2, tag: "c" },
  ];
  const residual = selectResidualSegments(segs);
  assert.deepEqual(
    residual.map((s) => s.tag),
    ["b", "c"]
  );
});

// ── linguistic-features ───────────────────────────────────────────────────────

test("detectLinguisticSignal maps representative prose to the expected phase", () => {
  const cases: [string, string][] = [
    ["Let's plan the approach before we touch code", ACTIVITY_PHASE.Plan],
    [
      "First I want to understand how the importer works",
      ACTIVITY_PHASE.Explore,
    ],
    [
      "Now implement the new endpoint and wire up the route",
      ACTIVITY_PHASE.Implement,
    ],
    ["lgtm, just a nitpick on naming", ACTIVITY_PHASE.Review],
    ["run the tests and make sure everything passes", ACTIVITY_PHASE.Validate],
    ["fix the failing test, it's still broken", ACTIVITY_PHASE.Rework],
  ];
  for (const [text, phase] of cases) {
    assert.equal(detectLinguisticSignal(text)?.phase, phase, text);
  }
});

test("detectLinguisticSignal returns null for prose with no activity cue", () => {
  assert.equal(detectLinguisticSignal("the weather is nice today"), null);
  assert.equal(detectLinguisticSignal(""), null);
  assert.equal(detectLinguisticSignal(null), null);
});

test("detectLinguisticSignal is order-deterministic (first rule wins)", () => {
  // Validation precedes rework in LINGUISTIC_RULES, so a phrase carrying both
  // cues resolves to `validate` every time.
  assert.equal(
    detectLinguisticSignal("run the tests, then fix the bug")?.phase,
    ACTIVITY_PHASE.Validate
  );
  // Every rule id is unique (no silent shadowing).
  const ids = LINGUISTIC_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ── distill-report ────────────────────────────────────────────────────────────

function corpus(): DistillSessionInput[] {
  return [
    {
      sessionId: "s1",
      cohort: cohort(),
      gapSpendUsd: 0,
      segments: [
        // Covered baseline (implement, high confidence).
        {
          state: ACTIVITY_PHASE.Implement,
          confidence: 0.9,
          spendUsd: 10,
          prose: "",
        },
        // Residual `other` with planning prose → matched → relabel to plan.
        {
          state: ACTIVITY_PHASE.Other,
          confidence: 0,
          spendUsd: 10,
          prose: "let's plan the approach here",
        },
      ],
    },
    {
      sessionId: "s2",
      cohort: cohort(),
      gapSpendUsd: 0,
      segments: [
        // Residual (review, low confidence) with neutral prose → no signal.
        {
          state: ACTIVITY_PHASE.Review,
          confidence: 0.3,
          spendUsd: 5,
          prose: "the weather is nice today",
        },
        // NON-residual (implement, high) whose prose WOULD match → must be ignored.
        {
          state: ACTIVITY_PHASE.Implement,
          confidence: 0.9,
          spendUsd: 5,
          prose: "let's plan the approach here",
        },
      ],
    },
  ];
}

test("buildDistillationReport: matched residual prose raises coverage (upper bound)", () => {
  const report = buildDistillationReport(corpus());

  // Baseline covered = implement(10, s1) + implement(5, s2) = 15 of 30 total.
  assert.ok(approx(report.before.overall.coverage, 15 / 30), "before coverage");
  // After: the s1 `other`(10) is relabeled to plan → covered = 25 of 30.
  assert.ok(approx(report.after.overall.coverage, 25 / 30), "after coverage");
  assert.ok(approx(report.overallCoverageUplift, 10 / 30), "uplift");

  assert.equal(report.totalSpendUsd, 30);
  // Residual = s1 `other`(10) + s2 low-confidence `review`(5); the two confident
  // `implement` segments are covered, not residual.
  assert.equal(report.residualSpendUsd, 15);
  assert.equal(report.residualSegmentCount, 2);
});

test("buildDistillationReport: the non-residual matching segment is not relabeled", () => {
  const report = buildDistillationReport(corpus());
  // Exactly one proposed rule (plan.cue), driven ONLY by the s1 residual segment.
  assert.equal(report.proposedRules.length, 1);
  const rule = report.proposedRules[0];
  assert.equal(rule.ruleId, "plan.cue");
  assert.equal(rule.phase, ACTIVITY_PHASE.Plan);
  assert.equal(rule.sessions, 1);
  assert.equal(rule.segments, 1);
  assert.equal(rule.residualSpendUsd, 10);
  // s2's neutral-prose review residual carried spend but matched nothing.
  assert.equal(report.matchedResidualSpendUsd, 10);
});

test("buildDistillationReport is deterministic (deep-equal across runs)", () => {
  assert.deepStrictEqual(
    buildDistillationReport(corpus()),
    buildDistillationReport(corpus())
  );
});
