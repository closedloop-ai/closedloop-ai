// ISS-9477: the `listQuery` boundary for the five Sessions read routes. Proves
// the ROUTE wiring — `errorMetadata: listQueryRefusalMetadata` is actually
// passed to `parseQueryParams`, a refusal is a clean 400 with the refusal code
// and no service call, a valid expression reaches the service lowered to the
// same legacy filters a hand-written request would produce, and the mixing
// rule (ISS-9477 ruling) refuses a request naming both spellings of one axis.
// `list-query-lowering.test.ts` covers the lowering and refusal logic in
// isolation; this file covers only what changes at the HTTP boundary.
import {
  type AgentSessionListItem,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { AgentSessionUsageAttribution } from "@repo/api/src/types/agent-session-usage-attribution";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  ListFilterOperator,
  ListQueryRefusal,
  ListSortDirection,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  ListQueryExecution,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  getRequestListQueryLogFields,
  runWithRequestSpanAttribution,
} from "@/lib/observability/request-span-attribution";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  existsInOrganization: vi.fn(),
  isMember: vi.fn(),
  getOrgAdminStatus: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
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

// ISS-8858: the counts route reaches its service module directly, bypassing
// `./service` — see `team-scope-routes.test.ts` for why this needs its own mock.
vi.mock("./service/status-counts", () => ({
  buildAgentSessionStatusCounts: vi.fn(),
}));

import { GET as getAnalytics } from "./analytics/route";
import { GET as getExport } from "./export/route";
import { GET as getList } from "./route";
import { agentSessionsService } from "./service";
import { buildAgentSessionStatusCounts } from "./service/status-counts";
import { GET as getStatusCounts } from "./status-counts/route";
import { GET as getUsage } from "./usage/route";

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
    name: "status counts",
    handler: getStatusCounts,
    path: "/agent-sessions/status-counts",
    service: () => buildAgentSessionStatusCounts,
  },
] as const;

/** As in `team-scope-routes.test.ts`: the list route alone gets tag capabilities. */
function extraServiceInputFor(
  name: (typeof ROUTES)[number]["name"]
): Record<string, unknown> {
  return name === "list"
    ? { tagPermissions: { canApply: true, canRemove: true } }
    : {};
}

function request(path: string) {
  return createMockRequest({ url: `http://localhost:3002${path}` });
}

/** Builds a request URL carrying `listQuery` as its serialized JSON text, plus any legacy params. */
function withListQuery(
  path: string,
  expression: unknown,
  legacyParams?: Record<string, string>
): ReturnType<typeof request> {
  const params = new URLSearchParams(legacyParams);
  params.set(LIST_QUERY_EXPRESSION_PARAM, JSON.stringify(expression));
  return request(`${path}?${params.toString()}`);
}

type ErrorBody = {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
};

async function errorBodyOf(response: Response): Promise<ErrorBody> {
  return await response.json();
}

const UNSUPPORTED_VERSION_EXPRESSION = { version: 2 };
const CUSTOM_FIELD_EXPRESSION = {
  version: 1,
  filters: [
    {
      field: "customField:x",
      operator: ListFilterOperator.IsAnyOf,
      values: ["y"],
    },
  ],
};
const HARNESS_EXPRESSION = {
  version: 1,
  filters: [
    {
      field: SessionListField.Harness,
      operator: ListFilterOperator.IsAnyOf,
      values: ["claude"],
    },
  ],
};
const COST_SORT_EXPRESSION = {
  version: 1,
  sorts: [{ field: SessionListField.Cost, direction: ListSortDirection.Desc }],
};
const STATUS_CLAUSE_EXPRESSION = {
  version: 1,
  filters: [
    {
      field: SessionListField.Status,
      operator: ListFilterOperator.IsAnyOf,
      values: [SESSION_STATUS.ACTIVE],
    },
  ],
};

describe("agent-session listQuery route boundaries (ISS-9477)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mocks.existsInOrganization.mockResolvedValue(true);
    mocks.isMember.mockResolvedValue(true);
    mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: false });
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
      viewerScope: AgentSessionViewerScope.Organization,
    });
    vi.mocked(agentSessionsService.getAnalytics).mockResolvedValue({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Organization,
    });
    vi.mocked(agentSessionsService.findExportRows).mockResolvedValue({
      orgSlug: "org",
      rows: [],
    });
    vi.mocked(agentSessionsService.findSessions).mockResolvedValue({
      items: [],
      total: 0,
      viewerScope: AgentSessionViewerScope.Organization,
    });
    // ISS-10364 retired the waiting/stale/unknown buckets this mock used to
    // also carry (always null) — `AgentSessionStatusCounts` now has exactly
    // the three lifecycle keys.
    vi.mocked(buildAgentSessionStatusCounts).mockResolvedValue({
      countsByStatus: {
        [SESSION_STATUS.ACTIVE]: 0,
        [SESSION_STATUS.INACTIVE]: 0,
        [SESSION_STATUS.ERROR]: 0,
      },
      total: 0,
    });
  });

  it("DT-18: a successful HTTP list read preserves the producer's canonical page echo", async () => {
    vi.mocked(agentSessionsService.findSessions).mockResolvedValue({
      items: [],
      total: 9,
      viewerScope: AgentSessionViewerScope.Organization,
      pageInfo: {
        capability: AgentSessionListCapability.ServerPaginationV1,
        limit: 3,
        offset: 6,
      },
    });
    const response = await getList(
      request("/agent-sessions?limit=3&offset=6"),
      createMockRouteContext({})
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: expect.objectContaining({
        total: 9,
        pageInfo: {
          capability: AgentSessionListCapability.ServerPaginationV1,
          limit: 3,
          offset: 6,
        },
      }),
    });
  });

  it("ISS-9524: binds the list DTO read to each authenticated viewer and organization", async () => {
    const firstUser = createTestAuthContext().user;
    const secondUser = {
      ...firstUser,
      id: "second-user-id",
      organizationId: "second-org-id",
    };
    for (const user of [firstUser, secondUser]) {
      mockAuthContext = createTestAuthContext({ user });
      const response = await getList(
        request(
          `/agent-sessions?viewerScope=${AgentSessionViewerScope.Self}&statuses=${SESSION_STATUS.ACTIVE}`
        ),
        createMockRouteContext({})
      );
      expect(response.status).toBe(200);
      expect(agentSessionsService.findSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({
          organizationId: user.organizationId,
          viewerId: user.id,
          filters: expect.objectContaining({
            viewerScope: AgentSessionViewerScope.Self,
            statuses: [SESSION_STATUS.ACTIVE],
          }),
        })
      );
    }
    expect(agentSessionsService.findSessions).toHaveBeenCalledTimes(2);
  });

  it("PRD-721 AC-5 / DT-FS-14 records canonical source and returned population on the production list route", async () => {
    vi.mocked(agentSessionsService.findSessions).mockResolvedValue({
      items: [
        { id: "session-one" } as AgentSessionListItem,
        { id: "session-two" } as AgentSessionListItem,
      ],
      total: 17,
      viewerScope: AgentSessionViewerScope.Organization,
    });
    let fields: Record<string, string | number> = {};
    await runWithRequestSpanAttribution(async () => {
      const response = await getList(
        withListQuery("/agent-sessions", HARNESS_EXPRESSION),
        createMockRouteContext({})
      );
      expect(response.status).toBe(200);
      fields = getRequestListQueryLogFields();
    });

    expect(fields).toEqual({
      list_query_source: ListQuerySource.Canonical,
      list_query_matched_count: 17,
      list_query_result_count: 2,
    });
  });

  it("PRD-721 AC-5 / DT-FS-14 records a version-skew refusal without the serialized query", async () => {
    let fields: Record<string, string | number> = {};
    await runWithRequestSpanAttribution(async () => {
      const response = await getList(
        withListQuery("/agent-sessions", UNSUPPORTED_VERSION_EXPRESSION),
        createMockRouteContext({})
      );
      expect(response.status).toBe(400);
      fields = getRequestListQueryLogFields();
    });

    expect(fields).toEqual({
      list_query_source: ListQuerySource.Canonical,
      list_query_execution: ListQueryExecution.Refused,
      list_query_refusal: ListQueryRefusal.UnsupportedVersion,
    });
    expect(JSON.stringify(fields)).not.toContain(
      JSON.stringify(UNSUPPORTED_VERSION_EXPRESSION)
    );
  });

  it.each(ROUTES)(
    "refuses an unsupported expression version on $name with the wired refusal code",
    async ({ handler, path, service }) => {
      const response = await handler(
        withListQuery(path, UNSUPPORTED_VERSION_EXPRESSION),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      // Would stay a bare 400 with no `code` key if the route dropped
      // `errorMetadata: listQueryRefusalMetadata` from its `parseQueryParams` call.
      expect(await errorBodyOf(response)).toEqual({
        success: false,
        error: expect.any(String),
        code: ListQueryRefusal.UnsupportedVersion,
        details: {},
      });
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "refuses an unrecognized custom field on $name, naming the field",
    async ({ handler, path, service }) => {
      const response = await handler(
        withListQuery(path, CUSTOM_FIELD_EXPRESSION),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      expect(await errorBodyOf(response)).toEqual({
        success: false,
        error: expect.any(String),
        code: ListQueryRefusal.UnsupportedField,
        details: { field: "customField:x" },
      });
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "answers a plain Zod failure on $name with no refusal code or details",
    async ({ handler, path, service }) => {
      const response = await handler(
        request(`${path}?viewerScope=${AgentSessionViewerScope.Team}`),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      expect(await errorBodyOf(response)).toEqual({
        success: false,
        error: expect.any(String),
      });
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "reaches $name's service with a valid expression lowered to legacy filters",
    async ({ handler, path, name, service }) => {
      const response = await handler(
        withListQuery(path, HARNESS_EXPRESSION),
        createMockRouteContext({})
      );

      expect(response.status).toBe(200);
      expect(service()).toHaveBeenCalled();
      // Asserted on the FIRST argument rather than the whole call: this table
      // is about the lowered filters, and `getUsageSummary` also takes a
      // trailing Pensero reader (ISS-11117) that `toHaveBeenCalledWith` would
      // make every route in the table account for. Same matcher, same object.
      const [[callArgs]] = vi.mocked(service()).mock.calls;
      expect(callArgs).toEqual(
        expect.objectContaining({
          ...extraServiceInputFor(name),
          organizationId: mockAuthContext.user.organizationId,
          viewerId: mockAuthContext.user.id,
          filters: expect.objectContaining({ harnesses: ["claude"] }),
        })
      );
      expect(callArgs.filters).not.toHaveProperty(LIST_QUERY_EXPRESSION_PARAM);
    }
  );

  it.each(ROUTES)(
    "refuses listQuery mixed with a facet's own legacy param on $name",
    async ({ handler, path, service }) => {
      const response = await handler(
        withListQuery(path, HARNESS_EXPRESSION, {
          statuses: SESSION_STATUS.ACTIVE,
        }),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      const body = await errorBodyOf(response);
      expect(body.code).toBe(ListQueryRefusal.Malformed);
      expect(body.details).toEqual({ field: SessionListField.Status });
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)(
    "refuses listQuery mixed with the legacy sort param on $name",
    async ({ handler, path, service }) => {
      const response = await handler(
        withListQuery(path, HARNESS_EXPRESSION, {
          sortBy: SessionListField.Cost,
        }),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      const body = await errorBodyOf(response);
      expect(body.code).toBe(ListQueryRefusal.Malformed);
      expect(body.details).toEqual({});
      expect(service()).not.toHaveBeenCalled();
    }
  );

  it("allows listQuery mixed with the paging companion param on the list route", async () => {
    const response = await getList(
      withListQuery("/agent-sessions", HARNESS_EXPRESSION, { limit: "10" }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(agentSessionsService.findSessions).toHaveBeenCalled();
  });

  it("succeeds on the usage route with listQuery beside comparison and attribution", async () => {
    const response = await getUsage(
      withListQuery("/agent-sessions/usage", HARNESS_EXPRESSION, {
        comparison: AgentSessionComparisonMode.Prior,
        attribution: AgentSessionUsageAttribution.Omit,
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(agentSessionsService.getUsageSummary).toHaveBeenCalled();
    // First argument only — see the lowering table above for why.
    expect(
      vi.mocked(agentSessionsService.getUsageSummary).mock.calls[0][0]
    ).toEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          harnesses: ["claude"],
          comparison: AgentSessionComparisonMode.Prior,
          attribution: AgentSessionUsageAttribution.Omit,
        }),
      })
    );
  });

  it("DT-01/02: HTTP list, usage and analytics forward the same quality/status/window cohort", async () => {
    const filters = new URLSearchParams({
      quality: "substantive",
      statuses: SESSION_STATUS.INACTIVE,
      startDate: "2026-06-12T02:00:00.000Z",
      endDate: "2026-06-12T04:00:00.000Z",
    });
    const responses = await Promise.all([
      getList(
        request(`/agent-sessions?${filters}`),
        createMockRouteContext({})
      ),
      getUsage(
        request(`/agent-sessions/usage?${filters}`),
        createMockRouteContext({})
      ),
      getAnalytics(
        request(`/agent-sessions/analytics?${filters}`),
        createMockRouteContext({})
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    const forwarded = [
      vi.mocked(agentSessionsService.findSessions).mock.calls[0]?.[0].filters,
      vi.mocked(agentSessionsService.getUsageSummary).mock.calls[0]?.[0]
        .filters,
      vi.mocked(agentSessionsService.getAnalytics).mock.calls[0]?.[0].filters,
    ];
    expect(
      forwarded.map((value) => ({
        quality: value?.quality,
        statuses: value?.statuses,
        startDate: value?.startDate,
        endDate: value?.endDate,
      }))
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        quality: "substantive",
        statuses: [SESSION_STATUS.INACTIVE],
        startDate: "2026-06-12T02:00:00.000Z",
        endDate: "2026-06-12T04:00:00.000Z",
      }))
    );
  });

  it("refuses a status clause on the status-counts route as an unsupported field", async () => {
    const response = await getStatusCounts(
      withListQuery("/agent-sessions/status-counts", STATUS_CLAUSE_EXPRESSION),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(await errorBodyOf(response)).toEqual({
      success: false,
      error: expect.any(String),
      code: ListQueryRefusal.UnsupportedField,
      details: { field: SessionListField.Status },
    });
    expect(buildAgentSessionStatusCounts).not.toHaveBeenCalled();
  });

  it("sorts by cost on the list route with the applied rule", async () => {
    const response = await getList(
      withListQuery("/agent-sessions", COST_SORT_EXPRESSION),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    expect(agentSessionsService.findSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          sorts: [
            { column: SessionListField.Cost, dir: ListSortDirection.Desc },
          ],
        }),
      })
    );
  });

  it.each(ROUTES.filter((route) => route.name !== "list"))(
    "refuses a cost sort on $name, which has no sorts param to lower it to",
    async ({ handler, path, service }) => {
      const response = await handler(
        withListQuery(path, COST_SORT_EXPRESSION),
        createMockRouteContext({})
      );

      expect(response.status).toBe(400);
      const body = await errorBodyOf(response);
      expect(body.code).toBe(ListQueryRefusal.UnsupportedField);
      expect(body.details).toEqual({ field: SessionListField.Cost });
      expect(service()).not.toHaveBeenCalled();
    }
  );
});
