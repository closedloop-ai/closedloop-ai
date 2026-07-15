import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BranchKpi } from "@repo/api/src/types/branch";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_IPC_CHANNEL_LIST,
  SHARED_BRANCHES_IPC_CHANNELS,
} from "../src/shared/shared-branches-contract.js";

const UNAVAILABLE_KPI: BranchKpi = {
  value: null,
  state: "unavailable",
  baseline30d: null,
  deltaPct: null,
};

describe("shared branches IPC contract", () => {
  test("channel list contains exactly the five branch channels", () => {
    assert.deepEqual(
      [...SHARED_BRANCHES_IPC_CHANNEL_LIST],
      [
        "desktop:shared-branches:list",
        "desktop:shared-branches:detail",
        // PLN-1148 Phase 2: lazy merged-trace channel, split out of `detail`.
        "desktop:shared-branches:trace",
        "desktop:shared-branches:usage",
        "desktop:shared-branches:analytics",
      ]
    );
    assert.equal(
      SHARED_BRANCHES_IPC_CHANNELS.list,
      "desktop:shared-branches:list"
    );
    assert.equal(
      SHARED_BRANCHES_IPC_CHANNELS.trace,
      "desktop:shared-branches:trace"
    );
    assert.equal(
      SHARED_BRANCHES_IPC_CHANNELS.analytics,
      "desktop:shared-branches:analytics"
    );
  });

  test("empty list response is the documented zeroed shape", () => {
    assert.deepEqual(emptySharedBranchesListResponse(), {
      items: [],
      total: 0,
      viewerScope: "self",
    });
  });

  test("empty usage summary zeroes every total and array", () => {
    assert.deepEqual(emptySharedBranchesUsageSummary(), {
      viewerScope: "self",
      totalBranches: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCost: 0,
      subscriptionEstimatedCost: 0,
      apiEstimatedCost: 0,
      hourBuckets: [],
      phaseStacks: [],
      byActor: [],
    });
  });

  test("empty analytics marks every KPI unavailable and the split degraded", () => {
    const analytics = emptySharedBranchesAnalytics();
    assert.equal(analytics.viewerScope, "self");
    for (const kpi of [
      analytics.medianPrSize,
      analytics.mergeRate,
      analytics.medianTimeToMergeMs,
      analytics.activePrCount,
      analytics.mergedCount,
      analytics.leadTimeForChangeMs,
      analytics.locPerDollar,
      analytics.totalSpendUsd,
      analytics.activeBranchCount,
    ]) {
      assert.deepEqual(kpi, UNAVAILABLE_KPI);
    }
    assert.deepEqual(analytics.buildVsReworkSplit, {
      buildPct: null,
      reworkPct: null,
      state: "unavailable",
    });
  });
});
