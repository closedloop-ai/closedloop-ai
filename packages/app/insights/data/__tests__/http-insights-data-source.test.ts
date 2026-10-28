import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { describe, expect, it, vi } from "vitest";
import {
  createHttpInsightsReads,
  createHttpSessionMeshInsightsRead,
  insightsPath,
} from "../http-insights-data-source";

describe("insightsPath", () => {
  it("builds the /insights/{section} path with period and scope", () => {
    const path = insightsPath(
      "delivery",
      InsightsPeriod.Month,
      InsightsScope.Me
    );

    expect(path.startsWith("/insights/delivery?period=30&scope=me")).toBe(true);
  });

  it("includes the teamId when provided", () => {
    const path = insightsPath(
      "utilization",
      InsightsPeriod.Quarter,
      InsightsScope.Team,
      "team-1"
    );

    expect(path).toContain("/insights/utilization?");
    expect(path).toContain("period=90");
    expect(path).toContain("scope=team");
    expect(path).toContain("teamId=team-1");
  });

  it("omits the teamId when absent", () => {
    const path = insightsPath("agents", InsightsPeriod.Week, InsightsScope.Org);

    expect(path).not.toContain("teamId");
  });
});

describe("createHttpSessionMeshInsightsRead", () => {
  it("uses the selected personal scope, period, and optional user identity", async () => {
    const get = vi.fn().mockResolvedValue({});
    await createHttpSessionMeshInsightsRead({ get }).getSessionMeshInsights(
      "me",
      "30",
      "user-1"
    );
    expect(get).toHaveBeenCalledWith(
      "/session-mesh/insights?period=30&scope=me&userId=user-1"
    );
  });

  it("uses organization scope without leaking a personal user id", async () => {
    const get = vi.fn().mockResolvedValue({});
    await createHttpSessionMeshInsightsRead({ get }).getSessionMeshInsights(
      "org",
      "90",
      "user-1"
    );
    expect(get).toHaveBeenCalledWith(
      "/session-mesh/insights?period=90&scope=org"
    );
  });
});

describe("createHttpInsightsReads", () => {
  it("routes each section getter through api.get with the section path and scope", async () => {
    const get = vi.fn().mockResolvedValue({ kpis: [], charts: {} });
    const reads = createHttpInsightsReads({ get });

    await reads.getDelivery(InsightsPeriod.Month, InsightsScope.Me);
    await reads.getUtilization(InsightsPeriod.Month, InsightsScope.Org);
    await reads.getAgents(InsightsPeriod.Month, InsightsScope.Team, "team-1");

    expect(get).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/insights/delivery?period=30&scope=me")
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/insights/utilization?period=30&scope=org")
    );
    expect(get).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/insights/agents?period=30&scope=team")
    );
    expect(get.mock.calls[2]?.[0]).toContain("teamId=team-1");
  });
});
