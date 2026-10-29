import { afterEach, describe, expect, it, vi } from "vitest";
import { KpiFormat } from "../../types/insights.ts";
import {
  computeDeliveryKpiResult,
  computeDeliveryKpis,
  type DeliveryKpi,
  type DeliveryKpis,
  validateDerivedReferencesBase,
} from "./compute.ts";
import { makePr, makeRows, makeSession } from "./fixtures.test-helpers.ts";
import { NormalizedPrState } from "./normalized-rows.ts";
import { prPopulations, sessionPopulations } from "./populations.ts";
import type { DeliveryKpiDefinition } from "./registry.ts";
import { DELIVERY_KPI_REGISTRY, DeliveryKpiKey } from "./registry.ts";

const DERIVED_REF_RE = /references derived KPI/;

/**
 * Fetches a public KPI, asserting it is present. Since `DeliveryKpis` is a
 * `Partial<Record<...>>` (internal keys are omitted at runtime), this both
 * type-narrows away `undefined` and fails loudly if a key expected to be public
 * is missing.
 */
function getKpi(kpis: DeliveryKpis, key: DeliveryKpiKey): DeliveryKpi {
  const found = kpis[key];
  if (found === undefined) {
    throw new Error(`Expected public KPI "${key}" to be present`);
  }
  return found;
}

describe("computeDeliveryKpis — merge rate (decided denominator)", () => {
  it("merge rate = merged / (merged + closed) as a percent", () => {
    // 3 merged, 1 closed → 3/4 = 75%. Open PRs must NOT enter the denominator.
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 100,
        }),
        makePr({ state: NormalizedPrState.Open, mergedAt: null }),
      ],
    });
    const kpis = computeDeliveryKpis(rows);
    expect(getKpi(kpis, DeliveryKpiKey.MergeRate).value).toBe(75);
  });

  it("merge rate is unavailable (null) when no PRs are decided", () => {
    const rows = makeRows({
      prs: [makePr({ state: NormalizedPrState.Open, mergedAt: null })],
    });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.MergeRate).value
    ).toBeNull();
  });
});

describe("computeDeliveryKpis — PR size (median, enriched-only)", () => {
  // PRD-522 R4.1 mutation-sanity guard: dropping `onlyEnriched` from PrSize would
  // fold the un-enriched 999-line row into the median (→ 160), so pinning it to 20
  // fails if the enriched-only filter regresses.
  it("uses the MEDIAN not the mean, over enriched merged PRs only", () => {
    // enriched line-totals: 10, 20, 300 → median 20 (mean would be 110).
    // The un-enriched 999-line row must be excluded.
    const rows = makeRows({
      prs: [
        makePr({ additions: 10, deletions: 0, enriched: true }),
        makePr({ additions: 20, deletions: 0, enriched: true }),
        makePr({ additions: 300, deletions: 0, enriched: true }),
        makePr({ additions: 999, deletions: 0, enriched: false }),
      ],
    });
    expect(getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.PrSize).value).toBe(
      20
    );
  });

  it("is unavailable when no enriched merged PRs exist", () => {
    const rows = makeRows({
      prs: [makePr({ enriched: false })],
    });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.PrSize).value
    ).toBeNull();
  });
});

describe("computeDeliveryKpis — merged volume (sum gross lines)", () => {
  // ISS-8184 ruling 4: this base sums raw lines rather than thousands-at-1dp,
  // so every expectation here is the raw line sum. The compensating `scale` on
  // `MergedLocPerDollar` went with the old divide-by-1000; that ratio's value is
  // unchanged and is pinned by its own counterfactual below.
  it("sums gross lines over merged PRs, unscaled", () => {
    // (500+250) + (300+0) = 1050, where this used to read 1.1
    const rows = makeRows({
      prs: [
        makePr({ additions: 500, deletions: 250 }),
        makePr({ additions: 300, deletions: 0 }),
      ],
    });
    expect(getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.Loc).value).toBe(
      1050
    );
  });

  it("counts un-enriched merged PRs too (the sum is not enriched-gated)", () => {
    const rows = makeRows({
      prs: [makePr({ additions: 1000, deletions: 0, enriched: false })],
    });
    expect(getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.Loc).value).toBe(
      1000
    );
  });
});

describe("computeDeliveryKpis — cost and derived cost/tokens", () => {
  it("cost sums session cost, rounded to 2 dp", () => {
    const rows = makeRows({
      sessions: [
        makeSession({ costUsd: 1.234 }),
        makeSession({ costUsd: 2.0 }),
      ],
    });
    expect(getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.Cost).value).toBe(
      3.23
    );
  });

  it("cost per merged PR = cost ÷ merged count", () => {
    const rows = makeRows({
      prs: [makePr({ mergedAt: 100 }), makePr({ mergedAt: 100 })],
      sessions: [makeSession({ costUsd: 10 })],
    });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.CostPerMergedPr).value
    ).toBe(5);
  });

  it("cost per merged PR is unavailable with zero merged PRs", () => {
    const rows = makeRows({ sessions: [makeSession({ costUsd: 10 })] });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.CostPerMergedPr).value
    ).toBeNull();
  });

  it("tokens per LOC = total tokens ÷ merged lines", () => {
    // ISS-8184 rulings 4+5: the base carries raw lines, so 1000 lines and 5000
    // tokens read 5 tokens per line where this pinned 5000 per thousand. The 1000x
    // drop is the ruling.
    const rows = makeRows({
      prs: [makePr({ additions: 1000, deletions: 0 })],
      sessions: [makeSession({ tokens: 5000 })],
    });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.TokensPerLoc).value
    ).toBe(5);
  });

  it("a ratio divides the RAW base, not the display-rounded one", () => {
    // The engine contract this file has always pinned, retargeted by ISS-8184
    // ruling 4. It used to ride the thousands base, whose `round: 1` collapsed
    // 0.04 to 0.0 —
    // but a raw line count is an integer, so `round: 0` no longer rounds
    // anything and that base can no longer demonstrate it. `Cost` still can:
    // `round: 2` displays a sub-cent total as 0.00, and a ratio dividing THAT
    // would blow up instead of returning a real number.
    const rows = makeRows({
      prs: [makePr({ additions: 40, deletions: 0 })],
      sessions: [makeSession({ costUsd: 0.004, tokens: 8000 })],
    });
    const kpis = computeDeliveryKpis(rows);

    expect(getKpi(kpis, DeliveryKpiKey.Cost).value).toBe(0);
    // 40 lines ÷ $0.004 = 10,000 — computed off the raw cost, not the shown 0.
    expect(getKpi(kpis, DeliveryKpiKey.MergedLocPerDollar).value).toBe(10_000);
    // And the raw-line base displays its integer unrounded.
    expect(getKpi(kpis, DeliveryKpiKey.Loc).value).toBe(40);
    expect(getKpi(kpis, DeliveryKpiKey.TokensPerLoc).value).toBe(200);
  });

  it("ISS-8184 ruling 4: dropping the transform AND the scale leaves LOC/$ unmoved", () => {
    // The counterfactual the ruling requires. Before: base = lines/1000, then
    // `scale: LINES_PER_KLOC_SCALE` multiplied the thousands back. After:
    // neither. The two cancelled, so this value is byte-for-byte what ISS-4667
    // shipped — 3,000 gross lines over $2.00 is 1,500 LOC/$ either way. A test
    // that only checked the new LABELS would not catch a broken cancellation.
    const rows = makeRows({
      prs: [makePr({ additions: 2000, deletions: 1000 })],
      sessions: [makeSession({ costUsd: 2 })],
    });
    const kpis = computeDeliveryKpis(rows);

    expect(getKpi(kpis, DeliveryKpiKey.MergedLocPerDollar).value).toBe(1500);
    // The base it divides is now raw lines, which is the half that changed.
    expect(getKpi(kpis, DeliveryKpiKey.Loc).value).toBe(3000);
  });
});

describe("computeDeliveryKpis — time to merge (median latency)", () => {
  it("medians mergedAt − createdAt over merged PRs", () => {
    const rows = makeRows({
      prs: [
        makePr({ createdAt: 0, mergedAt: 100 }),
        makePr({ createdAt: 0, mergedAt: 300 }),
        makePr({ createdAt: 0, mergedAt: 500 }),
      ],
    });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.TimeToMerge).value
    ).toBe(300);
  });

  it("excludes a clock-skewed negative interval from the median", () => {
    // The third PR merged before its recorded creation (clock skew). Its
    // negative latency must NOT fold into the distribution — the median is over
    // {100, 300} → 200, not over {100, 300, -400} → 100.
    const rows = makeRows({
      prs: [
        makePr({ createdAt: 0, mergedAt: 100 }),
        makePr({ createdAt: 0, mergedAt: 300 }),
        makePr({ createdAt: 500, mergedAt: 100 }),
      ],
    });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.TimeToMerge).value
    ).toBe(200);
  });
});

describe("computeDeliveryKpis — counts", () => {
  it("emits named counts, with count=0 (not null) for empty PR cohorts", () => {
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({
          state: NormalizedPrState.Open,
          mergedAt: null,
          observedAt: 100,
        }),
      ],
      sessions: [makeSession(), makeSession()],
    });
    const kpis = computeDeliveryKpis(rows);
    expect(getKpi(kpis, DeliveryKpiKey.MergedCount).value).toBe(1);
    expect(getKpi(kpis, DeliveryKpiKey.ActivePrCount).value).toBe(1);
    expect(getKpi(kpis, DeliveryKpiKey.ReviewBacklog).value).toBe(1);
    expect(getKpi(kpis, DeliveryKpiKey.CapturedPrCount).value).toBe(2);
    expect(getKpi(kpis, DeliveryKpiKey.SessionsCount).value).toBe(2);
  });

  it("counts are 0 on fully empty rows", () => {
    const kpis = computeDeliveryKpis(makeRows());
    expect(getKpi(kpis, DeliveryKpiKey.MergedCount).value).toBe(0);
    expect(getKpi(kpis, DeliveryKpiKey.CapturedPrCount).value).toBe(0);
  });
});

describe("computeDeliveryKpis — result shape & metadata", () => {
  it("attaches label, help, and format to every public KPI", () => {
    const loc = getKpi(computeDeliveryKpis(makeRows()), DeliveryKpiKey.Loc);
    expect(loc.label).toBe("Merged LOC");
    expect(typeof loc.help).toBe("string");
    expect(loc.format).toBe("number");
  });

  it("excludes internal building-block KPIs from the result", () => {
    const kpis = computeDeliveryKpis(makeRows());
    expect(kpis[DeliveryKpiKey.DecidedCount]).toBeUndefined();
    expect(kpis[DeliveryKpiKey.SessionTokensTotal]).toBeUndefined();
  });

  it("empty sum-based KPIs (cost, loc) are unavailable/null, not 0", () => {
    const kpis = computeDeliveryKpis(makeRows());
    expect(getKpi(kpis, DeliveryKpiKey.Cost).value).toBeNull();
    expect(getKpi(kpis, DeliveryKpiKey.Loc).value).toBeNull();
  });
});

describe("computeDeliveryKpiResult — internal-inclusive values", () => {
  it("omits internal KPIs from the public map but retains them in values", () => {
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 100,
        }),
      ],
      sessions: [makeSession({ tokens: 4000 })],
    });
    const { kpis, values } = computeDeliveryKpiResult(rows);

    // Internal keys are absent from the public map (the honest-type behavior)...
    expect(kpis[DeliveryKpiKey.DecidedCount]).toBeUndefined();
    expect(kpis[DeliveryKpiKey.SessionTokensTotal]).toBeUndefined();

    // ...but their raw values are retained for parity checks.
    expect(values.get(DeliveryKpiKey.DecidedCount)).toBe(2);
    expect(values.get(DeliveryKpiKey.SessionTokensTotal)).toBe(4000);
    // Public KPIs are present in both.
    expect(values.get(DeliveryKpiKey.MergedCount)).toBe(1);
  });
});

describe("computeDeliveryKpiResult — population memoization (FEA-2978)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters each population exactly once per pass, no matter how many KPIs reference it", () => {
    // mergedPrs feeds 4 KPIs (MergedCount, PrSize, TimeToMerge, Loc) AND the
    // decidedPrs arm; closedPrs feeds the other decidedPrs arm; sessions feeds 3
    // KPIs (SessionsCount, Cost, SessionTokensTotal). Before memoization these
    // re-scanned their source rows once per referencing KPI; now each underlying
    // population selector runs exactly once for the whole compute pass.
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 100,
        }),
      ],
      sessions: [makeSession(), makeSession()],
    });
    const mergedSpy = vi.spyOn(prPopulations, "mergedPrs");
    const closedSpy = vi.spyOn(prPopulations, "closedPrs");
    const sessionsSpy = vi.spyOn(sessionPopulations, "sessions");

    computeDeliveryKpiResult(rows);

    expect(mergedSpy).toHaveBeenCalledTimes(1);
    expect(closedSpy).toHaveBeenCalledTimes(1);
    expect(sessionsSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves the decided union (merged ∪ closed) while reusing memoized arms", () => {
    // Reusing the cached mergedPrs/closedPrs arms must not change decidedPrs's
    // result: 2 merged + 1 closed → DecidedCount 3.
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 100,
        }),
        makePr({ state: NormalizedPrState.Open, mergedAt: null }),
      ],
    });
    expect(
      computeDeliveryKpiResult(rows).values.get(DeliveryKpiKey.DecidedCount)
    ).toBe(3);
  });
});

describe("validateDerivedReferencesBase — derived-of-derived guard", () => {
  it("passes for the real registry (all derived reference base KPIs)", () => {
    expect(() =>
      validateDerivedReferencesBase(DELIVERY_KPI_REGISTRY)
    ).not.toThrow();
  });

  it("throws when a derived KPI references another derived KPI", () => {
    // MergeRate (derived) referencing CostPerMergedPr (also derived) is the
    // exact latent hazard the guard exists to catch.
    const badRegistry: DeliveryKpiDefinition[] = [
      {
        key: DeliveryKpiKey.CostPerMergedPr,
        source: "derived",
        derived: {
          numeratorKpi: DeliveryKpiKey.Cost,
          denominatorKpi: DeliveryKpiKey.MergedCount,
        },
        label: "Cost per merged PR",
        help: "",
        format: KpiFormat.Currency,
      },
      {
        key: DeliveryKpiKey.MergeRate,
        source: "derived",
        derived: {
          numeratorKpi: DeliveryKpiKey.MergedCount,
          // ← references a DERIVED KPI, which is illegal.
          denominatorKpi: DeliveryKpiKey.CostPerMergedPr,
        },
        label: "Merge rate",
        help: "",
        format: KpiFormat.Percent,
      },
    ];
    expect(() => validateDerivedReferencesBase(badRegistry)).toThrow(
      DERIVED_REF_RE
    );
  });

  it("computeDeliveryKpis runs the guard (real registry stays valid)", () => {
    expect(() => computeDeliveryKpis(makeRows())).not.toThrow();
  });
});
