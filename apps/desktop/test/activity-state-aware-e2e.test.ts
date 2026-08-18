/**
 * @file activity-state-aware-e2e.test.ts
 * @description PRD-488 state-aware attribution: end-to-end assertions through
 * `classifyActivitySegments` for the two behaviours the state-aware model adds —
 * (1) a code-review session (a review REQUEST + reads) classifies as `review`,
 * NOT `explore`/`rework` (the motivating bug); (2) reads DURING implementation
 * inherit `implement` instead of spawning a fresh `explore` bucket.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyActivitySegments } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import {
  Harness,
  type NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { makeSession, toolUse } from "./normalized-session-test-utils.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";

function turn(timestamp: string): NormalizedTokenRecord {
  return {
    timestamp,
    model: "claude-sonnet-4-5",
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
  };
}

const activePhases = (segments: { phase: string }[]): string[] =>
  segments.map((s) => s.phase).filter((p) => p !== ACTIVITY_PHASE.Idle);

// The PR's headline invariant, asserted end-to-end: the carry/split path keeps the
// tiling contiguous, complete, and positive-width (no gap/overlap, no zero span).
// Throws (rather than calling assert.* outside a test body) so biome's
// noMisplacedAssertion rule stays satisfied; a throw fails the calling test all the same.
function assertContiguous(
  segments: { startMs: number; endMs: number }[]
): void {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].endMs <= segments[i].startMs) {
      throw new Error(`segment ${i} must have positive width`);
    }
    if (
      i + 1 < segments.length &&
      segments[i].endMs !== segments[i + 1].startMs
    ) {
      throw new Error(
        `segment ${i} must abut segment ${i + 1} (no gap/overlap)`
      );
    }
  }
}

test("a code-review session (review command + reads) classifies as review, not explore/rework", () => {
  const session = makeSession({
    startedAt: T0,
    endedAt: T3,
    tokenSeries: [turn(T0), turn(T1), turn(T2), turn(T3)],
    slashCommands: [{ name: "code-review", timestamp: T0 }],
    // the agent reviews by reading the code — no edits (a pure review)
    toolUses: [toolUse("Read", T1), toolUse("Grep", T2), toolUse("Read", T3)],
  });

  const segments = classifyActivitySegments(session, Harness.Claude);
  assertContiguous(segments);
  const phases = activePhases(segments);

  assert.ok(phases.length > 0, "expected active segments");
  for (const phase of phases) {
    assert.equal(
      phase,
      ACTIVITY_PHASE.Review,
      `every active segment should be review, saw ${phase}`
    );
  }
  assert.ok(!phases.includes(ACTIVITY_PHASE.Explore), "no stray explore");
  assert.ok(!phases.includes(ACTIVITY_PHASE.Rework), "no false rework");
});

test("a natural-language 'review my changes' request classifies as review too", () => {
  const session = makeSession({
    startedAt: T0,
    endedAt: T3,
    tokenSeries: [turn(T0), turn(T1), turn(T2), turn(T3)],
    messages: [
      { role: "human", timestamp: T0, text: "code review my local changes" },
    ],
    toolUses: [toolUse("Read", T1), toolUse("Read", T2), toolUse("Grep", T3)],
  });

  const segments = classifyActivitySegments(session, Harness.Claude);
  assertContiguous(segments);
  const phases = activePhases(segments);
  assert.ok(phases.length > 0);
  for (const phase of phases) {
    assert.equal(phase, ACTIVITY_PHASE.Review, `saw ${phase}`);
  }
});

test("reads during implementation inherit implement, not a fresh explore bucket", () => {
  const session = makeSession({
    startedAt: T0,
    endedAt: T3,
    tokenSeries: [turn(T0), turn(T1), turn(T2), turn(T3)],
    // edit first (implement), then reads that used to score as explore
    toolUses: [toolUse("Edit", T1), toolUse("Read", T2), toolUse("Read", T3)],
  });

  const segments = classifyActivitySegments(session, Harness.Claude);
  assertContiguous(segments);
  const phases = activePhases(segments);
  assert.ok(phases.length > 0);
  for (const phase of phases) {
    assert.equal(
      phase,
      ACTIVITY_PHASE.Implement,
      `reads should inherit implement, saw ${phase}`
    );
  }
});
