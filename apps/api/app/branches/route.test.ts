import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchSessionPresence,
  BranchStatus,
  BranchTagAvailability,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  DEFAULT_BRANCH_STATUS_ORDERING,
  ROOT_FIRST_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression";
import { BranchListField } from "@repo/api/src/types/list-query-fields";
import {
  ListQueryExecution,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";
import { TagColor } from "@repo/api/src/types/tag";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRequestListQueryLogFields,
  runWithRequestSpanAttribution,
} from "@/lib/observability/request-span-attribution";
import { BRANCH_LIST_DEFAULT_LIMIT } from "./branch-list-query";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
    apiKeyScopes: undefined as ApiKeyScope[] | undefined,
  },
  listBranches: vi.fn(),
  withAnyAuthOptions: [] as unknown[],
  callOrder: [] as string[],
  evaluate: vi.fn(),
}));

// ISS-9437: the EVALUATOR is mocked, not the wrapper around it, so the route
// still runs the real registry lookup and the real fail-to-default path.
vi.mock("@/lib/feature-flags/server-feature-flag-evaluation", () => ({
  evaluateServerFeatureFlagForDistinctId: (...args: unknown[]) => {
    mocks.callOrder.push("evaluate-flag");
    return mocks.evaluate(...args);
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (request: NextRequest) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.auth, request);
    },
}));

vi.mock("./branch-read-service", async () => {
  const actual = await vi.importActual<typeof import("./branch-read-service")>(
    "./branch-read-service"
  );

  return {
    ...actual,
    branchReadService: {
      ...actual.branchReadService,
      listBranches: mocks.listBranches,
    },
  };
});

import { resetHeldBranchStatusOrderings } from "./branch-status-ordering";
import { GET } from "./route";

describe("GET /branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level state in `branch-status-ordering`, not a mock. Without this,
    // a case that evaluated `true` answers a later case's unavailable or thrown
    // read with root-first and the ordering assertion below reads the previous
    // case's flag.
    resetHeldBranchStatusOrderings();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.auth.authMethod = "session";
    mocks.auth.apiKeyScopes = undefined;
    mocks.callOrder.length = 0;
    mocks.evaluate.mockResolvedValue(null);
    mocks.listBranches.mockImplementation(() => {
      mocks.callOrder.push("list-branches");
      return Promise.resolve(branchList());
    });
  });

  it("requires read scope and forwards parsed list query to the org-scoped service", async () => {
    const response = await GET(
      request(
        "https://api.example.test/branches?repo=closedloop-ai/closedloop-ai&status=draft&status=open&limit=25&offset=5&search=feature&startDate=2026-07-01T00%3A00%3A00.000Z&endDate=2026-07-03T00%3A00%3A00.000Z&projectId=project-1"
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      {
        limit: 25,
        offset: 5,
        endDate: new Date("2026-07-03T00:00:00.000Z"),
        projectId: ["project-1"],
        repo: ["closedloop-ai/closedloop-ai"],
        search: "feature",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        status: [BranchStatus.Draft, BranchStatus.Open],
      },
      { canApply: true, canRemove: true },
      DEFAULT_BRANCH_STATUS_ORDERING
    );
    expect(body).toEqual({
      success: true,
      data: branchList(),
    });
  });

  it("resolves the status ordering BEFORE the service opens its transaction", async () => {
    mocks.evaluate.mockResolvedValue(true);

    await GET(request("https://api.example.test/branches"), routeContext());

    // `listBranches` is where `withBranchProductReadSnapshot` opens a
    // RepeatableRead transaction with a 45s timeout (ISS-10295). A PostHog
    // round trip inside
    // it would spend that budget on the network, so the evaluation must be
    // COMPLETE before the service is entered — not merely present somewhere.
    expect(mocks.callOrder).toEqual(["evaluate-flag", "list-branches"]);
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      expect.any(Object),
      expect.any(Object),
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );
  });

  it("still serves the list when the flag read throws", async () => {
    mocks.evaluate.mockRejectedValue(new Error("posthog unreachable"));

    const response = await GET(
      request("https://api.example.test/branches"),
      routeContext()
    );

    // A flag outage must not 500 the Branches list. It serves, in today's order.
    expect(response.status).toBe(200);
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      expect.any(Object),
      expect.any(Object),
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });

  it("rejects invalid list query before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?status=blocked"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("rejects unsupported filter query params before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?owner=alice"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("rejects mixed legacy and server-page filters before service work", async () => {
    const response = await GET(
      request(
        "https://api.example.test/branches?pageMode=server&limit=20&offset=0&sortKey=name&sortDir=asc&names=feature%2Fx&repo=acme%2Fweb"
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  it("forwards the FEA-4003 linked-session + LOC-range params to the service", async () => {
    const response = await GET(
      request(
        "https://api.example.test/branches?sessionPresence=has&locMin=10&locMax=500"
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      {
        limit: BRANCH_LIST_DEFAULT_LIMIT,
        offset: 0,
        sessionPresence: BranchSessionPresence.Has,
        locMin: 10,
        locMax: 500,
      },
      { canApply: true, canRemove: true },
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });

  it("forwards granular API-key tag association permissions", async () => {
    mocks.auth.authMethod = "api_key";
    mocks.auth.apiKeyScopes = ["read", "write"];

    const response = await GET(
      request("https://api.example.test/branches"),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.listBranches).toHaveBeenCalledWith(
      "org-1",
      expect.any(Object),
      { canApply: true, canRemove: false },
      DEFAULT_BRANCH_STATUS_ORDERING
    );
  });

  it("leaves a blank LOC bound UNSET instead of coercing it to 0", async () => {
    // `?locMax=` (empty) must forward `locMax: undefined`, not a max-0 filter.
    const response = await GET(
      request("https://api.example.test/branches?locMin=&locMax="),
      routeContext()
    );

    expect(response.status).toBe(200);
    const [, forwarded] = mocks.listBranches.mock.calls.at(-1) ?? [];
    expect(forwarded?.locMin).toBeUndefined();
    expect(forwarded?.locMax).toBeUndefined();
  });

  it("rejects an unknown session-presence value before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?sessionPresence=maybe"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("rejects a negative LOC bound before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?locMin=-1"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("rejects an inverted LOC range (locMin > locMax) before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches?locMin=500&locMax=10"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.listBranches).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });
});

function request(url: string) {
  return new NextRequest(url, {
    method: "GET",
  });
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

function branchList() {
  return {
    viewerScope: BranchViewerScope.Organization,
    total: 1,
    hasMore: false,
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        artifactId: "11111111-1111-4111-8111-111111111111",
        tags: [{ id: "tag-1", name: "backend", color: TagColor.Blue }],
        tagAvailability: BranchTagAvailability.Available,
        tagPermissions: { canApply: true, canRemove: true },
        branchName: "feature/branches-api",
        baseBranch: "main",
        repoFullName: "closedloop-ai/closedloop-ai",
        owner: null,
        status: BranchStatus.Open,
        prNumber: 7,
        prTitle: "Add Branches API",
        prState: null,
        prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7",
        multiPrWarning: false,
        checksStatus: null,
        checksPassed: null,
        checksTotal: null,
        reviewDecision: null,
        ahead: null,
        behind: null,
        additions: 10,
        deletions: 2,
        filesChanged: 3,
        estimatedCostUsd: null,
        lastActivityAt: "2026-07-03T05:00:00.000Z",
        sessionIds: [],
      },
    ],
  };
}

// PRD-721: the Branches read compiles the canonical `listQuery` expression
// into the same legacy params a hand-written request carries, and refuses what
// it cannot serve with a coded 400 before any service work.
describe("GET /branches listQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeldBranchStatusOrderings();
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.auth.authMethod = "session";
    mocks.auth.apiKeyScopes = undefined;
    mocks.evaluate.mockResolvedValue(null);
    mocks.listBranches.mockResolvedValue(branchList());
  });

  it("serves an expression with the filters the legacy server page carries", async () => {
    const legacy = await GET(
      request(
        `https://api.example.test/branches?${new URLSearchParams([
          ...SERVER_PAGE_PARAMS,
          ["names", "feature/a"],
          ["names", "feature/b"],
          ["statuses", BranchStatus.Open],
          ["locMin", "10"],
          ["locMax", "500"],
          ["startDate", "2026-07-01T00:00:00.000Z"],
          ["sortKey", BranchListSortKey.Changes],
          ["sortDir", BranchListSortDirection.Asc],
        ]).toString()}`
      ),
      routeContext()
    );
    const canonical = await GET(
      listQueryRequest({
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          anyOf(BranchListField.Name, ["feature/a", "feature/b"]),
          anyOf(BranchListField.Status, [BranchStatus.Open]),
          {
            field: BranchListField.Changes,
            operator: ListFilterOperator.IsBetween,
            min: 10,
            max: 500,
          },
          {
            field: BranchListField.LastActivity,
            operator: ListFilterOperator.IsBetween,
            min: "2026-07-01T00:00:00.000Z",
          },
        ],
        sorts: [
          {
            field: BranchListSortKey.Changes,
            direction: BranchListSortDirection.Asc,
          },
        ],
      }),
      routeContext()
    );

    expect(legacy.status).toBe(200);
    expect(canonical.status).toBe(200);
    const [legacyCall, canonicalCall] = mocks.listBranches.mock.calls;
    expect(canonicalCall?.[1]).toEqual(legacyCall?.[1]);
    expect(canonicalCall?.[1]).toMatchObject({
      names: ["feature/a", "feature/b"],
      statuses: [BranchStatus.Open],
      locMin: 10,
      locMax: 500,
      sortKey: BranchListSortKey.Changes,
    });
  });

  it("refuses an expression beside a legacy spelling of its axis with a coded 400", async () => {
    const response = await GET(
      listQueryRequest(NAME_EXPRESSION, [["repositories", "acme/web"]]),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ListQueryRefusal.Malformed);
    expect(body.details).toEqual({ field: BranchListField.Repo });
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  it("refuses a server-page facet outside server page mode with a coded 400", async () => {
    const response = await GET(
      request(
        `https://api.example.test/branches?${new URLSearchParams({
          [LIST_QUERY_EXPRESSION_PARAM]: JSON.stringify(NAME_EXPRESSION),
        }).toString()}`
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ListQueryRefusal.UnsupportedField);
    expect(body.details).toEqual({ field: BranchListField.Name });
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  it("refuses an operator the field cannot serve with a coded 400", async () => {
    const response = await GET(
      listQueryRequest({
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          { field: BranchListField.Name, operator: ListFilterOperator.IsEmpty },
        ],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ListQueryRefusal.UnsupportedOperator);
    expect(body.details).toEqual({
      field: BranchListField.Name,
      operator: ListFilterOperator.IsEmpty,
    });
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  it("records the request source and counts without the serialized query", async () => {
    let served: Record<string, string | number> = {};
    let refused: Record<string, string | number> = {};
    await runWithRequestSpanAttribution(async () => {
      await GET(listQueryRequest(NAME_EXPRESSION), routeContext());
      served = getRequestListQueryLogFields();
    });
    await runWithRequestSpanAttribution(async () => {
      await GET(
        listQueryRequest({ ...NAME_EXPRESSION, version: 99 }),
        routeContext()
      );
      refused = getRequestListQueryLogFields();
    });

    expect(served).toEqual({
      list_query_source: ListQuerySource.Canonical,
      list_query_matched_count: branchList().total,
      list_query_result_count: branchList().items.length,
    });
    expect(refused).toEqual({
      list_query_source: ListQuerySource.Canonical,
      list_query_execution: ListQueryExecution.Refused,
      list_query_refusal: ListQueryRefusal.UnsupportedVersion,
    });
    expect(JSON.stringify(served)).not.toContain("feature/a");
  });
});

const SERVER_PAGE_PARAMS: [string, string][] = [
  ["pageMode", BranchListPageMode.Server],
  ["limit", String(BRANCH_LIST_SERVER_PAGE_SIZE)],
  ["offset", "0"],
];

const NAME_EXPRESSION = {
  version: LIST_QUERY_EXPRESSION_VERSION,
  filters: [
    {
      field: BranchListField.Name,
      operator: ListFilterOperator.IsAnyOf,
      values: ["feature/a"],
    },
  ],
} satisfies ListQueryExpression;

function anyOf(field: string, values: string[]) {
  return { field, operator: ListFilterOperator.IsAnyOf, values };
}

function listQueryRequest(
  expression: Record<string, unknown>,
  extraParams: [string, string][] = []
) {
  const params = new URLSearchParams([
    ...SERVER_PAGE_PARAMS,
    ...extraParams,
    [LIST_QUERY_EXPRESSION_PARAM, JSON.stringify(expression)],
  ]);
  return request(`https://api.example.test/branches?${params.toString()}`);
}
