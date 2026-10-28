import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  existsInOrganization: vi.fn(),
  isMember: vi.fn(),
  getOrgAdminStatus: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: {
    existsInOrganization: mocks.existsInOrganization,
    isMember: mocks.isMember,
  },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

vi.mock("./service", () => ({
  agentSessionsService: {
    findExportRows: vi.fn(),
    findSessions: vi.fn(),
    getAnalytics: vi.fn(),
    getUsageSummary: vi.fn(),
  },
}));

// ISS-8858: the counts route reaches its service module DIRECTLY rather than
// through `./service`, because that barrel imports `projections.ts` — the row
// projection the counts path exists to never pay for. So it needs its own mock.
vi.mock("./service/status-counts", () => ({
  buildAgentSessionStatusCounts: vi.fn(),
}));

import {
  ORG_ADMIN_STATUS_ADMIN,
  ORG_ADMIN_STATUS_NOT_ADMIN,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { GET as getAnalytics } from "./analytics/route";
import { GET as getExport } from "./export/route";
import { GET as getList } from "./route";
import { agentSessionsService } from "./service";
import { buildAgentSessionStatusCounts } from "./service/status-counts";
import { GET as getStatusCounts } from "./status-counts/route";
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
  {
    // ISS-8858: the counts read walks the SAME population as the four above, so
    // it has to refuse a team scope on the same terms. A faster read that skips
    // the RBAC gate is the same leak as one that skips the org predicate.
    name: "status counts",
    handler: getStatusCounts,
    path: "/agent-sessions/status-counts",
    service: () => buildAgentSessionStatusCounts,
  },
] as const;

/**
 * Inputs one route resolves and passes on that its siblings do not. Spread into
 * the exact-shape assertions below rather than elided, so a route that stopped
 * passing one — or started passing an input nobody asked for — reddens.
 */
function extraServiceInputFor(
  name: (typeof ROUTES)[number]["name"]
): Record<string, unknown> {
  if (name === "list") {
    return {
      // ISS-8712: the tag capabilities the list projection needs.
      tagPermissions: { canApply: true, canRemove: true },
      // D5 resolves the Status flag for the authenticated Clerk identity.
      clerkUserId: mockAuthContext.clerkUserId,
    };
  }
  return {};
}

/**
 * ISS-11117: trailing ARGUMENTS a route passes its service beyond the input
 * object, in positional order.
 *
 * The usage route now hands `getUsageSummary` a second argument — the Pensero
 * points reader it binds to this principal — so the exact-shape assertions
 * below take it as well. Kept alongside {@link extraServiceInputFor} rather
 * than relaxed into `expect.anything()`: an argument the route stopped passing
 * must still redden.
 *
 * `undefined` HERE, and that is the assertion rather than a weakening: every
 * case in this file is TEAM-scoped, and a team narrows the session population
 * without narrowing the branch-lifetime points numerator, so the route
 * withholds the reader (`pensero-population-alignment.ts`). Both arms of that
 * choice are pinned by `usage-route-pensero-gate.test.ts`; this file pins only
 * that the argument is still passed positionally.
 */
function extraServiceArgsFor(name: (typeof ROUTES)[number]["name"]): unknown[] {
  return name === "usage" ? [undefined] : [];
}

describe("agent-session team-scope route boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mocks.existsInOrganization.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
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

  it.each(ROUTES)(
    "rejects explicit team scope without teamId before $name side effects",
    async ({ handler, path, service }) => {
      const response = await handler(
        request(`${path}?viewerScope=${AgentSessionViewerScope.Team}`),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      expect(mocks.existsInOrganization).not.toHaveBeenCalled();
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "rejects invalid teamId before $name service access",
    async ({ handler, path, service }) => {
      const response = await handler(
        request(
          `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${INVALID_TEAM_ID}`
        ),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      expect(mocks.existsInOrganization).not.toHaveBeenCalled();
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "rejects non-team scope combined with teamId before $name side effects",
    async ({ handler, path, service }) => {
      const response = await handler(
        request(
          `${path}?viewerScope=${AgentSessionViewerScope.Organization}&teamId=${TEAM_ID}`
        ),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      expect(mocks.existsInOrganization).not.toHaveBeenCalled();
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "allows team member scoped $name requests before service access",
    async ({ handler, path, name, service }) => {
      const response = await handler(
        request(
          `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
        ),
        createMockRouteContext({})
      );

      expect(response.status).toBe(200);
      expect(mocks.existsInOrganization).toHaveBeenCalledWith(
        TEAM_ID,
        mockAuthContext.user.organizationId
      );
      expect(mocks.isMember).toHaveBeenCalledWith(
        TEAM_ID,
        mockAuthContext.user.id
      );
      expect(mocks.getOrgAdminStatus).not.toHaveBeenCalled();
      expect(service()).toHaveBeenCalledWith(
        {
          ...extraServiceInputFor(name),
          organizationId: mockAuthContext.user.organizationId,
          viewerId: mockAuthContext.user.id,
          filters: expect.objectContaining({
            teamId: TEAM_ID,
            viewerScope: AgentSessionViewerScope.Team,
          }),
        },
        ...extraServiceArgsFor(name)
      );
    }
  );

  it.each(ROUTES)(
    "allows org admin scoped $name requests when not a team member",
    async ({ handler, path, name, service }) => {
      mocks.isMember.mockResolvedValueOnce(false);
      mocks.getOrgAdminStatus.mockResolvedValueOnce(ORG_ADMIN_STATUS_ADMIN);

      const response = await handler(
        request(
          `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
        ),
        createMockRouteContext({})
      );

      expect(response.status).toBe(200);
      expect(mocks.getOrgAdminStatus).toHaveBeenCalledWith(
        mockAuthContext.clerkOrgId,
        mockAuthContext.clerkUserId
      );
      // ISS-7555: the org-admin branch is the only allow path for a NON-member, so
      // this is the only pin on the filter shape an admin's team-scoped read
      // produces. `authorizeAgentSessionTeamScope` answers with a verdict and never
      // rewrites `filters`, so an admin must reach the service with the same team
      // scope a member does — a bare `toHaveBeenCalled()` stays green if it widens.
      expect(service()).toHaveBeenCalledWith(
        {
          ...extraServiceInputFor(name),
          organizationId: mockAuthContext.user.organizationId,
          viewerId: mockAuthContext.user.id,
          filters: expect.objectContaining({
            teamId: TEAM_ID,
            viewerScope: AgentSessionViewerScope.Team,
          }),
        },
        ...extraServiceArgsFor(name)
      );
    }
  );

  it.each(ROUTES)(
    "applies team policy to legacy bare teamId $name requests",
    async ({ handler, path, name, service }) => {
      const response = await handler(
        request(`${path}?teamId=${TEAM_ID}`),
        createMockRouteContext({})
      );

      expect(response.status).toBe(200);
      expect(mocks.existsInOrganization).toHaveBeenCalledWith(
        TEAM_ID,
        mockAuthContext.user.organizationId
      );
      expect(service()).toHaveBeenCalledWith(
        {
          ...extraServiceInputFor(name),
          organizationId: mockAuthContext.user.organizationId,
          viewerId: mockAuthContext.user.id,
          // ISS-7555: `viewerScope` is the OUTPUT of `applyLegacyTeamIdScope` — a
          // bare `teamId` carries no scope on the wire, so pinning it here is what
          // proves the legacy normalization survives end to end through the route.
          filters: expect.objectContaining({
            teamId: TEAM_ID,
            viewerScope: AgentSessionViewerScope.Team,
          }),
        },
        ...extraServiceArgsFor(name)
      );
    }
  );

  // FEA-4155 (whitlockk review #3789): the winding-down `DESKTOP_AGENT_SESSION_SYNC`
  // monitoring gate is gone from the sessions read path — including the
  // team-scope authorization, which used to fail closed on that flag. A valid
  // in-team request must now resolve on team-membership RBAC alone and never
  // 403 as the flag winds down. (Cross-org/foreign-team/non-member RBAC still
  // 403s — proven by the cases below.)
  it.each(ROUTES)(
    "resolves an in-team $name request with no monitoring-flag gate (FEA-4155)",
    async ({ handler, path, service }) => {
      const response = await handler(
        request(
          `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
        ),
        createMockRouteContext({})
      );

      expect(response.status).toBe(200);
      expect(mocks.existsInOrganization).toHaveBeenCalledWith(
        TEAM_ID,
        mockAuthContext.user.organizationId
      );
      expect(service()).toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "rejects foreign team $name requests before service access",
    async ({ handler, path, service }) => {
      mocks.existsInOrganization.mockResolvedValueOnce(false);

      const response = await handler(
        request(
          `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
        ),
        createMockRouteContext({})
      );

      expect(response.status).toBe(403);
      expect(mocks.isMember).not.toHaveBeenCalled();
      expect(mocks.getOrgAdminStatus).not.toHaveBeenCalled();
      expect(service()).not.toHaveBeenCalled();
      expect(csvResponseContentType(response, path)).not.toContain("text/csv");
    }
  );

  it.each(ROUTES)(
    "rejects non-member $name requests before service access",
    async ({ handler, path, service }) => {
      mocks.isMember.mockResolvedValueOnce(false);
      mocks.getOrgAdminStatus.mockResolvedValueOnce(ORG_ADMIN_STATUS_NOT_ADMIN);

      const response = await handler(
        request(
          `${path}?viewerScope=${AgentSessionViewerScope.Team}&teamId=${TEAM_ID}`
        ),
        createMockRouteContext({})
      );

      expect(response.status).toBe(403);
      expect(service()).not.toHaveBeenCalled();
      expect(csvResponseContentType(response, path)).not.toContain("text/csv");
    }
  );

  it.each(ROUTES)(
    "rejects legacy bare foreign-team $name requests before service access",
    async ({ handler, path, service }) => {
      mocks.existsInOrganization.mockResolvedValueOnce(false);

      const response = await handler(
        request(`${path}?teamId=${TEAM_ID}`),
        createMockRouteContext({})
      );

      expect(response.status).toBe(403);
      expect(service()).not.toHaveBeenCalled();
      expect(csvResponseContentType(response, path)).not.toContain("text/csv");
    }
  );
});

/**
 * davetho, PR #6485: the counts route's refusal of a status filter is a ROUTE
 * boundary, and until now only the validator's refinement was covered.
 *
 * The refinement matters because `buildAgentSessionStatusCounts` CLEARS `status`
 * and `statuses` before it builds anything — so if the refinement is removed or
 * bypassed, a request naming a status does not fail and does not filter either:
 * it returns 200 with every bucket counted over the unfiltered population, which
 * is a wrong answer wearing a success code. These cases exercise the route, not
 * the schema, and assert the service is never reached.
 */
describe("agent-session status-counts rejects a status filter (PR #6485)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mocks.existsInOrganization.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
  });

  it.each([
    { name: "the single-value back-compat param", query: "status=active" },
    {
      name: "the repeated multi-select param",
      query: "statuses=active&statuses=waiting",
    },
  ])("refuses $name with a 400 and no service call", async ({ query }) => {
    const response = await getStatusCounts(
      request(`/agent-sessions/status-counts?${query}`),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(buildAgentSessionStatusCounts).not.toHaveBeenCalled();
  });

  it("still answers when no status filter is present", async () => {
    // The refusals above are only meaningful against a route that otherwise
    // succeeds — without this, deleting the handler body would pass them both.
    // ISS-10364 retired the waiting/stale/unknown buckets this mock used to
    // also carry.
    vi.mocked(buildAgentSessionStatusCounts).mockResolvedValue({
      countsByStatus: {
        [SESSION_STATUS.ACTIVE]: 0,
        [SESSION_STATUS.INACTIVE]: 0,
        [SESSION_STATUS.ERROR]: 0,
      },
      total: 0,
    });

    const response = await getStatusCounts(
      request("/agent-sessions/status-counts?quality=all"),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(buildAgentSessionStatusCounts).toHaveBeenCalledTimes(1);
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
