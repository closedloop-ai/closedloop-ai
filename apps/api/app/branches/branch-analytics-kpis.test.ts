import {
  BranchKpiState,
  type BranchSession,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BranchAnalyticsMetrics,
  buildBranchAnalytics,
} from "./branch-analytics-kpis";
import type { SessionUsage } from "./branch-read-service/session-usage-window";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORGANIZATION_ID = "org_analytics_kpis";

function session(sessionId: string, estimatedCostUsd: number): BranchSession {
  return {
    sessionId,
    slug: null,
    name: null,
    harness: "claude-code",
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    isPrimary: true,
    estimatedCostUsd,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ownerUserName: null,
  };
}

function usage(sessions: BranchSession[]): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: sessions.reduce(
      (sum, entry) => sum + (entry.estimatedCostUsd ?? 0),
      0
    ),
    sessionIds: sessions.map((entry) => entry.sessionId),
    sessions,
    ownerCounts: new Map<string, number>(),
    sessionOwnerById: new Map<string, string | null>(),
    sessionBillingModeById: new Map<string, string | null>(),
  };
}

function metric(id: string): BranchAnalyticsMetrics {
  return {
    id,
    status: BranchStatus.Open,
    prState: null,
    mergedAt: null,
    additions: null,
    deletions: null,
    prSize: null,
  };
}

function analyticsFor(sessions: BranchSession[]) {
  const usageByBranch = new Map([["branch-1", usage(sessions)]]);
  return buildBranchAnalytics({
    organizationId: ORGANIZATION_ID,
    metrics: [metric("branch-1")],
    usageByBranch,
    lifetimeUsageByBranch: usageByBranch,
  });
}

/**
 * ISS-4737 (#4244 review, chatgpt-codex P1) — a corrupt spend total renders as
 * the same graceful "No data" a legitimately unpriced corpus does, so without a
 * report the two would be indistinguishable and bad persisted cost / a broken
 * pricing read would leave no trace to diagnose. This producer runs in Node, so
 * per the repo's bad-data contract it routes the anomaly through
 * `@repo/observability/log` (the Datadog-exported logger) BEFORE collapsing it.
 */
describe("buildBranchAnalytics — corrupt AI-spend totals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns with the org and the offending value when the total is negative", () => {
    const analytics = analyticsFor([session("s1", -12.5)]);

    expect(log.warn).toHaveBeenCalledWith(
      "branch_analytics_spend_total_invalid",
      {
        organizationId: ORGANIZATION_ID,
        totalSpendUsd: -12.5,
        branchCount: 1,
      }
    );
    // Still degrades gracefully — never a fabricated figure on the card.
    expect(analytics.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
    expect(analytics.totalSpendUsd.value).toBeNull();
  });

  it("warns when the total is non-finite", () => {
    const analytics = analyticsFor([
      session("s1", Number.POSITIVE_INFINITY),
      session("s2", 1),
    ]);

    expect(log.warn).toHaveBeenCalledWith(
      "branch_analytics_spend_total_invalid",
      expect.objectContaining({ organizationId: ORGANIZATION_ID })
    );
    expect(analytics.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
  });

  it("stays silent for a priced total of exactly zero — unreportable, not corrupt", () => {
    const analytics = analyticsFor([session("s1", 0)]);

    expect(log.warn).not.toHaveBeenCalled();
    // The ISS-4737 rule itself still holds: zero is "no usable figure", not `$0`.
    expect(analytics.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
  });

  it("stays silent for an ordinary positive total and reports it", () => {
    const analytics = analyticsFor([session("s1", 4.25)]);

    expect(log.warn).not.toHaveBeenCalled();
    expect(analytics.totalSpendUsd.state).toBe(BranchKpiState.Available);
    expect(analytics.totalSpendUsd.value).toBe(4.25);
  });

  it("ignores usage outside the selected metric cohort", () => {
    const analytics = buildBranchAnalytics({
      organizationId: ORGANIZATION_ID,
      metrics: [metric("branch-1")],
      usageByBranch: new Map([
        ["branch-1", usage([session("selected", 4.25)])],
        ["branch-2", usage([session("outside", 100)])],
      ]),
      lifetimeUsageByBranch: new Map(),
    });

    expect(analytics.totalSpendUsd.value).toBe(4.25);
  });
});
