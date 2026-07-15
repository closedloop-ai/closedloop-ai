import { afterEach, describe, expect, it, vi } from "vitest";
import { KpiFormat } from "../../types/insights.ts";
import {
  applyTransform,
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
import {
  DELIVERY_KPI_REGISTRY,
  DeliveryKpiKey,
  KpiTransform,
} from "./registry.ts";

const UNHANDLED_TRANSFORM_RE = /Unhandled KPI transform/;
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

describe("computeDeliveryKpis — KLOC (sum gross / 1000, round 1)", () => {
  it("sums gross lines over merged PRs and divides by 1000, rounded to 1 dp", () => {
    // (500+250) + (300+0) = 1050 → 1.05 → round1 → 1.1
    const rows = makeRows({
      prs: [
        makePr({ additions: 500, deletions: 250 }),
        makePr({ additions: 300, deletions: 0 }),
      ],
    });
    expect(getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.Kloc).value).toBe(
      1.1
    );
  });

  it("counts un-enriched merged PRs too (KLOC is not enriched-gated)", () => {
    const rows = makeRows({
      prs: [makePr({ additions: 1000, deletions: 0, enriched: false })],
    });
    expect(getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.Kloc).value).toBe(
      1
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

  it("tokens per KLOC = total tokens ÷ kloc", () => {
    // 1 merged PR, 1000 gross lines → KLOC 1.0; tokens 5000 → 5000 / 1 = 5000
    const rows = makeRows({
      prs: [makePr({ additions: 1000, deletions: 0 })],
      sessions: [makeSession({ tokens: 5000 })],
    });
    expect(
      getKpi(computeDeliveryKpis(rows), DeliveryKpiKey.TokensPerKloc).value
    ).toBe(5000);
  });

  it("tokens per KLOC divides by the RAW (pre-round) KLOC, not the display 0.0", () => {
    // 40 gross lines → KLOC raw 0.04, which the display round(1) collapses to 0.0.
    // The derived ratio must divide by the RAW 0.04 (→ a real number), NOT the
    // rounded 0.0 (which would zero the denominator and null the KPI despite
    // real data). tokens 8000 / 0.04 = 200_000.
    const rows = makeRows({
      prs: [makePr({ additions: 40, deletions: 0 })],
      sessions: [makeSession({ tokens: 8000 })],
    });
    const kpis = computeDeliveryKpis(rows);
    // Displayed KLOC is still the rounded 0 (display behavior unchanged)...
    expect(getKpi(kpis, DeliveryKpiKey.Kloc).value).toBe(0);
    // ...but tokens-per-KLOC is a real value, computed off the raw denominator.
    expect(getKpi(kpis, DeliveryKpiKey.TokensPerKloc).value).toBe(200_000);
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
    const kloc = getKpi(computeDeliveryKpis(makeRows()), DeliveryKpiKey.Kloc);
    expect(kloc.label).toBe("KLOC merged");
    expect(typeof kloc.help).toBe("string");
    expect(kloc.format).toBe("number");
  });

  it("excludes internal building-block KPIs from the result", () => {
    const kpis = computeDeliveryKpis(makeRows());
    expect(kpis[DeliveryKpiKey.DecidedCount]).toBeUndefined();
    expect(kpis[DeliveryKpiKey.SessionTokensTotal]).toBeUndefined();
  });

  it("empty sum-based KPIs (cost, kloc) are unavailable/null, not 0", () => {
    const kpis = computeDeliveryKpis(makeRows());
    expect(getKpi(kpis, DeliveryKpiKey.Cost).value).toBeNull();
    expect(getKpi(kpis, DeliveryKpiKey.Kloc).value).toBeNull();
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
    // mergedPrs feeds 4 KPIs (MergedCount, PrSize, TimeToMerge, Kloc) AND the
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

describe("applyTransform — exhaustive over KpiTransform", () => {
  it("returns the value unchanged for an undefined transform", () => {
    expect(applyTransform(1234, undefined)).toBe(1234);
  });

  it("divides by 1000 for PerThousand", () => {
    expect(applyTransform(1500, KpiTransform.PerThousand)).toBe(1.5);
  });

  it("throws on an unknown transform (exhaustive default guard)", () => {
    // Force an out-of-contract value past the type system to prove the runtime
    // guard fires instead of silently passing the value through.
    const bogus = "someFutureTransform" as unknown as KpiTransform;
    expect(() => applyTransform(10, bogus)).toThrow(UNHANDLED_TRANSFORM_RE);
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
