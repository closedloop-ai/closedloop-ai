import assert from "node:assert/strict";
import test from "node:test";
import type { BranchAnalytics, BranchKpi } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { projectBranchAnalytics } from "../src/main/branch/branch-analytics-projection.js";
import { makeBranchRowFixture as makeRow } from "./shared-branches-test-helpers.js";

/**
 * ISS-4686 — the DESKTOP half of the baseline-scope guard.
 *
 * The branch-detail headline cards render a per-branch figure, so a 30-day
 * baseline may only earn a "better"/"worse" verdict when it says which
 * population it covers. The consumer refuses an unscoped or corpus-scoped
 * baseline; this pins the producer side of the same contract on desktop, so a
 * future author who wires a baseline here has to declare its scope (the
 * `BranchKpiWithBaseline` arm demands it at compile time; this catches the
 * emitted payload at runtime). The cloud producer carries the mirror assertion in
 * `apps/api/app/branches/branch-read-service.date-window.test.ts`.
 */

const MEASURED_KPI_KEYS = [
  "medianPrSize",
  "mergeRate",
  "medianTimeToMergeMs",
  "activePrCount",
  "mergedCount",
  "leadTimeForChangeMs",
  "locPerDollar",
  "totalSpendUsd",
  "activeBranchCount",
] as const satisfies readonly (keyof BranchAnalytics)[];

test("desktop analytics emits no baseline without the scope it was measured over", () => {
  const analytics = projectBranchAnalytics(
    [
      makeRow({
        id: "b1",
        prState: GitHubPRState.Merged,
        additions: 100,
        deletions: 20,
      }),
      makeRow({ id: "b2", prState: GitHubPRState.Open }),
    ],
    { totalSpendUsd: 40, locEnrichedSpendUsd: 10 }
  );

  for (const key of MEASURED_KPI_KEYS) {
    const kpi: BranchKpi = analytics[key];
    // No baseline is computed on this surface yet …
    assert.equal(kpi.baseline30d, null, `${key}.baseline30d`);
    assert.equal(kpi.deltaPct, null, `${key}.deltaPct`);
    // … and nothing claims a scope it does not have. The day this producer does
    // compute one, both of the above must change TOGETHER with a real
    // `comparisonScope` — a bare number here is what a consumer would otherwise
    // render as a per-branch verdict.
    assert.equal(kpi.comparisonScope, undefined, `${key}.comparisonScope`);
  }
});
