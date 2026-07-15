/**
 * @file activity-scoring.test.ts
 * @description FEA-2269 unit tests for the PURE per-window scorers: the layered
 * declared→structural model, the `implement`-requires-mutation and
 * `plan`-forbids-mutation invariants, the honest `other` bucket below the
 * confidence floor, and the declared-intent confidence boost. No DB, no session —
 * the scorer reads only abstract category counts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EvidenceLayer,
  emptyCategoryMix,
  ToolCategory,
} from "../src/main/collectors/evidence/evidence-model.js";
import {
  ACTIVITY_CONFIDENCE_FLOOR,
  scoreWindow,
} from "../src/main/collectors/parsing/activity-scoring.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";

// Build a full category-count record, overriding only the categories a test
// exercises (the rest stay zero-filled). No cast — undefined overrides are
// skipped so the result is a complete Record<ToolCategory, number>.
function counts(
  mix: Partial<Record<ToolCategory, number>>
): Record<ToolCategory, number> {
  const record = emptyCategoryMix();
  for (const category of Object.values(ToolCategory)) {
    const value = mix[category];
    if (value !== undefined) {
      record[category] = value;
    }
  }
  return record;
}

test("mutate-dominant window → implement, high confidence, structural layer", () => {
  const score = scoreWindow(counts({ [ToolCategory.MutateCode]: 4 }));
  assert.equal(score.phase, ACTIVITY_PHASE.Implement);
  assert.ok(score.confidence >= ACTIVITY_CONFIDENCE_FLOOR);
  assert.deepEqual(score.layers, [EvidenceLayer.Structural]);
});

test("read-dominant window → explore", () => {
  assert.equal(
    scoreWindow(counts({ [ToolCategory.ReadSearch]: 3 })).phase,
    ACTIVITY_PHASE.Explore
  );
});

test("test-run window → validate", () => {
  assert.equal(
    scoreWindow(counts({ [ToolCategory.TestRun]: 2 })).phase,
    ACTIVITY_PHASE.Validate
  );
});

test("git-lifecycle window → review", () => {
  assert.equal(
    scoreWindow(counts({ [ToolCategory.GitLifecycle]: 2 })).phase,
    ACTIVITY_PHASE.Review
  );
});

test("human steering + declared intent with no mutation → plan", () => {
  const score = scoreWindow(
    counts({ [ToolCategory.HumanTurn]: 2, [ToolCategory.DeclaredIntent]: 1 })
  );
  assert.equal(score.phase, ACTIVITY_PHASE.Plan);
  assert.ok(score.layers.includes(EvidenceLayer.Declared));
});

test("plan forbids mutation: human turns alongside a mutation never score plan", () => {
  // mutate present ⇒ implement wins and plan is zeroed (a mutating window is not
  // planning, however much steering it carries).
  const score = scoreWindow(
    counts({ [ToolCategory.HumanTurn]: 5, [ToolCategory.MutateCode]: 1 })
  );
  assert.notEqual(score.phase, ACTIVITY_PHASE.Plan);
});

test("run-command alone does not fabricate an implement label", () => {
  // RunCommand only SUPPORTS implement alongside mutation; on its own it carries
  // no phase and the window is the honest `other` bucket.
  const score = scoreWindow(counts({ [ToolCategory.RunCommand]: 3 }));
  assert.equal(score.phase, ACTIVITY_PHASE.Other);
});

test("empty window → other with zero confidence and no layers", () => {
  const score = scoreWindow(emptyCategoryMix());
  assert.equal(score.phase, ACTIVITY_PHASE.Other);
  assert.equal(score.confidence, 0);
  assert.deepEqual(score.layers, []);
});

test("near-tie below the floor → explicit other (AC-005)", () => {
  const score = scoreWindow(
    counts({ [ToolCategory.ReadSearch]: 1, [ToolCategory.MutateCode]: 1 })
  );
  assert.equal(score.phase, ACTIVITY_PHASE.Other);
  assert.ok(score.confidence < ACTIVITY_CONFIDENCE_FLOOR);
});

test("declared-intent boost lifts a borderline window over the floor", () => {
  const borderline = {
    [ToolCategory.ReadSearch]: 5,
    [ToolCategory.TestRun]: 2,
  };
  const withoutDeclared = scoreWindow(counts(borderline));
  assert.equal(
    withoutDeclared.phase,
    ACTIVITY_PHASE.Other,
    "explore beats validate but not by enough to clear the floor unaided"
  );
  const withDeclared = scoreWindow(
    counts({ ...borderline, [ToolCategory.DeclaredIntent]: 1 })
  );
  assert.equal(withDeclared.phase, ACTIVITY_PHASE.Explore);
  assert.ok(withDeclared.layers.includes(EvidenceLayer.Declared));
});

test("scoreWindow is pure: identical counts → identical result", () => {
  const input = counts({
    [ToolCategory.MutateCode]: 2,
    [ToolCategory.ReadSearch]: 1,
  });
  assert.deepEqual(scoreWindow(input), scoreWindow(input));
});
