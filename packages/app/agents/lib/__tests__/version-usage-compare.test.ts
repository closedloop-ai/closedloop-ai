/**
 * ISS-10468 — the side-by-side compare's delta derivation.
 *
 * WHAT THESE CASES EXIST TO STOP, in one sentence: this repo has twice shipped a
 * comparison that refused to compare. `buildBranchMetricComparison` returned an
 * unavailable delta whenever EITHER side was partial — on real data, every
 * non-count Branches metric — and #7017 then deleted the comparison slot from
 * every card in every window rather than fix that one gate.
 *
 * So the axis every case below is built around is the FIVE states a reader acts
 * on differently, each pinned so that collapsing any two fails at least one case:
 *
 *   1. a computed delta,
 *   2. a GENUINE ZERO delta ("No change" — a measurement, not an absence),
 *   3. an APPROXIMATE delta over a bounded operand (published WITH its shortfall,
 *      never withheld),
 *   4. NOT COMPARABLE because a named operand is genuinely absent,
 *   5. only one revision exists, so there is no second operand at all.
 *
 * (5) is the panel's, since it is a fact about the version history rather than
 * about two entries; {@link defaultCompareBaselineHash} is its derivation and is
 * pinned here.
 *
 * Every expected figure is a literal written out by hand. Re-deriving one with
 * `candidate - baseline` would make the case agree with the code by construction
 * and pass under any arithmetic the code happened to perform.
 */

import {
  AgentComponentKind,
  type ComponentVersion,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentVersionUsage } from "@repo/api/src/types/agent-component-version-usage";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
import { EMPTY_VERSION_SPEND } from "@repo/api/src/utils/version-spend";
import {
  DeltaSentiment,
  MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import { describe, expect, it } from "vitest";
import {
  defaultCompareBaselineHash,
  VERSION_COMPARE_BOUNDED_CAVEAT,
  VERSION_COMPARE_NO_CHANGE_LABEL,
  VersionCompareDeltaState,
  VersionCompareDirection,
  versionCompareRows,
} from "../version-usage-compare";
import { versionUsageMetrics } from "../version-usage-view";

const CURRENT_HASH = "aaaaaaaa1111";
const MIDDLE_HASH = "bbbbbbbb2222";
const OLDEST_HASH = "cccccccc3333";

function entry(
  overrides: Partial<AgentComponentVersionUsage>
): AgentComponentVersionUsage {
  return {
    hash: CURRENT_HASH,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    truncated: false,
    ...EMPTY_COHORT_DELIVERY_METRICS,
    ...EMPTY_VERSION_SPEND,
    ...overrides,
  };
}

/**
 * Two revisions whose deltas differ IN SIGN across the rows — up, down, and flat
 * in one fixture. A pair moving one way on every metric would let a sign error,
 * a swapped operand order, or a magnitude-only delta pass.
 */
const BASELINE = entry({
  hash: OLDEST_HASH,
  invocations: 40,
  sessions: 10,
  mergedPrs: 4,
  locPerDollar: 10,
  totalTokens: 1000,
  estimatedCostUsd: 20,
});
const CANDIDATE = entry({
  hash: CURRENT_HASH,
  invocations: 50,
  sessions: 8,
  mergedPrs: 4,
  locPerDollar: 12,
  totalTokens: 2500,
  estimatedCostUsd: 25,
});

/** `subagent` is the kind whose LOC/$ attribution is verifiable, so the row shows. */
const KIND = AgentComponentKind.Subagent;

function rowsFor(
  baseline: AgentComponentVersionUsage | undefined,
  candidate: AgentComponentVersionUsage | undefined
) {
  return versionCompareRows(KIND, baseline, candidate);
}

function rowByKey(
  baseline: AgentComponentVersionUsage | undefined,
  candidate: AgentComponentVersionUsage | undefined,
  key: string
) {
  const row = rowsFor(baseline, candidate).find((r) => r.key === key);
  if (!row) {
    throw new Error(`no compare row for ${key}`);
  }
  return row;
}

function revision(hash: string, isCurrent: boolean): ComponentVersion {
  return {
    hash,
    source: "",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent,
    content: `Body of ${hash}.`,
  };
}

describe("versionCompareRows — a computed delta", () => {
  it("states the change, its direction and its percent for a RISING metric", () => {
    const row = rowByKey(BASELINE, CANDIDATE, "invocations");

    expect(row.delta.state).toBe(VersionCompareDeltaState.Computed);
    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("expected a computed delta");
    }
    // Hand-written literals: 40 → 50.
    expect(row.delta.change).toBe(10);
    expect(row.delta.direction).toBe(VersionCompareDirection.Up);
    expect(row.delta.magnitude).toBe("10");
    expect(row.delta.percent).toBe("+25%");
    // A volume row asserts no verdict: "this revision ran more" is not "better"
    // without an exposure denominator this panel does not compute.
    expect(row.delta.sentiment).toBe(DeltaSentiment.Neutral);
    expect(row.delta.verdict).toBeNull();
    expect(row.delta.disclosure).toBeNull();
  });

  it("states a FALLING metric as down, with an unsigned magnitude", () => {
    const row = rowByKey(BASELINE, CANDIDATE, "sessions");

    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("expected a computed delta");
    }
    // 10 → 8. The sign travels as the direction, so the magnitude is unsigned;
    // a magnitude of "-2" here would double-state it against the glyph.
    expect(row.delta.change).toBe(-2);
    expect(row.delta.direction).toBe(VersionCompareDirection.Down);
    expect(row.delta.magnitude).toBe("2");
    expect(row.delta.percent).toBe("-20%");
  });

  it("scores LOC / $ — the one row with a good direction — and names the verdict", () => {
    const row = rowByKey(BASELINE, CANDIDATE, "loc-per-dollar");

    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("expected a computed delta");
    }
    // 10 → 12 lines per dollar.
    expect(row.delta.change).toBe(2);
    expect(row.delta.sentiment).toBe(DeltaSentiment.Improvement);
    // The verdict is a WORD, not a hue: WCAG 2.2 SC 1.4.1. A `null` here would
    // leave the good/bad reading to colour alone.
    expect(row.delta.verdict).toBe("better");
    expect(row.delta.percent).toBe("+20%");
  });

  it("formats each row's magnitude in that row's OWN unit", () => {
    // 1,000 → 2,500 tokens, and $20 → $25. A single count formatter for every
    // row would print "1500" and "5" here.
    expect(rowByKey(BASELINE, CANDIDATE, "total-tokens").delta).toMatchObject({
      magnitude: "1.50k",
    });
    expect(rowByKey(BASELINE, CANDIDATE, "estimated-cost").delta).toMatchObject(
      { magnitude: "$5.00" }
    );
  });

  it("carries BOTH revisions' own figures beside the change", () => {
    const row = rowByKey(BASELINE, CANDIDATE, "invocations");

    expect(row.baseline).toEqual({ value: "40", measured: true });
    expect(row.candidate).toEqual({ value: "50", measured: true });
  });
});

describe("versionCompareRows — a genuine ZERO delta", () => {
  it("reads as No change, and is not the no-comparison state", () => {
    // 4 → 4 merged PRs: measured on both sides and identical.
    const row = rowByKey(BASELINE, CANDIDATE, "merged-prs");

    expect(row.delta.state).toBe(VersionCompareDeltaState.Computed);
    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("a flat delta is a measurement, not an absence");
    }
    expect(row.delta.change).toBe(0);
    expect(row.delta.direction).toBe(VersionCompareDirection.Unchanged);
    expect(row.delta.magnitude).toBe(VERSION_COMPARE_NO_CHANGE_LABEL);
    expect(row.delta.percent).toBe("0%");
    // Flat is never a verdict, whatever the polarity.
    expect(row.delta.sentiment).toBe(DeltaSentiment.Neutral);
  });
});

describe("versionCompareRows — the delta reconciles with the two cells beside it", () => {
  it("reads as No change when both columns render the same figure, and drops the percent", () => {
    // The fold is keyed on the cells' OWN rendered strings, so it tracks whatever
    // precision the column publishes. At the column's cents precision $20.401 and
    // $20.403 both render "$20.40", and a raw 0.002 change would otherwise print
    // a direction beside two IDENTICAL cells (tamsinb). Literal figures, chosen
    // so the raw change is genuinely non-zero and the two rendered strings are
    // genuinely equal.
    const baseline = entry({ hash: OLDEST_HASH, estimatedCostUsd: 20.401 });
    const candidate = entry({ hash: CURRENT_HASH, estimatedCostUsd: 20.403 });
    const row = rowByKey(baseline, candidate, "estimated-cost");

    expect(row.baseline.value).toBe("$20.40");
    expect(row.candidate.value).toBe("$20.40");
    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("two measured figures are comparable");
    }
    expect(row.delta.change).toBe(0);
    expect(row.delta.direction).toBe(VersionCompareDirection.Unchanged);
    expect(row.delta.magnitude).toBe(VERSION_COMPARE_NO_CHANGE_LABEL);
    // The percent is what would contradict "No change" hardest, so it goes.
    expect(row.delta.percent).toBeNull();
  });

  it("still states a direction when the two columns render DIFFERENTLY", () => {
    // The fold is keyed on the rendered strings, so a pair that rounds to two
    // different cells keeps its delta. Without this case the fold could swallow
    // every cost delta and the case above would still pass.
    const baseline = entry({ hash: OLDEST_HASH, estimatedCostUsd: 20 });
    const candidate = entry({ hash: CURRENT_HASH, estimatedCostUsd: 25 });
    const row = rowByKey(baseline, candidate, "estimated-cost");

    expect(row.baseline.value).toBe("$20.00");
    expect(row.candidate.value).toBe("$25.00");
    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("two measured figures are comparable");
    }
    expect(row.delta.change).toBe(5);
    expect(row.delta.direction).toBe(VersionCompareDirection.Up);
    expect(row.delta.percent).toBe("+25%");
  });

  it("states a SUB-DOLLAR cost change the cells now show, instead of two cells a dollar apart", () => {
    // Operator ruling, marisolashgrove 2026-10-01 answering this PR's own alert item
    // 2b: "raise cost column's precision". The exact figures the alert named:
    // $20.40 and $20.60 rendered "$20" and "$21" at whole-dollar precision — two
    // cells a DOLLAR apart under a change of twenty cents — and the equal-cells
    // fold could not reach them because the strings differed. The fix is the
    // column's precision, so this case pins the cells and the change together: a
    // reader subtracting the two cells lands on the magnitude beside them.
    const baseline = entry({ hash: OLDEST_HASH, estimatedCostUsd: 20.4 });
    const candidate = entry({ hash: CURRENT_HASH, estimatedCostUsd: 20.6 });
    const row = rowByKey(baseline, candidate, "estimated-cost");

    expect(row.baseline.value).toBe("$20.40");
    expect(row.candidate.value).toBe("$20.60");
    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("two measured figures are comparable");
    }
    expect(row.delta.direction).toBe(VersionCompareDirection.Up);
    // $20.60 − $20.40 = $0.20, which is what the two cells above state.
    expect(row.delta.magnitude).toBe("$0.20");
    // Not folded flat: the cells differ, so the percent stands.
    expect(row.delta.percent).not.toBeNull();
  });
});

describe("versionCompareRows — a BOUNDED operand", () => {
  it("publishes the delta and discloses the shortfall, rather than withholding it", () => {
    // The exact shape #7017 refused to compare: one side's counts are a FLOOR.
    const bounded = entry({ ...CANDIDATE, truncated: true });
    const row = rowByKey(BASELINE, bounded, "invocations");

    expect(row.delta.state).toBe(VersionCompareDeltaState.Approximate);
    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("a bounded operand must not withhold the delta");
    }
    // The FIGURE survives the bound — that is the whole point.
    expect(row.delta.change).toBe(10);
    expect(row.delta.magnitude).toBe("10");
    expect(row.delta.disclosure).toBe(VERSION_COMPARE_BOUNDED_CAVEAT);
  });

  it("marks only the rows the bound actually reaches", () => {
    // `truncated` covers invocations and sessions; the cost row's own coverage
    // flag is `estimatedCostPartial`, so a blanket "this table is approximate"
    // would mislabel a row nothing bounded.
    const bounded = entry({ ...CANDIDATE, truncated: true });

    expect(rowByKey(BASELINE, bounded, "sessions").delta.state).toBe(
      VersionCompareDeltaState.Approximate
    );
    expect(rowByKey(BASELINE, bounded, "estimated-cost").delta.state).toBe(
      VersionCompareDeltaState.Computed
    );
  });

  it("marks the LOC / $ change approximate when its COHORT was capped", () => {
    // The ratio's own value carries no floor marker — a ratio over a sample can
    // land either side of the truth, so a `+` would claim a direction nobody
    // measured. The CHANGE between two such ratios is still inexact, and the
    // row's `bounded: false` once left it reading as an exact figure carrying a
    // full better/worse verdict (codex, thread on version-usage-view.ts:156).
    // Read from `mergedPrsTruncated`, the same flag `sampledLocPerDollarCaveat`
    // gates its sentence on, so the table and the prose beneath it agree.
    const sampled = entry({ ...CANDIDATE, mergedPrsTruncated: true });
    const row = rowByKey(BASELINE, sampled, "loc-per-dollar");

    expect(row.delta.state).toBe(VersionCompareDeltaState.Approximate);
    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("a sampled cohort must not withhold the ratio's delta");
    }
    // PUBLISHED, not withheld: 10 → 12 lines per dollar is still the change.
    expect(row.delta.change).toBe(2);
    expect(row.delta.disclosure).toBe(VERSION_COMPARE_BOUNDED_CAVEAT);
  });

  it("leaves the LOC / $ change EXACT when the cohort was whole", () => {
    // The counterfactual to the case above: a declared whole cohort must not
    // inherit the marker, or every ratio delta reads as approximate and the
    // distinction the row exists to make is gone.
    const whole = entry({ ...CANDIDATE, mergedPrsTruncated: false });

    expect(rowByKey(BASELINE, whole, "loc-per-dollar").delta.state).toBe(
      VersionCompareDeltaState.Computed
    );
  });

  it("reads each spend row's OWN partial flag", () => {
    const partialCost = entry({ ...CANDIDATE, estimatedCostPartial: true });

    expect(rowByKey(BASELINE, partialCost, "estimated-cost").delta.state).toBe(
      VersionCompareDeltaState.Approximate
    );
    expect(rowByKey(BASELINE, partialCost, "total-tokens").delta.state).toBe(
      VersionCompareDeltaState.Computed
    );
  });
});

describe("versionCompareRows — an ABSENT operand", () => {
  it("names WHICH side is missing instead of dashing the slot", () => {
    const noCost = entry({ ...CANDIDATE, estimatedCostUsd: null });
    const row = rowByKey(BASELINE, noCost, "estimated-cost");

    expect(row.delta.state).toBe(VersionCompareDeltaState.Incomparable);
    if (row.delta.state !== VersionCompareDeltaState.Incomparable) {
      throw new Error("expected the incomparable state");
    }
    expect(row.delta.reason).toContain("This revision has no measured");
    expect(row.delta.reason).toContain(row.label);
    // Operator ruling, marisolashgrove 2026-10-01: "Ruling 3, use 'other' instead of
    // 'older'". The side this names is the OTHER revision, and the age claim must
    // not come back — the baseline is the adjacent revision, which the
    // newer-neighbour fallback and the free selector both make not-necessarily
    // older. This spec deliberately polices the word, so it holds the word.
    expect(row.delta.reason).toContain("the other one");
    expect(row.delta.reason).not.toContain("older");
  });

  it("names the OTHER side when that is the missing one", () => {
    const noCost = entry({ ...BASELINE, estimatedCostUsd: null });
    const row = rowByKey(noCost, CANDIDATE, "estimated-cost");

    if (row.delta.state !== VersionCompareDeltaState.Incomparable) {
      throw new Error("expected the incomparable state");
    }
    expect(row.delta.reason).toContain("The other revision has no measured");
    // Same ruling, the mirror branch. Without the negative assertion, restoring
    // "The older revision has no measured" would still satisfy a looser
    // `toContain("revision has no measured")`.
    expect(row.delta.reason).not.toContain("older");
  });

  it("still renders every OTHER row's delta — one absence is not a table-wide refusal", () => {
    const noCost = entry({ ...CANDIDATE, estimatedCostUsd: null });

    expect(rowByKey(BASELINE, noCost, "invocations").delta.state).toBe(
      VersionCompareDeltaState.Computed
    );
    // And the columns keep their own figures: the compare withholds a delta it
    // cannot compute, never a value it holds.
    expect(rowByKey(BASELINE, noCost, "estimated-cost").baseline).toEqual({
      value: "$20.00",
      measured: true,
    });
  });

  it("distinguishes a NOT-COMPUTED figure from a measured zero on both sides", () => {
    const zero = entry({ ...CANDIDATE, invocations: 0 });
    const absent = entry({ ...CANDIDATE, invocations: null });

    // A measured zero compares: 40 → 0 is a real -40.
    const zeroRow = rowByKey(BASELINE, zero, "invocations");
    expect(zeroRow.candidate.value).toBe("0");
    expect(zeroRow.delta.state).toBe(VersionCompareDeltaState.Computed);

    // A not-computed figure dashes and cannot be compared. Collapsing the two
    // states fails exactly one of these two assertions, whichever way round.
    const absentRow = rowByKey(BASELINE, absent, "invocations");
    expect(absentRow.candidate.value).toBe("—");
    expect(absentRow.delta.state).toBe(VersionCompareDeltaState.Incomparable);
  });

  it("reports both sides absent as such when no entry has arrived at all", () => {
    for (const row of rowsFor(undefined, undefined)) {
      expect(row.delta.state).toBe(VersionCompareDeltaState.Incomparable);
      if (row.delta.state !== VersionCompareDeltaState.Incomparable) {
        throw new Error("unreachable");
      }
      expect(row.delta.reason).toContain("Neither revision has a measured");
    }
  });
});

describe("versionCompareRows — the percent is EXTRA, never the comparison", () => {
  it("keeps the absolute change when pctDelta declines a near-zero baseline", () => {
    const fromZero = entry({ ...BASELINE, invocations: 0 });
    const row = rowByKey(fromZero, CANDIDATE, "invocations");

    if (row.delta.state === VersionCompareDeltaState.Incomparable) {
      throw new Error("a zero baseline is still a baseline for a difference");
    }
    // 0 → 50 supports no percentage — `pctDelta` declines a near-zero base
    // rather than asserting a ratio — and the +50 is still a real change. A
    // percent-only delta would report "no comparison" over two measured figures.
    expect(row.delta.percent).toBeNull();
    expect(row.delta.change).toBe(50);
    expect(row.delta.magnitude).toBe("50");
  });
});

describe("versionUsageMetrics — the row descriptors the compare divides", () => {
  it("declares a good direction for LOC / $ and for nothing else", () => {
    const rows = versionUsageMetrics(KIND, CANDIDATE);
    const scored = rows
      .filter((row) => row.polarity !== MetricPolarity.Neutral)
      .map((row) => row.key);

    // A volume row acquiring a polarity would start grading "this revision ran
    // more" as better or worse, which is a ranking nobody specified.
    expect(scored).toEqual(["loc-per-dollar"]);
  });

  it("carries the raw figure the compare subtracts, normalized to number | null", () => {
    const rows = versionUsageMetrics(KIND, entry({ invocations: 0 }));
    const invocations = rows.find((row) => row.key === "invocations");

    // A measured zero is a number here, not an absence: that is what makes the
    // zero/not-computed distinction survive into the delta.
    expect(invocations?.raw).toBe(0);
    expect(rows.find((row) => row.key === "sessions")?.raw).toBeNull();
  });
});

describe("defaultCompareBaselineHash — the second operand's default", () => {
  const options = [
    revision(CURRENT_HASH, true),
    revision(MIDDLE_HASH, false),
    revision(OLDEST_HASH, false),
  ];

  it("defaults to the revision immediately OLDER than the selection", () => {
    // History arrives newest-first, so "the last one" is the next index up —
    // which is the revision the ticket's own question asks about.
    expect(defaultCompareBaselineHash(options, CURRENT_HASH)).toBe(MIDDLE_HASH);
  });

  it("falls back to the newer neighbour when the selection is the oldest", () => {
    expect(defaultCompareBaselineHash(options, OLDEST_HASH)).toBe(MIDDLE_HASH);
  });

  it("has no second operand when the history holds one revision", () => {
    // State (5): not comparable because nothing else exists. This is the ONE
    // honest reason to offer no comparison at all, and the panel reads it here.
    expect(
      defaultCompareBaselineHash([revision(CURRENT_HASH, true)], CURRENT_HASH)
    ).toBeNull();
  });

  it("has no second operand when nothing is selected", () => {
    expect(defaultCompareBaselineHash(options, null)).toBeNull();
  });
});
