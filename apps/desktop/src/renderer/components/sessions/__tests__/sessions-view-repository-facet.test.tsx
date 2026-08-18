import {
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionRepositoryBreakdown } from "@repo/api/src/types/agent-session-usage-breakdown";
import { describe, expect, it } from "vitest";
import {
  buildSessionsRenderModel,
  needsAnalyticsRepositoryFallback,
} from "../sessions-render-model";

// FEA-4299: usage OWNS the Repository filter facet. Both desktop usage paths now
// carry a `byRepository` rollup, so the renderer must NOT let the analytics
// breakdown (`repositoryBreakdown`) clobber a populated usage-owned facet —
// including when analytics returns an empty array from its catch fallback
// (shafty023). Analytics is only a legacy fallback for a usage summary that
// reports no repositories at all.

function repo(
  repositoryFullName: string,
  sessionCount: number
): AgentSessionRepositoryBreakdown {
  return {
    repositoryFullName,
    sessionCount,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    errorCount: 0,
  };
}

function usageSummary(
  byRepository: AgentSessionRepositoryBreakdown[]
): AgentSessionUsageSummary {
  return {
    viewerScope: AgentSessionViewerScope.Self,
    totalSessions: 0,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 0,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository,
    lastSyncTargets: [],
  };
}

function repoNames(
  model: ReturnType<typeof buildSessionsRenderModel>
): string[] {
  return (model.usage?.byRepository ?? [])
    .map((entry) => entry.repositoryFullName)
    .sort();
}

describe("buildSessionsRenderModel Repository facet ownership (FEA-4299)", () => {
  const emptySessionsData = { items: [], total: 0 } as never;

  it("keeps the usage-owned repositories when analytics returns an empty array", () => {
    const model = buildSessionsRenderModel({
      displayState: "ready",
      sessionsData: emptySessionsData,
      facetUsage: usageSummary([
        repo("acme/widgets", 3),
        repo("acme/gadgets", 1),
      ]),
      // The aggregateAnalytics catch fallback yields [] — it must NOT clobber.
      repositoryBreakdown: [],
    });

    expect(repoNames(model)).toEqual(["acme/gadgets", "acme/widgets"]);
  });

  it("keeps the usage-owned repositories over a populated analytics breakdown", () => {
    const model = buildSessionsRenderModel({
      displayState: "ready",
      sessionsData: emptySessionsData,
      facetUsage: usageSummary([repo("acme/widgets", 2)]),
      repositoryBreakdown: [repo("stale/other", 9)],
    });

    expect(repoNames(model)).toEqual(["acme/widgets"]);
  });

  it("falls back to the analytics breakdown only when usage reports no repositories", () => {
    const model = buildSessionsRenderModel({
      displayState: "ready",
      sessionsData: emptySessionsData,
      facetUsage: usageSummary([]),
      repositoryBreakdown: [repo("legacy/repo", 4)],
    });

    expect(repoNames(model)).toEqual(["legacy/repo"]);
  });

  it("drops the analytics breakdown entirely when there is no usage summary to fold it into", () => {
    // ISS-5273: the no-usage state is the third place the breakdown is discarded
    // — `usage` collapses to undefined, so a populated analytics read buys the
    // facet nothing. This is why the read gate below treats it as "not needed".
    const model = buildSessionsRenderModel({
      displayState: "ready",
      sessionsData: emptySessionsData,
      facetUsage: undefined,
      repositoryBreakdown: [repo("legacy/repo", 4)],
    });

    expect(model.usage).toBeUndefined();
  });
});

describe("needsAnalyticsRepositoryFallback (ISS-5273)", () => {
  const emptySessionsData = { items: [], total: 0 } as never;

  it("is false when usage owns repositories, matching the fold that ignores the breakdown", () => {
    const facetUsage = usageSummary([repo("acme/widgets", 3)]);

    expect(needsAnalyticsRepositoryFallback(facetUsage)).toBe(false);

    // The gate and the fold must agree: with the gate false the analytics read is
    // never issued, so prove the fold genuinely ignores a breakdown in this state
    // rather than silently losing an option the user needed.
    const model = buildSessionsRenderModel({
      displayState: "ready",
      sessionsData: emptySessionsData,
      facetUsage,
      repositoryBreakdown: undefined,
    });
    expect(repoNames(model)).toEqual(["acme/widgets"]);
  });

  it("is false when there is no usage summary at all", () => {
    expect(needsAnalyticsRepositoryFallback(undefined)).toBe(false);
  });

  it("is true only when usage is present and reports no repositories", () => {
    expect(needsAnalyticsRepositoryFallback(usageSummary([]))).toBe(true);
  });
});
