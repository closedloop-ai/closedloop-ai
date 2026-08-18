/**
 * @file distributed-pack-row.test.ts
 * @description Unit tests for the admin distribute-table view-model
 * (FEA-4088): honest adoption presence (PLN-1497 OQ4 — never a fake 0), usage
 * null-through, and null-aware sorting. Pure logic, no render.
 */

import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { describe, expect, it } from "vitest";
import {
  adoptionPercent,
  compareDistributedPackRows,
  type DistributedPackRow,
  DistributedPackSortKey,
  toDistributedPackRows,
} from "../distributed-pack-row";
import type { PackDistribution, PackView } from "../pack-view";

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "cat-1",
    name: "Security Baseline",
    publisher: "Platform Eng",
    version: "4.2.0",
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    ...overrides,
  };
}

function distribution(
  overrides: Partial<PackDistribution> = {}
): PackDistribution {
  return {
    id: "dist-1",
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetCount: 100,
    installedCount: 90,
    pendingCount: 5,
    failedCount: 5,
    targetingEntries: [],
    // A detail read loaded the per-target statuses, so adoption is real.
    adoptionLoaded: true,
    ...overrides,
  };
}

describe("toDistributedPackRows", () => {
  it("emits one row per pack that has an active distribution and skips the rest", () => {
    const rows = toDistributedPackRows([
      pack({ id: "a", distribution: distribution({ id: "dist-a" }) }),
      pack({ id: "b", distribution: null }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("dist-a");
    expect(rows[0]?.catalogItemId).toBe("a");
  });

  it("carries a real adoption count when per-target statuses were loaded", () => {
    const [row] = toDistributedPackRows([
      pack({
        distribution: distribution({
          targetCount: 132,
          installedCount: 128,
          failedCount: 4,
          adoptionLoaded: true,
        }),
      }),
    ]);

    expect(row?.adoption).toEqual({ installed: 128, target: 132, failed: 4 });
  });

  it("marks adoption unavailable (null, not 0) when statuses weren't loaded", () => {
    // The GET /distributions list read carries no per-target statuses, so
    // `adoptionLoaded` is false — an install count cannot be computed and the
    // row must not claim a fabricated 0.
    const [row] = toDistributedPackRows([
      pack({
        distribution: distribution({ adoptionLoaded: false }),
      }),
    ]);

    expect(row?.adoption).toBeNull();
  });

  it("keeps 30d usage null even when an all-time performance count exists", () => {
    // `PackPerformance.invocations` is the ALL-TIME org-wide total, not a 30-day
    // window. Surfacing it under a "Usage (30d)" column would mislabel the
    // number, so the row stays null ("Not reported") until a real windowed
    // source is wired — a wrong number is as bad as a fake one (FEA-4088).
    const [withPerf] = toDistributedPackRows([
      pack({
        distribution: distribution(),
        performance: {
          locPerDollar: null,
          locDelta: null,
          successRate: null,
          successDelta: null,
          tokenEfficiencyDelta: null,
          efficiencyTrend: [],
          invocations: 4210,
          sessions: null,
          mergedPrs: null,
          qualityScore: null,
          qualityDelta: null,
          usageTrend: [],
        },
      }),
    ]);
    expect(withPerf?.invocations30d).toBeNull();

    const [noPerf] = toDistributedPackRows([
      pack({ distribution: distribution(), performance: null }),
    ]);
    expect(noPerf?.invocations30d).toBeNull();
  });
});

describe("adoptionPercent", () => {
  it("rounds installed/target to a 0–100 integer", () => {
    expect(adoptionPercent({ installed: 128, target: 132, failed: 0 })).toBe(
      97
    );
  });

  it("is 0 (not NaN) when nothing was targeted", () => {
    expect(adoptionPercent({ installed: 0, target: 0, failed: 0 })).toBe(0);
  });

  it("caps an overshoot at 100 rather than emitting an out-of-range percent", () => {
    // A targeted group can shrink under an install count that already landed.
    // Above 100 the shared `Progress` treats the value as indeterminate, so an
    // uncapped overshoot rendered a sweeping unknown bar beside a "120%" label.
    expect(adoptionPercent({ installed: 12, target: 10, failed: 0 })).toBe(100);
  });
});

describe("compareDistributedPackRows", () => {
  const rows: DistributedPackRow[] = [
    {
      id: "1",
      catalogItemId: "c1",
      name: "Beta",
      publisher: "Eng",
      version: "1.0.0",
      mode: DistributionMode.OptIn,
      adoption: { installed: 50, target: 100, failed: 0 },
      invocations30d: 100,
    },
    {
      id: "2",
      catalogItemId: "c2",
      name: "Alpha",
      publisher: "Eng",
      version: "2.0.0",
      mode: DistributionMode.AutoInstall,
      adoption: { installed: 90, target: 100, failed: 0 },
      invocations30d: null,
    },
  ];

  it("sorts by name ascending", () => {
    const sorted = [...rows].sort((a, b) =>
      compareDistributedPackRows(a, b, DistributedPackSortKey.Name, "asc")
    );
    expect(sorted.map((r) => r.name)).toEqual(["Alpha", "Beta"]);
  });

  it("sorts by adoption percent descending", () => {
    const sorted = [...rows].sort((a, b) =>
      compareDistributedPackRows(a, b, DistributedPackSortKey.Adoption, "desc")
    );
    expect(sorted.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("parks a null usage value LAST in both directions, never first", () => {
    // row 2 has null usage. An unavailable value is neither the largest nor the
    // smallest real value, so it must sink to the bottom regardless of
    // direction — the direction only orders the real values against each other.
    const asc = [...rows].sort((a, b) =>
      compareDistributedPackRows(a, b, DistributedPackSortKey.Usage, "asc")
    );
    expect(asc.map((r) => r.id)).toEqual(["1", "2"]);

    const desc = [...rows].sort((a, b) =>
      compareDistributedPackRows(a, b, DistributedPackSortKey.Usage, "desc")
    );
    // Still last on descending — the null does not flip to the top.
    expect(desc.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("parks a null adoption value LAST in both directions", () => {
    const nullAdoptionRows: DistributedPackRow[] = [
      { ...rows[0], id: "has", adoption: rows[0]?.adoption ?? null },
      { ...rows[1], id: "none", adoption: null },
    ];

    const asc = [...nullAdoptionRows].sort((a, b) =>
      compareDistributedPackRows(a, b, DistributedPackSortKey.Adoption, "asc")
    );
    expect(asc.map((r) => r.id)).toEqual(["has", "none"]);

    const desc = [...nullAdoptionRows].sort((a, b) =>
      compareDistributedPackRows(a, b, DistributedPackSortKey.Adoption, "desc")
    );
    expect(desc.map((r) => r.id)).toEqual(["has", "none"]);
  });
});
