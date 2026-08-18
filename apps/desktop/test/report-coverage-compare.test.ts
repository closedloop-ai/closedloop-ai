import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  branchChurnAllowancePct,
  CompareOutcome,
  classifyPartitionDelta,
  compareToBase,
  MAX_CHURN_ALLOWANCE_PCT,
  PartitionDeltaKind,
} from "../scripts/report-coverage-compare.mjs";
import {
  DenominatorKind,
  denominatorKindOf,
} from "../scripts/report-coverage-lib.mjs";

const BRANCH_CHURN_NOTE_PATTERN = /branch universe re-enumerated/;
// Two runs over a byte-identical partition tree publish the same fingerprint;
// the value itself is opaque, only the agreement matters.
const UNCHANGED_SOURCE = "hsource1";
const CHANGED_SOURCE = "hsource2";
// The run-level half of the provenance: two runs over a byte-identical TEST
// tree publish the same fingerprint. A partition's production source can be
// identical while a test that exercised it was weakened, so the allowance needs
// this proof as well as `sourceHash`.
const UNCHANGED_TESTS = "htests1";
const CHANGED_TESTS = "htests2";
const PROVEN_TREES = {
  currentTestTreeHash: UNCHANGED_TESTS,
  baseTestTreeHash: UNCHANGED_TESTS,
};

const METHOD = { c8: "^10.1.3", coverageV8: "^4.1.8", nodeMajor: 24 };

describe("compareToBase", () => {
  const basePartitions = {
    gateway: {
      branchesCovered: 5,
      branchesTotal: 10,
      branchPct: 50,
      executedFiles: 10,
      sourceFiles: 10,
    },
  };
  const current = (overrides: Partial<(typeof basePartitions)["gateway"]>) => ({
    gateway: { ...basePartitions.gateway, ...overrides },
  });

  test("ok when every partition holds or rises", () => {
    const verdict = compareToBase(current({ branchPct: 50 }), METHOD, {
      method: METHOD,
      partitions: basePartitions,
    });
    assert.equal(verdict.outcome, CompareOutcome.Ok);
  });

  test("drop names the falling partition with both percentages", () => {
    const verdict = compareToBase(current({ branchPct: 49.5 }), METHOD, {
      method: METHOD,
      partitions: basePartitions,
    });
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.deepEqual(verdict.drops, [
      { partition: "gateway", basePct: 50, currentPct: 49.5 },
    ]);
  });

  // The real numbers that wedged nine unrelated PRs at once: main's published
  // base measured the gateway partition at 2220/3297 and every PR run measured
  // 2216/3294 — of a `src/server/**` tree that no commit in the window touched.
  const churnedBase = {
    gateway: {
      branchesCovered: 2220,
      branchesTotal: 3297,
      branchPct: 67.33,
      executedFiles: 84,
      sourceFiles: 84,
      sourceHash: UNCHANGED_SOURCE,
    },
  };
  const churnedCurrent = (covered: number, pct: number) => ({
    gateway: {
      branchesCovered: covered,
      branchesTotal: 3294,
      branchPct: pct,
      executedFiles: 84,
      sourceFiles: 84,
      sourceHash: UNCHANGED_SOURCE,
    },
  });

  test("a dip the branch-universe churn accounts for is a note, not a drop", () => {
    // Three branch entries left the universe, which is worth 0.09pp; the
    // 0.06pp dip is inside that and is not evidence of less testing.
    const verdict = compareToBase(
      churnedCurrent(2216, 67.27),
      METHOD,
      {
        method: METHOD,
        partitions: churnedBase,
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(verdict.outcome, CompareOutcome.Ok);
    assert.equal(verdict.drops.length, 0);
    assert.match(verdict.notes[0]?.reason ?? "", BRANCH_CHURN_NOTE_PATTERN);
  });

  test("a dip larger than the churn accounts for is still a drop", () => {
    // Same three-entry churn, but the percentage fell far past what it can
    // explain. The allowance must not become a blanket amnesty.
    const verdict = compareToBase(
      churnedCurrent(2100, 63.75),
      METHOD,
      {
        method: METHOD,
        partitions: churnedBase,
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.equal(verdict.drops[0]?.partition, "gateway");
  });

  test("method identity drift refuses comparison instead of guessing", () => {
    const verdict = compareToBase(
      current({ branchPct: 90 }),
      { ...METHOD, nodeMajor: 26 },
      { method: METHOD, partitions: basePartitions }
    );
    assert.equal(verdict.outcome, CompareOutcome.Discontinuity);
    assert.equal(verdict.drops.length, 0);
  });

  // Dropping one flaky suite from the node lane's selection — an
  // `EXCLUDED_TEST_FILES` line, or an `include` edit — changes which tests
  // produced the numbers while leaving every production file AND every test
  // file byte-identical. Both tree proofs therefore still agree, and without
  // `nodeLaneSelectionHash` in the method identity this run was granted the
  // full MAX_CHURN_ALLOWANCE_PCT and absorbed a real 0.90pp regression as
  // churn. The numbers genuinely are not like-for-like, so the only honest
  // outcome is a refusal.
  test("a test-selection change refuses the comparison instead of buying an allowance", () => {
    const selectionBase = {
      gateway: {
        branchesCovered: 2703,
        branchesTotal: 3297,
        branchPct: 82,
        executedFiles: 84,
        sourceFiles: 84,
        sourceHash: UNCHANGED_SOURCE,
      },
    };
    const selectionCurrent = {
      gateway: {
        branchesCovered: 2644,
        branchesTotal: 3260,
        branchPct: 81.1,
        executedFiles: 84,
        sourceFiles: 84,
        sourceHash: UNCHANGED_SOURCE,
      },
    };
    const base = {
      method: { ...METHOD, nodeLaneSelectionHash: "hselect1" },
      partitions: selectionBase,
      testTreeHash: UNCHANGED_TESTS,
    };

    const verdict = compareToBase(
      selectionCurrent,
      { ...METHOD, nodeLaneSelectionHash: "hselect2" },
      base,
      UNCHANGED_TESTS
    );

    assert.equal(verdict.outcome, CompareOutcome.Discontinuity);
    assert.equal(verdict.drops.length, 0);
    assert.equal(verdict.notes.length, 0);

    // The same numbers with the selection proven identical are the churn case
    // the allowance exists for, so the refusal above is attributable to the
    // selection change and to nothing else in this record.
    const unchangedSelection = compareToBase(
      selectionCurrent,
      { ...METHOD, nodeLaneSelectionHash: "hselect1" },
      base,
      UNCHANGED_TESTS
    );
    assert.equal(unchangedSelection.outcome, CompareOutcome.Ok);
    assert.match(
      unchangedSelection.notes[0]?.reason ?? "",
      BRANCH_CHURN_NOTE_PATTERN
    );
  });

  test("partition missing from the run is a drop, not a silent pass", () => {
    const verdict = compareToBase({}, METHOD, {
      method: METHOD,
      partitions: basePartitions,
    });
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.equal(verdict.drops[0]?.partition, "gateway");
  });

  test("a file that stopped being executed is a drop even when the percentage rises", () => {
    // sourceFiles held, executedFiles fell — the tree still contains the file,
    // nothing imports it any more. The unreached remainder grew, so the rising
    // percentage is an artifact of measuring less, and must not pass.
    const verdict = compareToBase(
      current({ branchPct: 60, executedFiles: 9 }),
      METHOD,
      { method: METHOD, partitions: basePartitions }
    );
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.ok(verdict.drops.some((d) => d.reason?.includes("unreached files")));
  });

  test("a deleted file is not a breadth drop — the remainder is what matters", () => {
    // Both counts fell by one: the file is gone from the tree, so nothing
    // stopped being reached. A raw executedFiles comparison called this a
    // regression and wedged every deletion PR; the remainder does not.
    const verdict = compareToBase(
      current({ branchPct: 50, executedFiles: 9, sourceFiles: 9 }),
      METHOD,
      { method: METHOD, partitions: basePartitions }
    );
    assert.equal(verdict.outcome, CompareOutcome.Ok);
    assert.equal(verdict.drops.length, 0);
  });

  test("a dip a shrunken universe explains is a note, not a drop", () => {
    // Deleting code that was better covered than its partition average lowers
    // the average while nothing is tested less. Two real measurements can see
    // that (sourceFiles is in both); a committed baseline could not, which is
    // why it needed a human declaration to let this through.
    const verdict = compareToBase(
      current({ branchPct: 45, executedFiles: 9, sourceFiles: 9 }),
      METHOD,
      { method: METHOD, partitions: basePartitions }
    );
    assert.equal(verdict.outcome, CompareOutcome.Ok);
    assert.equal(verdict.drops.length, 0);
    assert.equal(verdict.notes[0]?.partition, "gateway");
    assert.ok(verdict.notes[0]?.reason?.includes("source universe shrank"));
  });

  test("a dip is still a drop when the universe did not shrink", () => {
    const verdict = compareToBase(
      current({ branchPct: 45, executedFiles: 10, sourceFiles: 11 }),
      METHOD,
      { method: METHOD, partitions: basePartitions }
    );
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.ok(verdict.drops.some((d) => d.currentPct === 45));
  });
});

describe("branchChurnAllowancePct", () => {
  const unchanged = (branchesTotal: number) => ({
    branchesTotal,
    sourceHash: UNCHANGED_SOURCE,
  });

  test("an unchanged branch universe allows nothing — the strict ratchet holds", () => {
    assert.equal(
      branchChurnAllowancePct(
        unchanged(5212),
        unchanged(5212),
        "gateway",
        PROVEN_TREES
      ),
      0
    );
  });

  test("the allowance is the churn's own share of the total, in either direction", () => {
    assert.equal(
      branchChurnAllowancePct(
        unchanged(200),
        unchanged(202),
        "gateway",
        PROVEN_TREES
      ),
      1
    );
    assert.equal(
      branchChurnAllowancePct(
        unchanged(200),
        unchanged(198),
        "gateway",
        PROVEN_TREES
      ),
      1
    );
  });

  test("a base without a readable total makes the gate stricter, never laxer", () => {
    assert.equal(
      branchChurnAllowancePct(
        unchanged(3294),
        { sourceHash: UNCHANGED_SOURCE },
        "gateway",
        PROVEN_TREES
      ),
      0
    );
    assert.equal(
      branchChurnAllowancePct(
        unchanged(0),
        unchanged(3297),
        "gateway",
        PROVEN_TREES
      ),
      0
    );
  });

  // Thread PRRT_kwDOQ4gDpM6Y60v6 (wongk): the base comes from artifact JSON, so
  // a zero total would hand out a 100pp allowance and a negative one MORE than
  // that, turning any drop into a note. Corrupt input must refuse to compare.
  test("a non-positive base total refuses the allowance instead of granting 100pp", () => {
    assert.equal(
      branchChurnAllowancePct(
        unchanged(3294),
        unchanged(0),
        "gateway",
        PROVEN_TREES
      ),
      0
    );
    assert.equal(
      branchChurnAllowancePct(
        unchanged(3294),
        unchanged(-3297),
        "gateway",
        PROVEN_TREES
      ),
      0
    );
    assert.equal(
      branchChurnAllowancePct(
        unchanged(3294),
        unchanged(Number.NaN),
        "gateway",
        PROVEN_TREES
      ),
      0
    );
  });

  // Threads PRRT_kwDOQ4gDpM6Y6ucj (codex) and PRRT_kwDOQ4gDpM6Y60v5 (wongk).
  test("a source-derived denominator never earns a churn allowance", () => {
    assert.equal(denominatorKindOf("renderer"), DenominatorKind.Source);
    assert.equal(denominatorKindOf("gateway"), DenominatorKind.Execution);
    assert.equal(
      branchChurnAllowancePct(
        unchanged(110),
        unchanged(100),
        "renderer",
        PROVEN_TREES
      ),
      0
    );
    assert.ok(
      branchChurnAllowancePct(
        unchanged(110),
        unchanged(100),
        "gateway",
        PROVEN_TREES
      ) > 0
    );
  });

  // Every case here supplies a PROVEN test tree, so the only gate that can be
  // withholding the allowance is the source-tree one this test names.
  test("an unproven or changed source tree earns no allowance", () => {
    assert.equal(
      branchChurnAllowancePct(
        { branchesTotal: 110, sourceHash: CHANGED_SOURCE },
        unchanged(100),
        "gateway",
        PROVEN_TREES
      ),
      0
    );
    assert.equal(
      branchChurnAllowancePct(
        { branchesTotal: 110 },
        unchanged(100),
        "gateway",
        PROVEN_TREES
      ),
      0
    );
    assert.equal(
      branchChurnAllowancePct(
        unchanged(110),
        { branchesTotal: 100 },
        "gateway",
        PROVEN_TREES
      ),
      0
    );
    assert.equal(
      branchChurnAllowancePct(
        unchanged(110),
        unchanged(100),
        undefined,
        PROVEN_TREES
      ),
      0
    );
  });

  // The gate Finding 1 was missing entirely. Production source is byte-
  // identical in every case below — only the TEST tree moved — so a gate that
  // fingerprints source alone hands out the allowance and calls a weakened
  // test harmless churn.
  test("an unproven or changed TEST tree earns no allowance", () => {
    assert.equal(
      branchChurnAllowancePct(unchanged(110), unchanged(100), "gateway", {
        currentTestTreeHash: CHANGED_TESTS,
        baseTestTreeHash: UNCHANGED_TESTS,
      }),
      0
    );
    assert.equal(
      branchChurnAllowancePct(unchanged(110), unchanged(100), "gateway", {
        currentTestTreeHash: UNCHANGED_TESTS,
      }),
      0
    );
    assert.equal(
      branchChurnAllowancePct(unchanged(110), unchanged(100), "gateway", {
        baseTestTreeHash: UNCHANGED_TESTS,
      }),
      0
    );
    assert.equal(
      branchChurnAllowancePct(unchanged(110), unchanged(100), "gateway", {}),
      0
    );
    assert.equal(
      branchChurnAllowancePct(unchanged(110), unchanged(100), "gateway"),
      0
    );
    // Same three numbers, both trees proven: the allowance is granted. Without
    // this line the four assertions above could pass on a gate that never
    // grants anything at all.
    assert.ok(
      branchChurnAllowancePct(
        unchanged(110),
        unchanged(100),
        "gateway",
        PROVEN_TREES
      ) > 0
    );
  });

  // Finding 2: the allowance is a RATIO, so an implausible base total turns it
  // into blanket amnesty. The formula was pinned; its magnitude never was.
  test("an implausible base total cannot buy more than the cap", () => {
    // Half the current total "churned" — arithmetically a 50pp allowance,
    // which would forgive any regression a partition can physically have.
    assert.equal(
      branchChurnAllowancePct(
        unchanged(3300),
        unchanged(1650),
        "gateway",
        PROVEN_TREES
      ),
      MAX_CHURN_ALLOWANCE_PCT
    );
    assert.equal(MAX_CHURN_ALLOWANCE_PCT, 1);
  });

  test("a real re-enumeration is far below the cap and is not clipped by it", () => {
    // The largest churn ever observed on an untouched tree: 3 entries of 3297.
    const observed = branchChurnAllowancePct(
      unchanged(3294),
      unchanged(3297),
      "gateway",
      PROVEN_TREES
    );
    assert.ok(observed < MAX_CHURN_ALLOWANCE_PCT);
    assert.equal(Number(observed.toFixed(2)), 0.09);
  });
});

// The scenario BOTH reviewers reached independently: 50/100 → 50/110 with file
// breadth unchanged is a 4.55pp dip against a 9.09pp arithmetic allowance. It is
// newly-written untested code whenever the partition's source moved, and a
// source-derived partition cannot re-enumerate at all — neither may pass.
describe("compareToBase — newly added uncovered branches", () => {
  const fifty = (overrides: Record<string, unknown>) => ({
    branchesCovered: 50,
    branchesTotal: 100,
    branchPct: 50,
    executedFiles: 12,
    sourceFiles: 12,
    sourceHash: UNCHANGED_SOURCE,
    ...overrides,
  });
  const widened = (overrides: Record<string, unknown>) =>
    fifty({ branchesTotal: 110, branchPct: 45.45, ...overrides });

  test("a widened renderer universe is a drop even with an unchanged tree", () => {
    const verdict = compareToBase({ renderer: widened({}) }, METHOD, {
      method: METHOD,
      partitions: { renderer: fifty({}) },
    });
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.deepEqual(verdict.drops, [
      { partition: "renderer", basePct: 50, currentPct: 45.45 },
    ]);
  });

  test("a widened node universe is a drop once the partition's source moved", () => {
    const verdict = compareToBase(
      { gateway: widened({ sourceHash: CHANGED_SOURCE }) },
      METHOD,
      { method: METHOD, partitions: { gateway: fifty({}) } }
    );
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.equal(verdict.drops[0]?.currentPct, 45.45);
  });

  test("a base that published no source fingerprint is compared strictly", () => {
    const verdict = compareToBase({ gateway: widened({}) }, METHOD, {
      method: METHOD,
      partitions: { gateway: fifty({ sourceHash: undefined }) },
    });
    assert.equal(verdict.outcome, CompareOutcome.Drop);
  });

  test("a corrupt base total cannot buy an allowance for the same dip", () => {
    const verdict = compareToBase({ gateway: widened({}) }, METHOD, {
      method: METHOD,
      partitions: { gateway: fifty({ branchesTotal: 0 }) },
    });
    assert.equal(verdict.outcome, CompareOutcome.Drop);
  });

  // Behaviour change (Finding 2): this same widening used to be classified as
  // churn on a proven-identical tree, because the raw arithmetic allowed 9.09pp.
  // A denominator that moved by 9% is two orders of magnitude past the largest
  // re-enumeration ever observed (0.09%), which is precisely the implausible
  // regime the cap exists to reject — so the shape now drops, and only a churn
  // of believable magnitude is still forgiven.
  test("a widening far past the cap is a drop even on a proven-identical tree", () => {
    const verdict = compareToBase(
      { gateway: widened({}) },
      METHOD,
      {
        method: METHOD,
        partitions: { gateway: fifty({}) },
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.equal(verdict.drops[0]?.currentPct, 45.45);
  });

  test("a believable re-enumeration over a proven-identical tree is still churn", () => {
    const verdict = compareToBase(
      {
        gateway: fifty({
          branchesTotal: 3294,
          branchPct: 67.27,
          branchesCovered: 2216,
        }),
      },
      METHOD,
      {
        method: METHOD,
        partitions: {
          gateway: fifty({
            branchesTotal: 3297,
            branchPct: 67.33,
            branchesCovered: 2220,
          }),
        },
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(verdict.outcome, CompareOutcome.Ok);
    assert.match(verdict.notes[0]?.reason ?? "", BRANCH_CHURN_NOTE_PATTERN);
  });
});

describe("classifyPartitionDelta", () => {
  const entry = (overrides: Record<string, unknown>) => ({
    branchPct: 50,
    branchesTotal: 100,
    executedFiles: 10,
    sourceFiles: 10,
    sourceHash: UNCHANGED_SOURCE,
    ...overrides,
  });

  test("reports breadth loss and the percentage move as separate facts", () => {
    const delta = classifyPartitionDelta(
      "gateway",
      entry({ branchPct: 60, executedFiles: 9 }),
      entry({})
    );
    assert.equal(delta.unreachedGrew, true);
    assert.equal(delta.baseUnreached, 0);
    assert.equal(delta.currentUnreached, 1);
    assert.equal(delta.pctKind, PartitionDeltaKind.AtOrAbove);
  });

  test("absent file counts are unknown breadth, not a breadth regression", () => {
    const delta = classifyPartitionDelta(
      "gateway",
      entry({ executedFiles: undefined }),
      entry({})
    );
    assert.equal(delta.currentUnreached, null);
    assert.equal(delta.unreachedGrew, false);
  });
});

// Finding 1 (BLOCKING). Both of these are REAL regressions — a test was
// weakened so that functions inside the partition stopped running, taking
// their branch entries out of the denominator with them. Production source is
// byte-identical, so a fingerprint that covers only the production tree proves
// nothing and the arithmetic bound forgives the whole dip.
describe("compareToBase — a weakened test on a byte-identical source tree", () => {
  const gatewayEntry = (overrides: Record<string, unknown>) => ({
    branchesCovered: 2220,
    branchesTotal: 3297,
    branchPct: 67.33,
    executedFiles: 84,
    sourceFiles: 84,
    sourceHash: UNCHANGED_SOURCE,
    ...overrides,
  });

  // File-level reach is unchanged in both cases — the files are still imported,
  // only some of their functions stopped running — so the unreached-remainder
  // check cannot see either of these. The test-tree fingerprint is what does.
  const regressions = [
    {
      name: "an 11.02pp collapse",
      base: gatewayEntry({}),
      current: gatewayEntry({
        branchesCovered: 1633,
        branchesTotal: 2900,
        branchPct: 56.31,
      }),
    },
    {
      name: "a 0.45pp erosion",
      base: gatewayEntry({ branchesTotal: 3310 }),
      current: gatewayEntry({
        branchesCovered: 2203,
        branchesTotal: 3294,
        branchPct: 66.88,
      }),
    },
  ];

  for (const regression of regressions) {
    test(`${regression.name} is a DROP once the test tree is part of the proof`, () => {
      const verdict = compareToBase(
        { gateway: regression.current },
        METHOD,
        {
          method: METHOD,
          partitions: { gateway: regression.base },
          testTreeHash: UNCHANGED_TESTS,
        },
        CHANGED_TESTS
      );
      assert.equal(verdict.outcome, CompareOutcome.Drop);
      assert.equal(verdict.drops[0]?.partition, "gateway");
    });

    test(`${regression.name} is exactly what a source-only proof let through`, () => {
      // The counterfactual, as an assertion rather than a claim: tell the gate
      // the test tree is unchanged — which is all a source-only fingerprint
      // could ever assert — and it grants an allowance that covers the whole
      // dip. Tell it the truth and it grants nothing.
      const dip = regression.base.branchPct - regression.current.branchPct;
      const asSourceOnlyProof = branchChurnAllowancePct(
        regression.current,
        regression.base,
        "gateway",
        PROVEN_TREES
      );
      const withTestTreeProof = branchChurnAllowancePct(
        regression.current,
        regression.base,
        "gateway",
        {
          currentTestTreeHash: CHANGED_TESTS,
          baseTestTreeHash: UNCHANGED_TESTS,
        }
      );
      assert.ok(dip > 0, "the regression must actually be a dip");
      assert.ok(
        asSourceOnlyProof > 0,
        "a source-only proof granted a non-zero allowance for this dip"
      );
      assert.equal(withTestTreeProof, 0);
    });
  }
});

// Finding 2 (HIGH). An implausible base total is blanket amnesty without a cap.
describe("compareToBase — the allowance has a ceiling", () => {
  const entry = (overrides: Record<string, unknown>) => ({
    branchesCovered: 2220,
    branchesTotal: 3300,
    branchPct: 67.33,
    executedFiles: 84,
    sourceFiles: 84,
    sourceHash: UNCHANGED_SOURCE,
    ...overrides,
  });

  test("a 49.99pp drop is a DROP even with both trees proven identical", () => {
    // base 1650 vs current 3300 is arithmetically a 50pp allowance. Every
    // provenance gate passes here — only the cap stands between this and a
    // pass, which is what makes it a test of the cap and nothing else.
    const verdict = compareToBase(
      { gateway: entry({ branchPct: 17.34 }) },
      METHOD,
      {
        method: METHOD,
        partitions: { gateway: entry({ branchesTotal: 1650 }) },
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.equal(verdict.drops[0]?.partition, "gateway");
  });

  test("a dip just over the cap drops while the cap itself is a note", () => {
    // Allowance is capped at exactly MAX_CHURN_ALLOWANCE_PCT here.
    const atCap = compareToBase(
      { gateway: entry({ branchPct: 66.33 }) },
      METHOD,
      {
        method: METHOD,
        partitions: { gateway: entry({ branchesTotal: 1650 }) },
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(atCap.outcome, CompareOutcome.Ok);
    assert.match(atCap.notes[0]?.reason ?? "", BRANCH_CHURN_NOTE_PATTERN);

    const overCap = compareToBase(
      { gateway: entry({ branchPct: 66.32 }) },
      METHOD,
      {
        method: METHOD,
        partitions: { gateway: entry({ branchesTotal: 1650 }) },
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(overCap.outcome, CompareOutcome.Drop);
  });

  test("a dip exactly equal to a sub-cap allowance is a note, not a drop", () => {
    // 2 entries of 400 is 0.50pp, below the cap, so the `<=` boundary itself is
    // what decides here.
    const boundaryBase = entry({ branchesTotal: 398 });
    const onTheLine = compareToBase(
      { gateway: entry({ branchesTotal: 400, branchPct: 66.83 }) },
      METHOD,
      {
        method: METHOD,
        partitions: { gateway: boundaryBase },
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(onTheLine.outcome, CompareOutcome.Ok);

    const justPast = compareToBase(
      { gateway: entry({ branchesTotal: 400, branchPct: 66.82 }) },
      METHOD,
      {
        method: METHOD,
        partitions: { gateway: boundaryBase },
        testTreeHash: UNCHANGED_TESTS,
      },
      UNCHANGED_TESTS
    );
    assert.equal(justPast.outcome, CompareOutcome.Drop);
  });
});

// Finding 7 (MEDIUM). A null remainder conflated "unknown breadth" with "did
// not grow", so an absent count read as a pass.
describe("compareToBase — unknown breadth refuses rather than passes", () => {
  const entry = (overrides: Record<string, unknown>) => ({
    branchesCovered: 50,
    branchesTotal: 100,
    branchPct: 50,
    executedFiles: 10,
    sourceFiles: 10,
    sourceHash: UNCHANGED_SOURCE,
    ...overrides,
  });

  test("a base that cannot report file reach is a drop, not a silent ok", () => {
    const verdict = compareToBase({ gateway: entry({}) }, METHOD, {
      method: METHOD,
      partitions: { gateway: entry({ executedFiles: undefined }) },
      testTreeHash: UNCHANGED_TESTS,
    });
    assert.equal(verdict.outcome, CompareOutcome.Drop);
    assert.ok(
      verdict.drops.some((drop) =>
        drop.reason?.includes("file reach is unknown")
      )
    );
  });

  test("a current run that cannot report file reach is a drop too", () => {
    const verdict = compareToBase(
      { gateway: entry({ sourceFiles: Number.NaN }) },
      METHOD,
      {
        method: METHOD,
        partitions: { gateway: entry({}) },
        testTreeHash: UNCHANGED_TESTS,
      }
    );
    assert.equal(verdict.outcome, CompareOutcome.Drop);
  });

  test("both sides reporting reach stays a pass", () => {
    const verdict = compareToBase({ gateway: entry({}) }, METHOD, {
      method: METHOD,
      partitions: { gateway: entry({}) },
      testTreeHash: UNCHANGED_TESTS,
    });
    assert.equal(verdict.outcome, CompareOutcome.Ok);
  });
});
