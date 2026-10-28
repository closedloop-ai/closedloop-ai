import { AgentSessionUsageAttribution } from "@repo/api/src/types/agent-session-usage-attribution";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { aggregateSessionAttributionLenses } from "@/lib/agent-session-attribution";
import { readSessionAttributionBranchIds } from "@/lib/agent-session-attribution-read";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});
vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});
vi.mock("@/lib/agent-session-attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-session-attribution")>()),
  aggregateSessionAttributionLenses: vi.fn(),
}));
vi.mock("@/lib/agent-session-attribution-read", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/agent-session-attribution-read")
  >()),
  readSessionAttributionBranchIds: vi.fn(),
}));

const attribution = {
  byBranch: [
    {
      branchArtifactId: "branch-1",
      repositoryFullName: "acme/web",
      branchName: "feature",
      sessionCount: 10,
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    },
  ],
  byPr: [],
};

describe("usage attribution projection (ISS-11204)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aggregateSessionAttributionLenses).mockResolvedValue(attribution);
    vi.mocked(readSessionAttributionBranchIds).mockResolvedValue(["branch-1"]);
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 10 },
          _sum: {
            inputTokens: 100,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCost: 0,
          },
          _min: { sessionStartedAt: new Date("2026-09-01") },
          _max: { sessionStartedAt: new Date("2026-09-02") },
        }),
        groupBy: vi.fn().mockResolvedValue([]),
      }),
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });
  });

  it("keeps all totals and facets identical while skipping the unused corpus read", async () => {
    const full = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });
    expect(full.byBranch).toEqual(attribution.byBranch);
    expect(aggregateSessionAttributionLenses).toHaveBeenCalledOnce();
    vi.mocked(aggregateSessionAttributionLenses).mockClear();
    const listing = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { attribution: AgentSessionUsageAttribution.Omit },
    });
    // ISS-12284: no reader, so no attribution read of any kind.
    expect(aggregateSessionAttributionLenses).not.toHaveBeenCalled();
    expect(readSessionAttributionBranchIds).not.toHaveBeenCalled();
    const { byBranch: _byBranch, byPr: _byPr, ...expected } = full;
    expect(listing).toEqual(expected);
    expect(listing.totalSessions).toBe(10);
  });

  it("reads only the branch set for the Pensero reader, and still omits the lenses", async () => {
    // ISS-11117 x ISS-11204, PR #7863. The ONE client that sends
    // `attribution=omit` is the Sessions listing (`withUsageQuery`), which is
    // the surface the points card renders on, so the numerator still needs the
    // branch set. ISS-12284: it reads that set alone; the lenses it would
    // withhold are never hydrated.
    const readPensero = vi.fn().mockResolvedValue(4.2);

    const listing = await agentSessionsService.getUsageSummary(
      {
        organizationId: "org-1",
        filters: { attribution: AgentSessionUsageAttribution.Omit },
      },
      readPensero
    );

    expect(aggregateSessionAttributionLenses).not.toHaveBeenCalled();
    expect(readSessionAttributionBranchIds).toHaveBeenCalledOnce();
    expect(readPensero).toHaveBeenCalledWith(["branch-1"], expect.any(Number));
    expect(listing.penseroPointsPerDollar).toBe(4.2);
    // Absence paired with the presence above, on the same response: the lens is
    // read and still withheld from the payload.
    expect(listing.byBranch).toBeUndefined();
    expect(listing.byPr).toBeUndefined();
  });

  it("preserves explicit include for version-skewed consumers", async () => {
    const full = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { attribution: AgentSessionUsageAttribution.Include },
    });
    expect(full.byBranch).toEqual(attribution.byBranch);
    expect(aggregateSessionAttributionLenses).toHaveBeenCalledOnce();
  });

  it("takes the Pensero branch set from published lenses without a second read", async () => {
    const readPensero = vi.fn().mockResolvedValue(4.2);

    await agentSessionsService.getUsageSummary(
      { organizationId: "org-1", filters: {} },
      readPensero
    );

    expect(aggregateSessionAttributionLenses).toHaveBeenCalledOnce();
    expect(readSessionAttributionBranchIds).not.toHaveBeenCalled();
    expect(readPensero).toHaveBeenCalledWith(["branch-1"], expect.any(Number));
  });
});
