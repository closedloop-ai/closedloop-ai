import {
  BranchKpiState,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression";
import { BranchListField } from "@repo/api/src/types/list-query-fields";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getBranchAnalytics: vi.fn(),
  withAnyAuthOptions: [] as unknown[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (request: NextRequest) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.auth, request);
    },
}));

vi.mock("@/app/branches/branch-read-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/branches/branch-read-service")
  >("@/app/branches/branch-read-service");

  return {
    ...actual,
    branchReadService: {
      ...actual.branchReadService,
      getBranchAnalytics: mocks.getBranchAnalytics,
    },
  };
});

import { GET } from "./route";

describe("GET /branches/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.auth.user = { id: "user-1", organizationId: "org-1" };
    mocks.getBranchAnalytics.mockResolvedValue(branchAnalytics());
  });

  it("requires read scope and forwards parsed analytics query to the org-scoped service", async () => {
    const response = await GET(
      request("https://api.example.test/branches/analytics?repo=repo-a"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchAnalytics).toHaveBeenCalledWith(
      "org-1",
      {
        limit: 50,
        offset: 0,
        repo: ["repo-a"],
      },
      // ISS-11117: the cohort's Pensero points reader, bound to this principal.
      // The route passes a reader on every view; what the request's bounds
      // change is the WINDOW the reader carries: `branch-pensero-window.test.ts`
      // pins that the reader carries it, and
      // `lib/delivery-points/__tests__/delivery-point-window.test.ts` pins how
      // the bounds become it.
      expect.any(Function)
    );
    expect(body).toEqual({
      success: true,
      data: branchAnalytics(),
    });
  });

  it("rejects invalid analytics query before service work", async () => {
    const response = await GET(
      request("https://api.example.test/branches/analytics?limit=0"),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mocks.getBranchAnalytics).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
  });

  it("accepts full server filters without wire pagination", async () => {
    const response = await GET(
      request(
        "https://api.example.test/branches/analytics?pageMode=server&names=feature%2Fx&statuses=open&sortKey=name&sortDir=asc"
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getBranchAnalytics).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        pageMode: BranchListPageMode.Server,
        limit: BRANCH_LIST_SERVER_PAGE_SIZE,
        offset: 0,
        names: ["feature/x"],
        statuses: [BranchStatus.Open],
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      }),
      expect.any(Function)
    );
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

function branchAnalytics() {
  return {
    viewerScope: BranchViewerScope.Organization,
    medianPrSize: kpi(null),
    mergeRate: kpi(null),
    medianTimeToMergeMs: kpi(null, BranchKpiState.Gated),
    activePrCount: kpi(0, BranchKpiState.Available),
    mergedCount: kpi(0, BranchKpiState.Available),
    leadTimeForChangeMs: kpi(null, BranchKpiState.Gated),
    locPerDollar: kpi(null),
    totalSpendUsd: kpi(null),
    activeBranchCount: kpi(0, BranchKpiState.Available),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
  };
}

function kpi(
  value: number | null,
  state: BranchKpiState = BranchKpiState.Unavailable
) {
  return {
    value,
    state,
    baseline30d: null,
    deltaPct: null,
  };
}

// PRD-721: the analytics read lowers `listQuery` through the same boundary as
// the list, so the same expression reaches the service as legacy filters and
// a refusal keeps its code.
describe("GET /branches/analytics listQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBranchAnalytics.mockResolvedValue(branchAnalytics());
  });

  it("lowers listQuery into the server filters", async () => {
    const response = await GET(
      request(
        `https://api.example.test/branches/analytics?${analyticsListQuery()}`
      ),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.getBranchAnalytics).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        pageMode: BranchListPageMode.Server,
        names: ["feature/x"],
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      }),
      expect.any(Function)
    );
  });

  it("answers a mixed request with a coded 400", async () => {
    const response = await GET(
      request(
        `https://api.example.test/branches/analytics?${analyticsListQuery()}&names=feature%2Fy`
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(ListQueryRefusal.Malformed);
    expect(body.details).toEqual({ field: BranchListField.Name });
    expect(mocks.getBranchAnalytics).not.toHaveBeenCalled();
  });
});

function analyticsListQuery(): string {
  return new URLSearchParams({
    pageMode: BranchListPageMode.Server,
    [LIST_QUERY_EXPRESSION_PARAM]: JSON.stringify({
      version: LIST_QUERY_EXPRESSION_VERSION,
      filters: [
        {
          field: BranchListField.Name,
          operator: ListFilterOperator.IsAnyOf,
          values: ["feature/x"],
        },
      ],
      sorts: [
        {
          field: BranchListSortKey.Name,
          direction: BranchListSortDirection.Asc,
        },
      ],
    }),
  }).toString();
}
