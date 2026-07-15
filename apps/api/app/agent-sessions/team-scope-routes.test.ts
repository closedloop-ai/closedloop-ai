import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  isAgentMonitoringEnabledForUser: vi.fn(),
  isMember: vi.fn(),
  isOrgAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    findById: mocks.findById,
    isMember: mocks.isMember,
  },
}));

vi.mock("@/lib/agent-session-sync-feature", () => ({
  isAgentMonitoringEnabledForUser: mocks.isAgentMonitoringEnabledForUser,
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("./service", () => ({
  agentSessionsService: {
    findExportRows: vi.fn(),
    findSessions: vi.fn(),
    getAnalytics: vi.fn(),
    getUsageSummary: vi.fn(),
  },
}));

import { GET as getAnalytics } from "./analytics/route";
import { GET as getExport } from "./export/route";
import { GET as getList } from "./route";
import { agentSessionsService } from "./service";
import { GET as getUsage } from "./usage/route";

const TEAM_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const INVALID_TEAM_ID = "not-a-uuid";

const ROUTES = [
  {
    name: "list",
    handler: getList,
    path: "/agent-sessions",
    service: () => agentSessionsService.findSessions,
  },
  {
    name: "usage",
    handler: getUsage,
    path: "/agent-sessions/usage",
    service: () => agentSessionsService.getUsageSummary,
  },
  {
    name: "analytics",
    handler: getAnalytics,
    path: "/agent-sessions/analytics",
    service: () => agentSessionsService.getAnalytics,
  },
  {
    name: "export",
    handler: getExport,
    path: "/agent-sessions/export",
    service: () => agentSessionsService.findExportRows,
  },
] as const;

describe("agent-session team-scope route boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mocks.findById.mockResolvedValue({ id: TEAM_ID });
    mocks.isAgentMonitoringEnabledForUser.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.isOrgAdmin.mockResolvedValue(false);
    vi.mocked(agentSessionsService.getUsageSummary).mockResolvedValue({
      apiEstimatedCost: 0,
      byHarness: [],
      byModel: [],
      byRepository: [],
      byUser: [],
      earliestSessionAt: null,
      latestSessionAt: null,
      lastSyncTargets: [],
      subscriptionEstimatedCost: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalSessions: 0,
      viewerScope: AgentSessionViewerScope.Team,
    });
    vi.mocked(agentSessionsService.getAnalytics).mockResolvedValue({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Team,
    });
    vi.mocked(agentSessionsService.findExportRows).mockResolvedValue({
      orgSlug: "org",
      rows: [],
    });
    vi.mocked(agentSessionsService.findSessions).mockResolvedValue({
      items: [],
      total: 0,
      viewerScope: AgentSessionViewerScope.Team,
    });
  });

  it.each(
    ROUTES
  )("rejects explicit team scope without teamId before $name side effects", async ({
    handler,
    path,
    service,
  }) => {
    const response = await handler(
      request(`${path}?viewerScope=${AgentSessionViewerScope.Team}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.isAgentMonitoringEnabledForUser).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(service()).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("rejects invalid teamId before $name service access", async ({
    handler,
    path,
    service,
  }) => {
    const response = await handler(
      request(
        `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${INVALID_TEAM_ID}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.isAgentMonitoringEnabledForUser).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(service()).not.toHaveBeenCalled();
  });

  it.each(
    ROUTES
  )("rejects non-team scope combined with teamId before $name side effects", async ({
    handler,
    path,
    service,
  }) => {
    const response = await handler(
      request(
        `${path}?viewerScope=${AgentSessionViewerScope.Organization}&teamId=${TEAM_ID}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.isAgentMonitoringEnabledForUser).not.toHaveBeenCalled();
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(service()).not.toHaveBeenCalled();
  });

  it.each(
    ROUTES
  )("allows team member scoped $name requests before service access", async ({
    handler,
    path,
    service,
  }) => {
    const response = await handler(
      request(
        `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.findById).toHaveBeenCalledWith(
      TEAM_ID,
      mockAuthContext.user.organizationId
    );
    expect(mocks.isMember).toHaveBeenCalledWith(
      TEAM_ID,
      mockAuthContext.user.id
    );
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(service()).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      filters: expect.objectContaining({
        teamId: TEAM_ID,
        viewerScope: AgentSessionViewerScope.Team,
      }),
    });
  });

  it.each(
    ROUTES
  )("allows org admin scoped $name requests when not a team member", async ({
    handler,
    path,
    service,
  }) => {
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.isOrgAdmin.mockResolvedValueOnce(true);

    const response = await handler(
      request(
        `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.isOrgAdmin).toHaveBeenCalledWith(
      mockAuthContext.clerkOrgId,
      mockAuthContext.clerkUserId
    );
    expect(service()).toHaveBeenCalled();
  });

  it.each(
    ROUTES
  )("applies team policy to legacy bare teamId $name requests", async ({
    handler,
    path,
    service,
  }) => {
    const response = await handler(
      request(`${path}?teamId=${TEAM_ID}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(mocks.findById).toHaveBeenCalledWith(
      TEAM_ID,
      mockAuthContext.user.organizationId
    );
    expect(service()).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      filters: expect.objectContaining({ teamId: TEAM_ID }),
    });
  });

  it.each(
    ROUTES
  )("rejects disabled monitoring before $name service access", async ({
    handler,
    path,
    service,
  }) => {
    mocks.isAgentMonitoringEnabledForUser.mockResolvedValueOnce(false);

    const response = await handler(
      request(
        `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(service()).not.toHaveBeenCalled();
    expect(csvResponseContentType(response, path)).not.toContain("text/csv");
  });

  it.each(
    ROUTES
  )("rejects foreign team $name requests before service access", async ({
    handler,
    path,
    service,
  }) => {
    mocks.findById.mockResolvedValueOnce(null);

    const response = await handler(
      request(
        `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
    expect(mocks.isMember).not.toHaveBeenCalled();
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(service()).not.toHaveBeenCalled();
    expect(csvResponseContentType(response, path)).not.toContain("text/csv");
  });

  it.each(
    ROUTES
  )("rejects non-member $name requests before service access", async ({
    handler,
    path,
    service,
  }) => {
    mocks.isMember.mockResolvedValueOnce(false);
    mocks.isOrgAdmin.mockResolvedValueOnce(false);

    const response = await handler(
      request(
        `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
      ),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
    expect(service()).not.toHaveBeenCalled();
    expect(csvResponseContentType(response, path)).not.toContain("text/csv");
  });

  it.each(
    ROUTES
  )("rejects legacy bare foreign-team $name requests before service access", async ({
    handler,
    path,
    service,
  }) => {
    mocks.findById.mockResolvedValueOnce(null);

    const response = await handler(
      request(`${path}?teamId=${TEAM_ID}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
    expect(service()).not.toHaveBeenCalled();
    expect(csvResponseContentType(response, path)).not.toContain("text/csv");
  });
});

function request(path: string) {
  return createMockRequest({
    url: `http://localhost:3002${path}`,
  });
}

function csvResponseContentType(response: Response, path: string): string {
  if (!path.includes("/export")) {
    return "";
  }

  return response.headers.get("content-type") ?? "";
}
