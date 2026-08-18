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

test("git-lifecycle window → other (git is ambient under the state-aware model)", () => {
  // git_lifecycle carries no phase of its own now: a commit/push/PR window scores
  // no active phase and falls to the honest `other` bucket. Making it INHERIT the
  // surrounding phase is the stateful carry pass's job, not the per-window scorer's.
  const score = scoreWindow(counts({ [ToolCategory.GitLifecycle]: 2 }));
  assert.equal(score.phase, ACTIVITY_PHASE.Other);
  assert.deepEqual(score.layers, [EvidenceLayer.Structural]);
});

test("human steering + declared PLAN with no mutation → plan", () => {
  const score = scoreWindow(
    counts({ [ToolCategory.HumanTurn]: 2, [ToolCategory.DeclaredPlan]: 1 })
  );
  assert.equal(score.phase, ACTIVITY_PHASE.Plan);
  assert.ok(score.layers.includes(EvidenceLayer.Declared));
});

test("FEA-4184: a GENERIC declared signal (not plan-specific) never scores plan", () => {
  // codex P2: a non-planning declaration — an MCP `get-document`, a `/code-review`
  // skill, an `implement` trace phase — maps to the generic DeclaredIntent, NOT
  // DeclaredPlan. With no code mutation such a window used to argmax to `plan`
  // (planScore gated on any declared intent); the gate now keys on DeclaredPlan so
  // a generic declaration cannot fabricate `plan`.
  const genericOnly = scoreWindow(
    counts({ [ToolCategory.HumanTurn]: 2, [ToolCategory.DeclaredIntent]: 1 })
  );
  assert.notEqual(genericOnly.phase, ACTIVITY_PHASE.Plan);
  assert.equal(genericOnly.phase, ACTIVITY_PHASE.Other);
  // The generic declaration still contributes the Declared layer + confidence boost.
  assert.ok(genericOnly.layers.includes(EvidenceLayer.Declared));
});

test("FEA-4184: a bare human turn (a plain prompt, no declared intent) never scores plan", () => {
  // The misfire: a lone human-turn tick — present at the start of nearly every
  // session, and every time the user steers — used to argmax to `plan` at full
  // confidence (planScore = WEIGHT_HUMAN * humanTurns, nothing else scores). The
  // state-aware carry then made that eager `plan` the strong current phase and
  // propagated it across the session/branch. A user typing "fix the bug" is
  // steering, not planning: with no DECLARED planning signal there is no plan.
  const bareTurn = scoreWindow(counts({ [ToolCategory.HumanTurn]: 1 }));
  assert.notEqual(bareTurn.phase, ACTIVITY_PHASE.Plan);
  assert.equal(bareTurn.phase, ACTIVITY_PHASE.Other);

  // Many human turns still don't fabricate `plan` without a declared signal.
  const manyTurns = scoreWindow(counts({ [ToolCategory.HumanTurn]: 5 }));
  assert.notEqual(manyTurns.phase, ACTIVITY_PHASE.Plan);

  // A human turn alongside a read is explore (the honest ambient orientation),
  // NOT plan — the classic session-start shape the bug mislabelled.
  const turnPlusRead = scoreWindow(
    counts({ [ToolCategory.HumanTurn]: 1, [ToolCategory.ReadSearch]: 3 })
  );
  assert.equal(turnPlusRead.phase, ACTIVITY_PHASE.Explore);
});

test("FEA-4184: a declared PLAN signal (even alone) still scores plan", () => {
  // The gate is PLAN-specific declared presence, not human turns: a
  // `/create-plan`-style DeclaredPlan signal with no human-turn co-located tick
  // still yields `plan`, so the fix removes the false positive without dropping
  // the true positive.
  const declaredOnly = scoreWindow(counts({ [ToolCategory.DeclaredPlan]: 1 }));
  assert.equal(declaredOnly.phase, ACTIVITY_PHASE.Plan);
  assert.ok(declaredOnly.layers.includes(EvidenceLayer.Declared));
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

// ── AA-11: confidence tempered by evidence mass + layer corroboration ─────────
// These read only abstract category counts — no harness vocabulary — so they are
// inherently harness-general (a level-1, pure-math fix).

test("AA-11: a single-LAYER window can never report maximal confidence", () => {
  // Structural-only, single scorer firing: raw margin is 1.0 (runner-up 0), which
  // BEFORE AA-11 stored as confidence 1.0 on the thinnest possible evidence.
  const thin = scoreWindow(counts({ [ToolCategory.ReadSearch]: 10 }));
  assert.equal(thin.phase, ACTIVITY_PHASE.Explore, "label unchanged by AA-11");
  assert.ok(
    thin.confidence < 0.8,
    `single-layer window capped well below 1.0, got ${thin.confidence}`
  );
  // A lone declared-plan signal (declared-only ⇒ one layer) is likewise capped
  // below maximal. Post-FEA-4184 `plan` requires a plan-specific declaration — a
  // bare human turn no longer scores `plan` — so this exercises the single-layer cap
  // on the smallest window that still yields a plan label.
  const onePlan = scoreWindow(counts({ [ToolCategory.DeclaredPlan]: 1 }));
  assert.equal(onePlan.phase, ACTIVITY_PHASE.Plan);
  assert.ok(onePlan.confidence < 0.8);
});

test("AA-11: ~1.0 is reserved for multi-LAYER (declared+structural) corroboration", () => {
  const corroborated = scoreWindow(
    counts({ [ToolCategory.MutateCode]: 5, [ToolCategory.DeclaredIntent]: 2 })
  );
  assert.equal(corroborated.phase, ACTIVITY_PHASE.Implement);
  assert.deepEqual(corroborated.layers, [
    EvidenceLayer.Declared,
    EvidenceLayer.Structural,
  ]);
  assert.ok(
    corroborated.confidence >= 0.9,
    `multi-layer corroboration approaches 1.0, got ${corroborated.confidence}`
  );
});

test("AA-11: confidence scales with evidence mass (more corroborating units → higher)", () => {
  const lighter = scoreWindow(
    counts({ [ToolCategory.MutateCode]: 1, [ToolCategory.DeclaredIntent]: 1 })
  );
  const heavier = scoreWindow(
    counts({ [ToolCategory.MutateCode]: 3, [ToolCategory.DeclaredIntent]: 1 })
  );
  assert.equal(lighter.phase, ACTIVITY_PHASE.Implement);
  assert.equal(heavier.phase, ACTIVITY_PHASE.Implement);
  assert.ok(
    heavier.confidence > lighter.confidence,
    `more mass → more confidence: ${heavier.confidence} !> ${lighter.confidence}`
  );
});

test("AA-11: the LABEL gate is unchanged — a below-floor margin still falls to other", () => {
  // The temper touches the stored confidence, never the phase decision: a near-tie
  // that did not clear the margin floor before AA-11 still lands in `other`.
  const nearTie = scoreWindow(
    counts({ [ToolCategory.ReadSearch]: 1, [ToolCategory.MutateCode]: 1 })
  );
  assert.equal(nearTie.phase, ACTIVITY_PHASE.Other);
});

// ── AA-03: an INERT declaration claims nothing ────────────────────────────────
// These read only abstract counts, so they hold for any harness's vocabulary.

test("AA-03: a utility-only window claims NO declared provenance", () => {
  // The edac412f / 88afd667 / f9830b64 shape: the window's only declaration is an
  // unrecognized utility invocation (an auth, model-switch, or plugin command).
  // Before AA-03 it minted DeclaredIntent and stamped the FR-7 `declared` layer.
  const utilityOnly = scoreWindow(
    counts({ [ToolCategory.DeclaredUtility]: 2, [ToolCategory.HumanTurn]: 2 })
  );
  assert.ok(
    !utilityOnly.layers.includes(EvidenceLayer.Declared),
    `an inert declaration must not claim declared provenance, got ${JSON.stringify(utilityOnly.layers)}`
  );
  assert.deepEqual(utilityOnly.layers, [EvidenceLayer.Structural]);
  assert.equal(
    utilityOnly.phase,
    ACTIVITY_PHASE.Other,
    "no phase is reachable from utility declarations plus bare human turns"
  );
});

test("AA-03: an inert declaration grants NO confidence boost and adds no evidence mass", () => {
  // Same structural evidence either way; the only difference is a utility
  // declaration riding along. It must buy neither the boost nor extra mass.
  const bare = scoreWindow(counts({ [ToolCategory.MutateCode]: 3 }));
  const withUtility = scoreWindow(
    counts({ [ToolCategory.MutateCode]: 3, [ToolCategory.DeclaredUtility]: 4 })
  );
  assert.equal(withUtility.phase, ACTIVITY_PHASE.Implement);
  assert.equal(
    withUtility.confidence,
    bare.confidence,
    "a utility declaration changes neither the boost nor the evidence mass"
  );
});

test("AA-03: a GENUINE declaration still earns provenance + boost (no over-correction)", () => {
  // Guards against "fixing" AA-03 by muting the declared layer wholesale: a real
  // declared signal (e.g. a trace phase declaring the work) keeps both.
  const declared = scoreWindow(
    counts({ [ToolCategory.MutateCode]: 3, [ToolCategory.DeclaredIntent]: 2 })
  );
  const bare = scoreWindow(counts({ [ToolCategory.MutateCode]: 3 }));
  assert.ok(declared.layers.includes(EvidenceLayer.Declared));
  assert.ok(
    declared.confidence > bare.confidence,
    "a real declaration still boosts confidence"
  );
});

test("AA-03: `plan` stays unreachable from utility declarations", () => {
  // FEA-4184 gates `plan` on DeclaredPlan; AA-03 must not reopen the path by another
  // route — a pile of utility declarations plus steering is still not planning.
  const utilitySteering = scoreWindow(
    counts({ [ToolCategory.DeclaredUtility]: 6, [ToolCategory.HumanTurn]: 4 })
  );
  assert.notEqual(utilitySteering.phase, ACTIVITY_PHASE.Plan);
  assert.equal(utilitySteering.phase, ACTIVITY_PHASE.Other);
});

test("AA-09 (C2): unclassifiable commands can never reach a phase on their own", () => {
  // The polarity guard. An un-refined `RunCommand` is a command whose effect the
  // core could NOT read; no amount of them may fabricate work.
  for (const n of [1, 5, 50]) {
    const commandsOnly = scoreWindow(counts({ [ToolCategory.RunCommand]: n }));
    assert.equal(
      commandsOnly.phase,
      ACTIVITY_PHASE.Other,
      `${n} unreadable commands must stay honest \`other\``
    );
    assert.equal(commandsOnly.confidence, 0);
  }
});

test("AA-09 (C2): command support is bounded by the mutation it corroborates", () => {
  // E-1's failure: one scratch write beside a pile of analysis commands scored as
  // heavy implementation because every command added implement support linearly.
  // Support is now capped at the mutation count, so the mutation evidence — not
  // the unreadable commands — decides the label.
  // Past the cap, extra unreadable commands add NO implement score: one edit
  // beside 20 commands must not outrank the same edit beside 1, so piling on
  // commands cannot manufacture a stronger implement claim than the edit supports.
  // A competing read makes the implement score observable through the margin
  // instead of saturating at a lone winner.
  const scoreWith = (runCommand: number) =>
    scoreWindow(
      counts({
        [ToolCategory.MutateCode]: 2,
        [ToolCategory.RunCommand]: runCommand,
        [ToolCategory.ReadSearch]: 1,
      })
    );
  assert.equal(
    scoreWith(20).confidence,
    scoreWith(2).confidence,
    "beyond the cap, extra unreadable commands must not raise the implement claim"
  );
  assert.ok(
    scoreWith(20).confidence > 0,
    "sanity: the capped window still scores implement"
  );
  // The read-heavy analysis shape now resolves to explore rather than implement.
  const analysisShape = scoreWindow(
    counts({
      [ToolCategory.ReadSearch]: 20,
      [ToolCategory.MutateCode]: 3,
      [ToolCategory.RunCommand]: 30,
    })
  );
  assert.equal(
    analysisShape.phase,
    ACTIVITY_PHASE.Explore,
    "read-dominant investigation with incidental writes is exploration, not implementation"
  );
});

test("AA-09 (C2): genuine implementation is NOT downgraded (over-correction guard)", () => {
  // Guards against "fixing" C2 by starving implement: a window that really is
  // editing code must still label implement, with or without commands beside it.
  for (const mix of [
    {
      [ToolCategory.MutateCode]: 15,
      [ToolCategory.RunCommand]: 10,
      [ToolCategory.ReadSearch]: 2,
    },
    { [ToolCategory.MutateCode]: 8, [ToolCategory.RunCommand]: 8 },
    { [ToolCategory.MutateCode]: 5 },
  ]) {
    assert.equal(
      scoreWindow(counts(mix)).phase,
      ACTIVITY_PHASE.Implement,
      `genuine implementation must survive: ${JSON.stringify(mix)}`
    );
  }
});

test("AA-09 (C2): an unreadable command cannot corroborate a declared window", () => {
  // A declared-only window is single-layer and capped. Adding one un-refined
  // `RunCommand` must not manufacture a second layer and lift that cap — the
  // residue is non-corroborating for confidence exactly as it is for mass.
  const declaredOnly = scoreWindow(counts({ [ToolCategory.DeclaredPlan]: 1 }));
  const declaredPlusResidue = scoreWindow(
    counts({ [ToolCategory.DeclaredPlan]: 1, [ToolCategory.RunCommand]: 1 })
  );
  assert.equal(
    declaredPlusResidue.confidence,
    declaredOnly.confidence,
    "an unreadable command must not raise confidence"
  );
  assert.deepEqual(
    declaredPlusResidue.layers,
    declaredOnly.layers,
    "an unreadable command must not add an evidence layer"
  );
  assert.ok(
    !declaredPlusResidue.layers.includes(EvidenceLayer.Structural),
    "unreadable residue is not a structural layer"
  );
  // Guard the other direction: a REAL structural signal still corroborates, so
  // the exclusion cannot be "fixed" by dropping the structural layer entirely.
  const declaredPlusRead = scoreWindow(
    counts({ [ToolCategory.DeclaredPlan]: 1, [ToolCategory.ReadSearch]: 1 })
  );
  assert.ok(
    declaredPlusRead.layers.includes(EvidenceLayer.Structural),
    "readable structural evidence must still register its layer"
  );
});

test("AA-04: explore is reachable from shell-derived reads alone", () => {
  // Before AA-04 only a harness's own Read/Grep/Glob produced `ReadSearch`, so a
  // shell-only harness could never explore. The scorer side of that contract:
  // ReadSearch alone is a first-class explore signal.
  const shellReads = scoreWindow(counts({ [ToolCategory.ReadSearch]: 5 }));
  assert.equal(shellReads.phase, ACTIVITY_PHASE.Explore);
  assert.ok(shellReads.confidence > 0);
});

// ── AA-09 C1: mutations score by what they TOUCHED ───────────────────────────

test("AA-09 C1: a scratch write scores no phase, no layer, and no confidence", () => {
  // The audit's E-1 shape: bookkeeping writes beside orientation reads. Before
  // C1 these were `MutateCode`, so three of them beat two reads (9 vs 4) and the
  // window read as implementation of files the project never contained.
  const scratchOnly = scoreWindow(counts({ [ToolCategory.MutateScratch]: 3 }));
  assert.equal(scratchOnly.phase, ACTIVITY_PHASE.Other);
  assert.equal(scratchOnly.confidence, 0);
  assert.deepEqual(
    scratchOnly.layers,
    [],
    "bookkeeping is observed activity but corroborates nothing"
  );
  // Beside real reads, the reads now decide the window.
  const withReads = scoreWindow(
    counts({ [ToolCategory.MutateScratch]: 3, [ToolCategory.ReadSearch]: 2 })
  );
  assert.equal(withReads.phase, ACTIVITY_PHASE.Explore);
});

test("AA-09 C1: scratch adds no evidence mass, so it cannot inflate confidence", () => {
  const bare = scoreWindow(counts({ [ToolCategory.ReadSearch]: 2 }));
  const padded = scoreWindow(
    counts({ [ToolCategory.ReadSearch]: 2, [ToolCategory.MutateScratch]: 8 })
  );
  assert.equal(padded.phase, bare.phase);
  assert.equal(
    padded.confidence,
    bare.confidence,
    "eight bookkeeping writes must not make the same explore claim more certain"
  );
});

test("AA-09 C1: a documentation edit scores implement, but never outvotes real code", () => {
  const docsOnly = scoreWindow(counts({ [ToolCategory.MutateDocument]: 3 }));
  assert.equal(
    docsOnly.phase,
    ACTIVITY_PHASE.Implement,
    "writing documentation is producing a deliverable, not a blank"
  );
  assert.ok(docsOnly.confidence > 0);
  // One source edit beside three doc edits is still a source-led window, and a
  // reader beats prose: the doc weight is deliberately a third of a code edit.
  const mixed = scoreWindow(
    counts({ [ToolCategory.MutateCode]: 1, [ToolCategory.MutateDocument]: 3 })
  );
  assert.equal(mixed.phase, ACTIVITY_PHASE.Implement);
  const codeOnly = scoreWindow(counts({ [ToolCategory.MutateCode]: 1 }));
  assert.ok(
    mixed.confidence >= codeOnly.confidence,
    "documentation beside code corroborates rather than dilutes"
  );
});

test("AA-09 C1: only a SOURCE mutation vetoes plan", () => {
  // Writing the plan document inside a declared planning window is planning.
  const declaredPlanWithDocs = scoreWindow(
    counts({
      [ToolCategory.DeclaredPlan]: 2,
      [ToolCategory.MutateDocument]: 1,
      [ToolCategory.HumanTurn]: 2,
    })
  );
  assert.equal(declaredPlanWithDocs.phase, ACTIVITY_PHASE.Plan);
  // As is a bookkeeping handoff.
  const declaredPlanWithScratch = scoreWindow(
    counts({
      [ToolCategory.DeclaredPlan]: 2,
      [ToolCategory.MutateScratch]: 1,
      [ToolCategory.HumanTurn]: 2,
    })
  );
  assert.equal(declaredPlanWithScratch.phase, ACTIVITY_PHASE.Plan);
  // But editing SOURCE is not planning, however much steering it carries — the
  // AC-002.3 invariant the veto exists for, unchanged.
  const declaredPlanWithCode = scoreWindow(
    counts({
      [ToolCategory.DeclaredPlan]: 2,
      [ToolCategory.MutateCode]: 1,
      [ToolCategory.HumanTurn]: 2,
    })
  );
  assert.notEqual(declaredPlanWithCode.phase, ACTIVITY_PHASE.Plan);
});

test("AA-09 C1: an unreadable command is not corroborated into implement by prose", () => {
  // Implement support stays bounded by the SOURCE mutation count, so a doc edge
  // beside a pile of unreadable commands cannot resurrect the C2 inflation.
  const docsPlusResidue = scoreWindow(
    counts({ [ToolCategory.MutateDocument]: 1, [ToolCategory.RunCommand]: 20 })
  );
  const docsAlone = scoreWindow(counts({ [ToolCategory.MutateDocument]: 1 }));
  assert.equal(docsPlusResidue.confidence, docsAlone.confidence);
});
