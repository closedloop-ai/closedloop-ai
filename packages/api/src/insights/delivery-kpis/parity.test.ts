import { describe, expect, it } from "vitest";
import { makePr, makeRows, makeSession } from "./fixtures.test-helpers.ts";
import { NormalizedPrState } from "./normalized-rows.ts";
import { assertKpiParity } from "./parity.ts";
import { DeliveryKpiKey } from "./registry.ts";

// A shared fixture the future desktop/cloud adapters will each reproduce.
function goldenRows() {
  return makeRows({
    prs: [
      makePr({
        state: NormalizedPrState.Merged,
        mergedAt: 100,
        additions: 100,
        deletions: 0,
      }),
      makePr({
        state: NormalizedPrState.Merged,
        mergedAt: 200,
        additions: 300,
        deletions: 0,
      }),
      makePr({
        state: NormalizedPrState.Closed,
        mergedAt: null,
        closedAt: 150,
      }),
    ],
    sessions: [makeSession({ costUsd: 4, tokens: 800 })],
  });
}

describe("assertKpiParity", () => {
  it("passes when computed values match the golden", () => {
    const result = assertKpiParity(goldenRows(), null, {
      [DeliveryKpiKey.MergedCount]: 2,
      [DeliveryKpiKey.MergeRate]: 67, // 2/3 → 66.7 → round0 → 67
      [DeliveryKpiKey.Kloc]: 0.4, // 400 gross / 1000 → 0.4
      [DeliveryKpiKey.Cost]: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("reports golden mismatches without throwing", () => {
    const result = assertKpiParity(goldenRows(), null, {
      [DeliveryKpiKey.MergedCount]: 999,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches[0]).toMatchObject({
      key: DeliveryKpiKey.MergedCount,
      expected: 999,
      actual: 2,
      kind: "golden",
    });
  });

  it("cross-checks two fixtures for A↔B parity", () => {
    // Identical rows must agree on every KPI.
    const result = assertKpiParity(goldenRows(), goldenRows(), {});
    expect(result.ok).toBe(true);
  });

  it("flags a cross mismatch when two fixtures diverge", () => {
    const a = goldenRows();
    const b = makeRows({
      prs: [makePr({ state: NormalizedPrState.Merged, mergedAt: 100 })],
    });
    const result = assertKpiParity(a, b, {});
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.kind === "cross")).toBe(true);
  });

  it("cross-check surfaces divergence in INTERNAL KPIs (not just public)", () => {
    // A has one merged + one closed PR (DecidedCount = 2); B has only the merged
    // PR (DecidedCount = 1). DecidedCount is an internal building-block KPI that
    // never appears in the public map — before the internal-inclusive cross-check
    // this discrepancy was invisible. Assert it is now reported.
    const a = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 100 }),
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 100,
        }),
      ],
    });
    const b = makeRows({
      prs: [makePr({ state: NormalizedPrState.Merged, mergedAt: 100 })],
    });
    const result = assertKpiParity(a, b, {});
    expect(result.ok).toBe(false);
    const decidedMismatch = result.mismatches.find(
      (m) => m.key === DeliveryKpiKey.DecidedCount && m.kind === "cross"
    );
    expect(decidedMismatch).toMatchObject({
      key: DeliveryKpiKey.DecidedCount,
      expected: 2,
      actual: 1,
      kind: "cross",
    });
  });
});
