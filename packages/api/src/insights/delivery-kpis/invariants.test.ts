// FEA-3118 / PRD-521 (DoD #1, #8) — cross-surface metric-SSOT reconciliation
// invariant tests.
//
// This file carries TWO complementary invariant suites, both proven against the
// shared SSOT engine (`computeDeliveryKpis` / `computeDeliveryKpiResult`), which
// the cloud (Postgres) and desktop (SQLite) surfaces both converge on — so an
// invariant proven here is proven for both surfaces at once and neither can
// silently drift:
//
//   A. PROPERTY invariants (sibling #2762) — assert properties that must hold for
//      EVERY input rather than pinning one fixture to one golden number:
//        1. Numerator ⊆ denominator; a rate is a fraction and never divides by 0.
//        2. Derived-KPI round-trip: derived × denominator ≈ numerator, and a
//           derived KPI is null exactly when its denominator is 0/absent.
//        3. No double-count across relations/branches.
//        4. Edge matrix: empty / single / multi-PR — all finite, never NaN/Inf.
//        5. Registry completeness: every DeliveryKpiKey has one entry; every
//           derived numerator/denominator resolves to a BASE entry.
//
//   B. FIXTURE / cross-surface invariants (this PR #2769) — pin the concrete
//      reconciliation facts, culminating in the cross-surface delta:
//        1. Derived KPIs equal the exact ratio of their declared base KPIs.
//        2. Conservation — a KPI total equals the sum over its raw fixture rows.
//        3. Enrichment policy holds jointly (unmeasured PR → 0 into SUM, excluded
//           from MEDIAN).
//        4. Null-vs-zero policy (the "—" vs "0" distinction PRD-521 calls out).
//        5. Cross-surface PARITY: the cloud insights service's merge rate, once
//           divergent (captured denominator), is now routed through the SSOT via
//           the SHARED `ssotMergeRateFromCounts` helper the service actually
//           calls — so this asserts HARD equality with the registry MergeRate
//           (decided denominator), not a documented delta (FEA-3151 reconciled the
//           delta FEA-3118 had pinned).
//
// Fixtures use clean integer/2dp values so pre-round and display-round coincide
// and the invariants are exact.

import { describe, expect, it } from "vitest";
import {
  computeDeliveryKpiResult,
  computeDeliveryKpis,
  type DeliveryKpiResult,
} from "./compute.ts";
import { makePr, makeRows, makeSession } from "./fixtures.test-helpers.ts";
import {
  NormalizedBranchStatus,
  type NormalizedDeliveryRows,
  NormalizedPrState,
} from "./normalized-rows.ts";
import { ssotMergeRateFromCounts } from "./parity.ts";
import {
  DELIVERY_KPI_REGISTRY,
  type DeliveryKpiDefinition,
  DeliveryKpiKey,
} from "./registry.ts";

/** Raw computed value for any KPI key (base, internal, or derived). */
function raw(result: DeliveryKpiResult, key: DeliveryKpiKey): number | null {
  const v = result.values.get(key);
  return v === undefined ? null : v;
}

/** Reads a raw computed value (base/internal/derived) from a compute pass. */
function kpiValue(
  rows: NormalizedDeliveryRows,
  key: DeliveryKpiKey
): number | null {
  return computeDeliveryKpiResult(rows).values.get(key) ?? null;
}

/** True when `n` is a finite number (rejects NaN, ±Infinity, and null). */
function isFiniteNumber(n: number | null): n is number {
  return n !== null && Number.isFinite(n);
}

const round = (x: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

/**
 * A representative spread of NormalizedDeliveryRows fixtures the property
 * assertions sweep over. Kept diverse on purpose: empty, merged-only, closed-only,
 * mixed decided, open/draft, enrichment lag, and cost/token presence/absence — so
 * an invariant is exercised across the whole population/derived matrix, not one
 * happy path.
 */
function representativeFixtures(): {
  name: string;
  rows: NormalizedDeliveryRows;
}[] {
  return [
    { name: "empty window", rows: makeRows() },
    {
      name: "single merged PR",
      rows: makeRows({
        prs: [makePr({ state: NormalizedPrState.Merged, mergedAt: 100 })],
        sessions: [makeSession({ costUsd: 10, tokens: 5000 })],
      }),
    },
    {
      name: "merged + closed (decided mix)",
      rows: makeRows({
        prs: [
          makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
          makePr({ state: NormalizedPrState.Merged, mergedAt: 150 }),
          makePr({
            state: NormalizedPrState.Closed,
            mergedAt: null,
            closedAt: 120,
          }),
        ],
        sessions: [makeSession({ costUsd: 6, tokens: 4000 })],
      }),
    },
    {
      name: "closed-only (no merges)",
      rows: makeRows({
        prs: [
          makePr({
            state: NormalizedPrState.Closed,
            mergedAt: null,
            closedAt: 100,
          }),
        ],
        sessions: [makeSession({ costUsd: 3, tokens: 900 })],
      }),
    },
    {
      name: "open/draft only (nothing decided)",
      rows: makeRows({
        prs: [
          makePr({
            state: NormalizedPrState.Open,
            mergedAt: null,
            observedAt: 100,
          }),
          makePr({
            state: NormalizedPrState.Draft,
            mergedAt: null,
            observedAt: 100,
          }),
        ],
      }),
    },
    {
      name: "enrichment lag (some merged PRs un-enriched)",
      rows: makeRows({
        prs: [
          makePr({ additions: 40, deletions: 0, enriched: true }),
          makePr({ additions: 60, deletions: 0, enriched: false }),
        ],
        sessions: [makeSession({ costUsd: 2, tokens: 8000 })],
      }),
    },
    {
      name: "sessions without cost/token telemetry",
      rows: makeRows({
        prs: [makePr({ state: NormalizedPrState.Merged, mergedAt: 100 })],
        sessions: [makeSession({ costUsd: null, tokens: null })],
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Suite A — PROPERTY invariants (sibling #2762)
// ---------------------------------------------------------------------------

describe("SSOT invariant — numerator ⊆ denominator (merge rate)", () => {
  it.each(
    representativeFixtures()
  )("mergedCount ≤ decidedCount and mergeRate ∈ [0,100] for: $name", ({
    rows,
  }) => {
    const merged = kpiValue(rows, DeliveryKpiKey.MergedCount);
    const decided = kpiValue(rows, DeliveryKpiKey.DecidedCount);
    // Counts are always finite (0 on empty), never null.
    expect(isFiniteNumber(merged)).toBe(true);
    expect(isFiniteNumber(decided)).toBe(true);
    // Numerator ⊆ denominator: every merged PR is also decided.
    expect(merged as number).toBeLessThanOrEqual(decided as number);

    const rate = kpiValue(rows, DeliveryKpiKey.MergeRate);
    if (decided === 0) {
      // Never divide by zero: an undefined rate is null, not NaN/0.
      expect(rate).toBeNull();
    } else {
      expect(isFiniteNumber(rate)).toBe(true);
      expect(rate as number).toBeGreaterThanOrEqual(0);
      expect(rate as number).toBeLessThanOrEqual(100);
    }
  });

  it("mergeRate is null (not NaN/0) whenever decidedCount is 0", () => {
    // Only open PRs: nothing is decided, so the rate must be unavailable.
    const rows = makeRows({
      prs: [
        makePr({
          state: NormalizedPrState.Open,
          mergedAt: null,
          observedAt: 100,
        }),
      ],
    });
    expect(kpiValue(rows, DeliveryKpiKey.DecidedCount)).toBe(0);
    const rate = kpiValue(rows, DeliveryKpiKey.MergeRate);
    expect(rate).toBeNull();
    expect(Number.isNaN(rate as unknown as number)).toBe(false);
  });

  it("mergeRate never exceeds 100 even when every decided PR merged", () => {
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
      ],
    });
    // 2/2 → 100. The registry scale is 100 (percent), so a full-merge cohort
    // caps exactly at 100, never above.
    expect(kpiValue(rows, DeliveryKpiKey.MergeRate)).toBe(100);
  });
});

describe("SSOT invariant — derived-KPI round-trip consistency", () => {
  // Fixtures are chosen so the base numerator/denominator are EXACT integers,
  // making `derived × denominator == numerator` hold without rounding slack.

  it("costPerMergedPr × mergedCount == cost (cost divisible by merged count)", () => {
    // 2 merged PRs, cost 10 → cost-per-merged 5.00 → 5 × 2 == 10.
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
      ],
      sessions: [makeSession({ costUsd: 10, tokens: 0 })],
    });
    const cost = kpiValue(rows, DeliveryKpiKey.Cost);
    const merged = kpiValue(rows, DeliveryKpiKey.MergedCount);
    const perMerged = kpiValue(rows, DeliveryKpiKey.CostPerMergedPr);
    expect(perMerged).toBe(5);
    expect((perMerged as number) * (merged as number)).toBeCloseTo(
      cost as number,
      2
    );
  });

  it("tokensPerKloc × kloc == tokens (tokens divisible by kloc)", () => {
    // 1 merged PR, 2000 gross lines → KLOC 2.0; tokens 6000 → 3000/KLOC.
    // 3000 × 2.0 == 6000.
    const rows = makeRows({
      prs: [makePr({ additions: 2000, deletions: 0 })],
      sessions: [makeSession({ costUsd: 0, tokens: 6000 })],
    });
    const tokens = kpiValue(rows, DeliveryKpiKey.SessionTokensTotal);
    const kloc = kpiValue(rows, DeliveryKpiKey.Kloc);
    const perKloc = kpiValue(rows, DeliveryKpiKey.TokensPerKloc);
    expect(perKloc).toBe(3000);
    expect((perKloc as number) * (kloc as number)).toBeCloseTo(
      tokens as number,
      1
    );
  });

  it("costPerMergedPr is null exactly when mergedCount is 0", () => {
    const noMerges = makeRows({
      prs: [
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 100,
        }),
      ],
      sessions: [makeSession({ costUsd: 10 })],
    });
    expect(kpiValue(noMerges, DeliveryKpiKey.MergedCount)).toBe(0);
    expect(kpiValue(noMerges, DeliveryKpiKey.CostPerMergedPr)).toBeNull();

    const withMerge = makeRows({
      prs: [makePr({ state: NormalizedPrState.Merged, mergedAt: 100 })],
      sessions: [makeSession({ costUsd: 10 })],
    });
    expect(kpiValue(withMerge, DeliveryKpiKey.CostPerMergedPr)).not.toBeNull();
  });

  it("tokensPerKloc is null exactly when kloc is 0/absent", () => {
    // No merged PRs → KLOC null (sum over empty) → tokensPerKloc null.
    const noKloc = makeRows({
      sessions: [makeSession({ tokens: 5000 })],
    });
    expect(kpiValue(noKloc, DeliveryKpiKey.Kloc)).toBeNull();
    expect(kpiValue(noKloc, DeliveryKpiKey.TokensPerKloc)).toBeNull();

    const withKloc = makeRows({
      prs: [makePr({ additions: 1000, deletions: 0 })],
      sessions: [makeSession({ tokens: 5000 })],
    });
    expect(kpiValue(withKloc, DeliveryKpiKey.TokensPerKloc)).not.toBeNull();
  });

  it("derived KPIs divide by the RAW denominator, so a sub-1.0 KLOC still yields a rate", () => {
    // 40 gross lines → KLOC raw 0.04 (display-rounds to 0.0). The derived KPI must
    // use the raw 0.04 denominator, never the display 0 — otherwise it would wrongly
    // null despite real lines. This is the surface-drift trap the SSOT closes.
    const rows = makeRows({
      prs: [makePr({ additions: 40, deletions: 0 })],
      sessions: [makeSession({ tokens: 8000 })],
    });
    // Display KLOC rounds to 0, but tokens-per-KLOC is a real finite number.
    expect(kpiValue(rows, DeliveryKpiKey.Kloc)).toBe(0);
    expect(kpiValue(rows, DeliveryKpiKey.TokensPerKloc)).toBe(200_000);
  });
});

describe("SSOT invariant — no double-count across relations/branches", () => {
  it("a PR is counted once in mergedCount and once in KLOC regardless of branch fan-out", () => {
    // Model a single logical merged PR alongside branch rows that could tempt a
    // naive join to count its lines twice. The PR population reads rows.prs only;
    // branch rows must not inflate mergedCount or the PR-sourced KLOC.
    const single = makeRows({
      prs: [makePr({ additions: 1000, deletions: 0, mergedAt: 100 })],
    });
    const withDupeBranches = makeRows({
      prs: [makePr({ additions: 1000, deletions: 0, mergedAt: 100 })],
      branches: [
        // Two branch rows referencing "the same" work — a fan-out that a
        // relation-based join could double-count. KLOC is PR-sourced, so these
        // must have ZERO effect on mergedCount or KLOC.
        {
          status: NormalizedBranchStatus.Merged,
          additions: 1000,
          deletions: 0,
          startedAt: 90,
          settledAt: 100,
          hasPr: true,
        },
        {
          status: NormalizedBranchStatus.Merged,
          additions: 1000,
          deletions: 0,
          startedAt: 90,
          settledAt: 100,
          hasPr: true,
        },
      ],
    });
    expect(kpiValue(withDupeBranches, DeliveryKpiKey.MergedCount)).toBe(
      kpiValue(single, DeliveryKpiKey.MergedCount)
    );
    expect(kpiValue(withDupeBranches, DeliveryKpiKey.Kloc)).toBe(
      kpiValue(single, DeliveryKpiKey.Kloc)
    );
    // And the single PR counts exactly once.
    expect(kpiValue(withDupeBranches, DeliveryKpiKey.MergedCount)).toBe(1);
    expect(kpiValue(withDupeBranches, DeliveryKpiKey.Kloc)).toBe(1);
  });

  it("decidedPrs (merged ∪ closed) never double-counts a single PR", () => {
    // A merged-then-closed PR carries both mergedAt AND closedAt, but normalizes
    // to state=Merged, so it must appear in exactly one arm of the disjoint union.
    const rows = makeRows({
      prs: [
        makePr({
          state: NormalizedPrState.Merged,
          mergedAt: 100,
          closedAt: 120, // also closed — must NOT add a second decided count
        }),
      ],
    });
    expect(kpiValue(rows, DeliveryKpiKey.MergedCount)).toBe(1);
    expect(kpiValue(rows, DeliveryKpiKey.DecidedCount)).toBe(1);
  });
});

describe("SSOT invariant — edge matrix (finiteness, no NaN/Infinity)", () => {
  // NOTE (scan cap): this registry models NO scan/ingest cap — populations are
  // pure window filters with no upper-bound truncation — so there is no capped
  // case to pin here.
  // NOTE (day-boundary bucketing): windowing is a single closed epoch-ms range
  // check (`inWindow`), with NO calendar-day / timezone bucketing reachable in
  // this pure package. A non-UTC day-boundary path is therefore OUT OF SCOPE for
  // this package's invariants (it would live in a surface adapter, not here).

  it("empty window: every public KPI is null or a finite count, never NaN/Infinity", () => {
    const kpis = computeDeliveryKpis(makeRows());
    for (const kpi of Object.values(kpis)) {
      if (kpi.value !== null) {
        expect(Number.isFinite(kpi.value)).toBe(true);
      }
    }
    // Counts are 0; sum/median/derived KPIs are null (unavailable, not fabricated).
    expect(kpis[DeliveryKpiKey.MergedCount]?.value).toBe(0);
    expect(kpis[DeliveryKpiKey.CapturedPrCount]?.value).toBe(0);
    expect(kpis[DeliveryKpiKey.Kloc]?.value).toBeNull();
    expect(kpis[DeliveryKpiKey.MergeRate]?.value).toBeNull();
    expect(kpis[DeliveryKpiKey.CostPerMergedPr]?.value).toBeNull();
    expect(kpis[DeliveryKpiKey.TokensPerKloc]?.value).toBeNull();
  });

  it("single PR: counts are 1 and every value is finite or null", () => {
    const rows = makeRows({
      prs: [makePr({ additions: 100, deletions: 0, mergedAt: 100 })],
      sessions: [makeSession({ costUsd: 4, tokens: 2000 })],
    });
    const { values } = computeDeliveryKpiResult(rows);
    for (const value of values.values()) {
      if (value !== null) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    expect(values.get(DeliveryKpiKey.MergedCount)).toBe(1);
    expect(values.get(DeliveryKpiKey.CapturedPrCount)).toBe(1);
  });

  it("multi-PR branch: aggregates stay finite and consistent across many PRs", () => {
    const prs = Array.from({ length: 5 }, (_, i) =>
      makePr({
        state: NormalizedPrState.Merged,
        mergedAt: 100 + i,
        additions: 200,
        deletions: 0,
      })
    );
    const rows = makeRows({
      prs,
      sessions: [makeSession({ costUsd: 25, tokens: 10_000 })],
    });
    const { values } = computeDeliveryKpiResult(rows);
    for (const value of values.values()) {
      if (value !== null) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    // 5 merged PRs × 200 gross = 1000 → KLOC 1.0; merged=decided → rate 100.
    expect(values.get(DeliveryKpiKey.MergedCount)).toBe(5);
    expect(values.get(DeliveryKpiKey.Kloc)).toBe(1);
    expect(values.get(DeliveryKpiKey.MergeRate)).toBe(100);
    // cost 25 / 5 merged == 5.00.
    expect(values.get(DeliveryKpiKey.CostPerMergedPr)).toBe(5);
  });
});

describe("SSOT invariant — registry completeness", () => {
  it("every DeliveryKpiKey has exactly one registry entry", () => {
    const registryKeys = DELIVERY_KPI_REGISTRY.map((def) => def.key);
    // No duplicate entries.
    expect(new Set(registryKeys).size).toBe(registryKeys.length);
    // Every declared key is present, and no registry entry lacks a declared key.
    const declared = new Set<DeliveryKpiKey>(Object.values(DeliveryKpiKey));
    expect(new Set(registryKeys)).toEqual(declared);
  });

  it("every derived KPI's numerator/denominator resolve to a BASE (non-derived) entry", () => {
    const byKey = new Map<DeliveryKpiKey, DeliveryKpiDefinition>(
      DELIVERY_KPI_REGISTRY.map((def) => [def.key, def])
    );
    const derived = DELIVERY_KPI_REGISTRY.filter(
      (def) => def.source === "derived"
    );
    // Guard the test itself: the registry must actually contain derived KPIs,
    // otherwise this assertion would vacuously pass.
    expect(derived.length).toBeGreaterThan(0);
    for (const def of derived) {
      if (def.source !== "derived") {
        continue;
      }
      for (const refKey of [
        def.derived.numeratorKpi,
        def.derived.denominatorKpi,
      ]) {
        const ref = byKey.get(refKey);
        // The referenced key exists (guards against a KPI drifting to undefined)...
        expect(ref).toBeDefined();
        // ...and is a base KPI, never another derived (derived-of-derived is illegal).
        expect(ref?.source).not.toBe("derived");
      }
    }
  });

  it("every public KPI computed from empty rows carries full display metadata", () => {
    // Registry completeness also means every PUBLIC key materializes with its
    // label/help/format — a new KPI missing from the walk would surface as a gap.
    const kpis = computeDeliveryKpis(makeRows());
    for (const kpi of Object.values(kpis)) {
      expect(typeof kpi.label).toBe("string");
      expect(kpi.label.length).toBeGreaterThan(0);
      expect(typeof kpi.help).toBe("string");
      expect(typeof kpi.format).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Suite B — FIXTURE / cross-surface invariants (this PR #2769)
// ---------------------------------------------------------------------------

describe("FEA-3118 invariant — derived KPIs equal their declared base ratio", () => {
  it("MergeRate === round0(MergedCount / DecidedCount * 100)", () => {
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
    const r = computeDeliveryKpiResult(rows);
    const merged = raw(r, DeliveryKpiKey.MergedCount);
    const decided = raw(r, DeliveryKpiKey.DecidedCount);
    expect(merged).toBe(3);
    expect(decided).toBe(4); // merged(3) + closed(1); the open PR is excluded
    expect(raw(r, DeliveryKpiKey.MergeRate)).toBe(
      round((merged! / decided!) * 100, 0)
    );
  });

  it("CostPerMergedPr === round2(Cost / MergedCount)", () => {
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
      ],
      sessions: [makeSession({ costUsd: 10 }), makeSession({ costUsd: 20 })],
    });
    const r = computeDeliveryKpiResult(rows);
    const cost = raw(r, DeliveryKpiKey.Cost);
    const merged = raw(r, DeliveryKpiKey.MergedCount);
    expect(cost).toBe(30);
    expect(merged).toBe(4);
    expect(raw(r, DeliveryKpiKey.CostPerMergedPr)).toBe(
      round(cost! / merged!, 2)
    );
  });
});

describe("FEA-3118 invariant — conservation (parts sum to the total)", () => {
  it("Cost === Σ session.costUsd over sessions in window", () => {
    const sessions = [
      makeSession({ costUsd: 1.25 }),
      makeSession({ costUsd: 2.5 }),
      makeSession({ costUsd: 0.25 }),
    ];
    const rows = makeRows({ sessions });
    const r = computeDeliveryKpiResult(rows);
    const expected = round(
      sessions.reduce((s, x) => s + (x.costUsd ?? 0), 0),
      2
    );
    expect(raw(r, DeliveryKpiKey.Cost)).toBe(expected); // 4.0
  });

  it("Kloc === round1(Σ linesGross(merged PRs) / 1000)", () => {
    const prs = [
      makePr({ additions: 500, deletions: 250, mergedAt: 100 }),
      makePr({ additions: 300, deletions: 0, mergedAt: 100 }),
      // an un-enriched, still-merged PR carries real lines here too
      makePr({ additions: 200, deletions: 0, mergedAt: 100 }),
    ];
    const rows = makeRows({ prs });
    const r = computeDeliveryKpiResult(rows);
    const grossSum = prs.reduce(
      (s, p) => s + (p.additions ?? 0) + (p.deletions ?? 0),
      0
    );
    expect(raw(r, DeliveryKpiKey.Kloc)).toBe(round(grossSum / 1000, 1)); // 1.3
  });

  it("MergedCount and DecidedCount equal the raw state counts", () => {
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
    const r = computeDeliveryKpiResult(rows);
    expect(raw(r, DeliveryKpiKey.MergedCount)).toBe(2);
    expect(raw(r, DeliveryKpiKey.DecidedCount)).toBe(3); // merged + closed
    expect(raw(r, DeliveryKpiKey.CapturedPrCount)).toBe(4); // all states
  });
});

describe("FEA-3118 invariant — enrichment policy holds jointly", () => {
  it("an un-enriched (unmeasured) merged PR folds as 0 into KLOC and is excluded from PrSize", () => {
    const enrichedOnly = makeRows({
      prs: [
        makePr({ additions: 100, deletions: 0, enriched: true, mergedAt: 100 }),
        makePr({ additions: 300, deletions: 0, enriched: true, mergedAt: 100 }),
      ],
    });
    // Same corpus + one unmeasured PR (null line counts, enriched:false).
    const withUnenriched = makeRows({
      prs: [
        makePr({ additions: 100, deletions: 0, enriched: true, mergedAt: 100 }),
        makePr({ additions: 300, deletions: 0, enriched: true, mergedAt: 100 }),
        makePr({
          additions: null,
          deletions: null,
          enriched: false,
          mergedAt: 100,
        }),
      ],
    });
    const a = computeDeliveryKpis(enrichedOnly);
    const b = computeDeliveryKpis(withUnenriched);

    // KLOC unchanged: the unmeasured PR contributes 0 gross lines.
    expect(b[DeliveryKpiKey.Kloc]?.value).toBe(a[DeliveryKpiKey.Kloc]?.value);
    // PrSize unchanged: the unmeasured PR is excluded from the median entirely.
    expect(b[DeliveryKpiKey.PrSize]?.value).toBe(
      a[DeliveryKpiKey.PrSize]?.value
    );
    // And the median is over the enriched line totals only: median(100,300)=200.
    expect(b[DeliveryKpiKey.PrSize]?.value).toBe(200);
  });
});

describe("FEA-3118 invariant — null-vs-zero policy (— vs 0)", () => {
  it("empty window: counts are 0, ratios/median are null (never a fabricated 0)", () => {
    const r = computeDeliveryKpiResult(makeRows({}));
    // Counts: an aggregate over zero rows is 0.
    expect(raw(r, DeliveryKpiKey.MergedCount)).toBe(0);
    expect(raw(r, DeliveryKpiKey.CapturedPrCount)).toBe(0);
    // Ratios / median: null (unknown), not 0.
    expect(raw(r, DeliveryKpiKey.MergeRate)).toBeNull(); // decided = 0
    expect(raw(r, DeliveryKpiKey.CostPerMergedPr)).toBeNull(); // merged = 0
    expect(raw(r, DeliveryKpiKey.PrSize)).toBeNull(); // no enriched PRs
  });

  it("single merged PR: PrSize equals that PR's gross line total", () => {
    const rows = makeRows({
      prs: [
        makePr({ additions: 42, deletions: 8, enriched: true, mergedAt: 100 }),
      ],
    });
    expect(computeDeliveryKpis(rows)[DeliveryKpiKey.PrSize]?.value).toBe(50);
  });
});

describe("FEA-3151 cross-surface parity — cloud merge rate == SSOT merge rate", () => {
  // The SSOT (registry.ts) and the desktop reimplementation both use the DECIDED
  // denominator: MergeRate = merged / (merged + closed). The cloud insights
  // service was the ONE surface still computing merge rate divergently, against
  // the CAPTURED (opened) denominator (FEA-3118 pinned that as a documented
  // delta). FEA-3151 routes the cloud service through the SSOT: it now calls the
  // SHARED `ssotMergeRateFromCounts(mergedCount, closedCount)` helper
  // (apps/api/app/insights/service.ts getDelivery's `merge-rate` KPI), which
  // reconstitutes a fixture from the exact merged/closed counts and runs the ONE
  // engine. This test exercises that ACTUAL cloud call path and asserts HARD
  // equality with the registry MergeRate — no remaining delta to pin.
  it("cloud merge rate (from counts) equals the SSOT decided-denominator MergeRate", () => {
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
    const r = computeDeliveryKpiResult(rows);
    const merged = raw(r, DeliveryKpiKey.MergedCount)!; // 3
    const decided = raw(r, DeliveryKpiKey.DecidedCount)!; // 4 (merged + closed)
    const closed = decided - merged; // 1 closed-without-merge

    const ssotRate = raw(r, DeliveryKpiKey.MergeRate); // decided-based → 75
    // The cloud surface now derives its rate from scalar merged/closed counts via
    // the same engine — assert it matches the SSOT KPI exactly (no delta).
    const cloudRate = ssotMergeRateFromCounts(merged, closed);

    expect(ssotRate).toBe(round((merged / decided) * 100, 0)); // 75
    expect(cloudRate).toBe(ssotRate); // hard cross-surface parity — the delta is gone
  });

  it("cloud merge rate is null (unavailable) when there is no decided cohort", () => {
    // Zero merged and zero closed ⇒ empty decided denominator. The SSOT reports
    // null ("—"), and the cloud helper mirrors that instead of fabricating a 0.
    expect(ssotMergeRateFromCounts(0, 0)).toBeNull();
  });
});
