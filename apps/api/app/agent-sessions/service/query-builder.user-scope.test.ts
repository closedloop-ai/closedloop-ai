import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
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

// Viewer/user-scope enforcement for the shared query-builder seam: how a
// self-scoped read and a fixed cross-surface scoped userId constrain the
// predicate so one user can never read another user's sessions. Split out of
// query-builder.test.ts to keep each file under the size ceiling.
describe("agentSessionsService user-scope enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("FEA-3534 viewerScope=self enforcement", () => {
    it("pins the session list to the authenticated viewer when scope is self", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        viewerId: "viewer-1",
        filters: { viewerScope: AgentSessionViewerScope.Self, quality: "all" },
      });

      // Self scope adds `userId = <viewerId>` to the org-scoped where, so a Me
      // read returns only the viewer's own sessions — never org-wide rows.
      const expectedWhere = {
        artifact: { is: { organizationId: "org-1" } },
        userId: "viewer-1",
      };
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
      expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it("overrides a client-sent userId filter with the authenticated viewer under self scope", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        viewerId: "viewer-1",
        // A forged/dropped userId cannot widen or redirect a self read: server
        // enforcement wins over the client-trusted param.
        filters: {
          viewerScope: AgentSessionViewerScope.Self,
          userId: "someone-else",
          userIds: ["other-a", "other-b"],
          quality: "all",
        },
      });

      const where = findMany.mock.calls[0]?.[0].where as { userId?: unknown };
      expect(where.userId).toBe("viewer-1");
    });

    it("fails closed to an impossible predicate when self scope has no resolved viewer", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        // No viewerId (defensive path): a self read must never leak org-wide.
        filters: { viewerScope: AgentSessionViewerScope.Self, quality: "all" },
      });

      const where = findMany.mock.calls[0]?.[0].where as { userId?: unknown };
      expect(where.userId).toEqual({ in: [] });
    });

    it("keeps org scope org-wide (no user predicate) even with a viewer present", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        viewerId: "viewer-1",
        filters: {
          viewerScope: AgentSessionViewerScope.Organization,
          quality: "all",
        },
      });

      // Org scope must not narrow to the viewer — it stays the bare org scope.
      const expectedWhere = {
        artifact: { is: { organizationId: "org-1" } },
      };
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
      expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    });
  });
  describe("FEA-4304 scoped userId is an AND constraint the Owner facet can't widen", () => {
    it("keeps ONLY the scoped user when the Owner facet carries a DIFFERENT user (no silent widening)", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        // Fixed cross-surface scope = user-2; a stale/crafted Owner facet asks for
        // OTHER users. The facet must not widen past the scope — the scoped user
        // is not in the facet, so the intersection is empty (never other users).
        filters: {
          userId: "user-2",
          userIds: ["user-9", "user-10"],
          quality: "all",
        },
      });

      const expectedWhere = {
        artifact: { is: { organizationId: "org-1" } },
        // Empty `in`: matches no rows rather than honoring the wider facet — the
        // scoped user is never violated, and another user's sessions never leak.
        userId: { in: [] },
      };
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
      expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it("narrows to the scoped user when the Owner facet is a superset containing it", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        // Scope = user-2; the Owner facet includes user-2 plus others. AND
        // collapses the intersection to exactly the scoped user.
        filters: {
          userId: "user-2",
          userIds: ["user-2", "user-9"],
          quality: "all",
        },
      });

      const expectedWhere = {
        artifact: { is: { organizationId: "org-1" } },
        userId: "user-2",
      };
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
      expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it("lets the Owner facet stand alone (an `in` set) when no scoped userId is present", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        // No fixed scope: the multi-select Owner facet selects a cohort directly.
        filters: { userIds: ["user-9", "user-10"], quality: "all" },
      });

      const expectedWhere = {
        artifact: { is: { organizationId: "org-1" } },
        userId: { in: ["user-9", "user-10"] },
      };
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
      expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it("enforces the SAME AND constraint on the usage summary read (list/summary SSOT)", async () => {
      // The summary read resolves the predicate through the SAME buildWhere seam
      // as the list, so a scoped userId must be an AND constraint there too — the
      // totals can never aggregate another user's sessions under a false scope.
      const aggregate = vi.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          estimatedCost: null,
        },
        _min: { sessionStartedAt: null },
        _max: { sessionStartedAt: null },
      });
      const groupBy = vi.fn().mockResolvedValue([]);
      const tokenGroupBy = vi.fn().mockResolvedValue([]);
      const tokenFindMany = vi.fn().mockResolvedValue([]);
      const computeTargetFindMany = vi.fn().mockResolvedValue([]);

      installDb({
        sessionDetail: buildAgentSessionDbMock({ aggregate, groupBy }),
        agentSessionTokenUsage: {
          groupBy: tokenGroupBy,
          findMany: tokenFindMany,
        },
        computeTarget: { findMany: computeTargetFindMany },
      });

      await agentSessionsService.getUsageSummary({
        organizationId: "org-1",
        filters: {
          userId: "user-2",
          userIds: ["user-9", "user-10"],
          quality: "all",
        },
      });

      const expectedWhere = {
        artifact: { is: { organizationId: "org-1" } },
        userId: { in: [] },
      };
      expect(aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
    });
  });
});
