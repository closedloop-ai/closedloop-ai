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

      // Self scope adds `createdById = <viewerId>` (Created by, ISS-12251 D-4)
      // to the org-scoped where, so a Me read returns only the sessions the
      // viewer created — never org-wide rows.
      const expectedWhere = {
        artifact: { is: { organizationId: "org-1", createdById: "viewer-1" } },
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

      // ISS-12251: the deep link is dropped, and the Owner facet still ANDs on
      // the assignee — "my sessions that these people own", never theirs.
      expect(findMany.mock.calls[0]?.[0].where).toEqual({
        artifact: {
          is: {
            organizationId: "org-1",
            assigneeId: { in: ["other-a", "other-b"] },
            createdById: "viewer-1",
          },
        },
      });
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

      const where = findMany.mock.calls[0]?.[0].where as {
        artifact?: { is?: { createdById?: unknown } };
      };
      expect(where.artifact?.is?.createdById).toEqual({ in: [] });
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
  describe("FEA-4304 / ISS-12251: the scoped userId and the Owner facet both match the assignee, and AND", () => {
    // Operator ruling (Kerensa Whitlock, 2026-10-13): "If the UI says owner, it should
    // filter by owner. The owner is the assignee." The singular `userId` deep
    // link renders inside the Owner filter group, so it matches the assignee.
    it("intersects the scoped userId with the Owner facet, so a facet naming other people matches nothing", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        // Fixed cross-surface scope = sessions user-2 owns; the Owner facet asks
        // for sessions OTHER people own. Both hold: the facet cannot widen the scope.
        filters: {
          userId: "user-2",
          userIds: ["user-9", "user-10"],
          quality: "all",
        },
      });

      const expectedWhere = {
        artifact: {
          is: {
            organizationId: "org-1",
            assigneeId: { in: ["user-9", "user-10"], equals: "user-2" },
          },
        },
      };
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
      expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it("scopes the singular userId deep link alone to the assignee, never Created by or the recorder", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({
        sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      });

      await agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: { userId: "user-2", quality: "all" },
      });

      const expectedWhere = {
        artifact: {
          is: { organizationId: "org-1", assigneeId: { equals: "user-2" } },
        },
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
        artifact: {
          is: {
            organizationId: "org-1",
            assigneeId: { in: ["user-9", "user-10"] },
          },
        },
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
        artifact: {
          is: {
            organizationId: "org-1",
            assigneeId: { in: ["user-9", "user-10"], equals: "user-2" },
          },
        },
      };
      expect(aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere })
      );
    });
  });
});
