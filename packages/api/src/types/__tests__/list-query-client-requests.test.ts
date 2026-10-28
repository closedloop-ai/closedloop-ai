import { describe, expect, it } from "vitest";
import { SESSION_QUALITY_VALUES } from "../../agent-session-filters.ts";
import { AgentSessionViewerScope } from "../agent-session.ts";
import { SESSION_SORT_RULES_QUERY_PARAM } from "../agent-session-sort.ts";
import { BranchSessionPresence, BranchStatus } from "../branch.ts";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "../branch-list-contract.ts";
import { CLOUD_BRANCH_LIST_QUERY_CAPABILITY } from "../branch-list-query-capabilities.ts";
import { lowerBranchListQueryExpression } from "../branch-list-query-lowering.ts";
import { Priority } from "../common.ts";
import {
  buildBranchListQueryIpcRequest,
  buildBranchListQueryUrlParams,
  buildSessionListQueryIpcRequest,
  buildSessionListQueryUrlParams,
} from "../list-query-client-requests.ts";
import {
  LIST_QUERY_EXPRESSION_MAX_LENGTH,
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  ListSortDirection,
} from "../list-query-expression.ts";
import { parseListQueryExpression } from "../list-query-expression-schema.ts";
import { BranchListField, SessionListField } from "../list-query-fields.ts";
import type { ListQueryLoweringTarget } from "../list-query-lowering.ts";
import { listRequestUrl } from "../list-query-request-params.ts";
import { CLOUD_SESSION_LIST_QUERY_CAPABILITY } from "../session-list-query-capabilities.ts";
import { lowerSessionListQueryExpression } from "../session-list-query-lowering.ts";
import { SESSION_STATUS } from "../session-status.ts";

const [SUBSTANTIVE] = SESSION_QUALITY_VALUES;
const WINDOW_START = "2026-10-01T00:00:00.000Z";
const WINDOW_END = "2026-10-08T00:00:00.000Z";

/** Every param either list lowers to, so a round trip is judged by values. */
const ACCEPT_ALL: ListQueryLoweringTarget = {
  acceptedParams: new Set([
    "statuses",
    "userIds",
    "repositories",
    "harnesses",
    "models",
    "autonomyTiers",
    "costBuckets",
    "changePresence",
    "prAssociation",
    "priorities",
    "quality",
    "projectIds",
    "startDate",
    "endDate",
    SESSION_SORT_RULES_QUERY_PARAM,
    "names",
    "owners",
    "collaborators",
    "pullRequests",
    "lastActiveRanges",
    "tags",
    "locMin",
    "locMax",
    "sortKey",
    "sortDir",
  ]),
  repeatableParams: new Set([
    "statuses",
    "userIds",
    "repositories",
    "harnesses",
    "models",
    "autonomyTiers",
    "costBuckets",
    "changePresence",
    "prAssociation",
    "priorities",
    "projectIds",
    SESSION_SORT_RULES_QUERY_PARAM,
    "names",
    "owners",
    "collaborators",
    "pullRequests",
    "lastActiveRanges",
    "tags",
  ]),
};

describe("buildSessionListQueryUrlParams", () => {
  const legacyFilters = {
    statuses: [SESSION_STATUS.ACTIVE],
    harnesses: ["claude", "codex"],
    priorities: [Priority.High],
    quality: SUBSTANTIVE,
    startDate: WINDOW_START,
    endDate: WINDOW_END,
  };

  it("replaces the filter and sort params with an expression that lowers back to them", () => {
    const params = buildSessionListQueryUrlParams({
      ...legacyFilters,
      sortBy: SessionListField.Cost,
      sortDir: ListSortDirection.Asc,
      limit: 25,
      offset: 50,
      viewerScope: AgentSessionViewerScope.Self,
      search: "deploy",
    });

    expect(params).not.toBeNull();
    const { [LIST_QUERY_EXPRESSION_PARAM]: raw, ...companions } = params ?? {};
    expect(companions).toEqual({
      limit: 25,
      offset: 50,
      viewerScope: AgentSessionViewerScope.Self,
      search: "deploy",
    });
    const parsed = parseListQueryExpression(String(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(
      lowerSessionListQueryExpression(
        parsed.expression,
        CLOUD_SESSION_LIST_QUERY_CAPABILITY,
        ACCEPT_ALL
      )
    ).toEqual({
      ok: true,
      params: {
        ...legacyFilters,
        [SESSION_SORT_RULES_QUERY_PARAM]: [`${SessionListField.Cost}:asc`],
      },
    });
  });

  it("reads a scalar sort without a direction as descending, as the route does", () => {
    expect(
      expressionOf(
        buildSessionListQueryUrlParams({ sortBy: SessionListField.Started })
      )
    ).toEqual({
      version: LIST_QUERY_EXPRESSION_VERSION,
      sorts: [
        { field: SessionListField.Started, direction: ListSortDirection.Desc },
      ],
    });
  });

  it("states the ordered sorts list in place of its scalar echo", () => {
    expect(
      expressionOf(
        buildSessionListQueryUrlParams({
          [SESSION_SORT_RULES_QUERY_PARAM]: ["cost:desc", "started:asc"],
          sortBy: SessionListField.Cost,
          sortDir: ListSortDirection.Desc,
        })
      )
    ).toEqual({
      version: LIST_QUERY_EXPRESSION_VERSION,
      sorts: [
        { field: SessionListField.Cost, direction: ListSortDirection.Desc },
        { field: SessionListField.Started, direction: ListSortDirection.Asc },
      ],
    });
  });

  it.each([
    ["no filter and no sort", { limit: 25 }],
    ["an unmodeled bound", { ...legacyFilters, completedAfter: WINDOW_START }],
    ["a single-value alias", { status: SESSION_STATUS.ACTIVE }],
    ["a value the cloud refuses", { statuses: ["completed"] }],
    ["a zone-less window bound", { startDate: "2026-10-01T00:00:00" }],
    ["an unreadable sort rule", { [SESSION_SORT_RULES_QUERY_PARAM]: ["cost"] }],
    ["a sort the cloud cannot serve", { sortBy: SessionListField.Quality }],
    [
      "an expression longer than a parser reads",
      { repositories: longValues(LIST_QUERY_EXPRESSION_MAX_LENGTH) },
    ],
  ])("keeps the legacy params for %s", (_case, params) => {
    expect(buildSessionListQueryUrlParams(params)).toBeNull();
  });
});

describe("buildSessionListQueryIpcRequest", () => {
  it("keeps host read hints beside the structured expression", () => {
    expect(
      buildSessionListQueryIpcRequest({
        models: ["claude-opus-4"],
        countOnly: true,
        ids: ["s1"],
        sortBy: SessionListField.Updated,
        sortDir: ListSortDirection.Desc,
      })
    ).toEqual({
      countOnly: true,
      ids: ["s1"],
      [LIST_QUERY_EXPRESSION_PARAM]: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: SessionListField.Model,
            operator: ListFilterOperator.IsAnyOf,
            values: ["claude-opus-4"],
          },
        ],
        sorts: [
          {
            field: SessionListField.Updated,
            direction: ListSortDirection.Desc,
          },
        ],
      },
    });
  });

  // Desktop main reads an empty `ids` as "narrow to nothing" and a missing one
  // as "no id narrowing", so a host param is copied, never dropped as empty.
  it("copies an empty host param rather than dropping it", () => {
    expect(
      buildSessionListQueryIpcRequest({ models: ["claude-opus-4"], ids: [] })
    ).toMatchObject({ ids: [] });
  });

  // The desktop read serves one sort rule (`DESKTOP_SESSION_LIST_QUERY_CAPABILITY`).
  it("keeps the legacy params for a sort the desktop refuses", () => {
    expect(
      buildSessionListQueryIpcRequest({
        [SESSION_SORT_RULES_QUERY_PARAM]: ["cost:desc", "started:asc"],
      })
    ).toBeNull();
  });
});

describe("buildBranchListQueryUrlParams", () => {
  const legacyFilters = {
    names: ["feat/a"],
    statuses: [BranchStatus.Open, BranchStatus.Merged],
    pullRequests: [BranchListPullRequestPresence.None],
    priorities: [Priority.Urgent],
    locMin: 1,
    locMax: 400,
    startDate: WINDOW_START,
  };
  const serverPage = {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
  };
  const sort = {
    sortKey: BranchListSortKey.Status,
    sortDir: BranchListSortDirection.Desc,
  };

  it("replaces the filter and sort params with an expression that lowers back to them", () => {
    const params = buildBranchListQueryUrlParams({
      ...serverPage,
      ...legacyFilters,
      ...sort,
    });

    expect(params).not.toBeNull();
    const { [LIST_QUERY_EXPRESSION_PARAM]: raw, ...companions } = params ?? {};
    expect(companions).toEqual(serverPage);
    const parsed = parseListQueryExpression(String(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(
      lowerBranchListQueryExpression(
        parsed.expression,
        CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
        ACCEPT_ALL
      )
    ).toEqual({ ok: true, params: { ...legacyFilters, ...sort } });
  });

  it.each([
    [
      "recency buckets beside a date window",
      {
        lastActiveRanges: [BranchListLastActiveRange.OneDayOrMore],
        startDate: WINDOW_START,
      },
    ],
    ["a legacy single-value alias", { repo: "acme/web" }],
    ["half a sort pair", { sortKey: BranchListSortKey.Name }],
    [
      "an unmodeled param",
      { sessionPresence: BranchSessionPresence.Has, names: ["feat/a"] },
    ],
    ["an inverted LOC range", { locMin: 9, locMax: 1 }],
  ])("keeps the legacy params for %s", (_case, params) => {
    expect(buildBranchListQueryUrlParams({ ...serverPage, ...params })).toBe(
      null
    );
  });
});

describe("buildBranchListQueryIpcRequest", () => {
  it("keeps the desktop read hints beside the structured expression", () => {
    expect(
      buildBranchListQueryIpcRequest({
        pageMode: BranchListPageMode.Server,
        limit: BRANCH_LIST_SERVER_PAGE_SIZE,
        offset: 0,
        tags: ["backend"],
        forceRefresh: true,
        skipCloudHydration: true,
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      })
    ).toEqual({
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      forceRefresh: true,
      skipCloudHydration: true,
      [LIST_QUERY_EXPRESSION_PARAM]: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: BranchListField.Tags,
            operator: ListFilterOperator.IsAnyOf,
            values: ["backend"],
          },
        ],
        sorts: [
          { field: BranchListSortKey.Name, direction: ListSortDirection.Asc },
        ],
      },
    });
  });
});

function expressionOf(params: Record<string, unknown> | null) {
  const raw = params?.[LIST_QUERY_EXPRESSION_PARAM];
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = parseListQueryExpression(raw);
  return parsed.ok ? parsed.expression : null;
}

/** Enough distinct repository names to serialize past `length` characters. */
function longValues(length: number): string[] {
  const value = "r".repeat(1000);
  return Array.from(
    { length: Math.ceil(length / value.length) + 1 },
    (_, index) => `${value}${index}`
  );
}

// The helper e2e and component mocks read list requests through: it must
// hand back exactly the legacy params the grid's request replaced.
describe("listRequestUrl", () => {
  it("reads a Sessions listQuery request as the legacy params it replaced", () => {
    const legacy = {
      statuses: [SESSION_STATUS.ACTIVE],
      startDate: WINDOW_START,
      sortBy: SessionListField.Cost,
      sortDir: ListSortDirection.Desc,
      limit: 25,
    };
    const url = requestUrl(
      "/agent-sessions",
      buildSessionListQueryUrlParams(legacy)
    );

    expect(paramsOf(listRequestUrl(url))).toEqual({
      limit: ["25"],
      statuses: [SESSION_STATUS.ACTIVE],
      startDate: [WINDOW_START],
      [SESSION_SORT_RULES_QUERY_PARAM]: [`${SessionListField.Cost}:desc`],
      sortBy: [SessionListField.Cost],
      sortDir: [ListSortDirection.Desc],
    });
  });

  it("reads a Branches listQuery request as the legacy params it replaced", () => {
    const url = requestUrl(
      "/api/branches",
      buildBranchListQueryUrlParams({
        pageMode: BranchListPageMode.Server,
        limit: BRANCH_LIST_SERVER_PAGE_SIZE,
        offset: 0,
        owners: ["alice", "bob"],
        sortKey: BranchListSortKey.Owner,
        sortDir: BranchListSortDirection.Asc,
      })
    );

    expect(paramsOf(listRequestUrl(url))).toEqual({
      pageMode: [BranchListPageMode.Server],
      limit: [String(BRANCH_LIST_SERVER_PAGE_SIZE)],
      offset: ["0"],
      owners: ["alice", "bob"],
      sortKey: [BranchListSortKey.Owner],
      sortDir: [BranchListSortDirection.Asc],
    });
  });

  it("returns any other request unchanged", () => {
    const url = new URL("https://api.test/branches/analytics?names=feat%2Fa");
    expect(listRequestUrl(url)).toBe(url);
  });
});

function requestUrl(path: string, params: Record<string, unknown> | null): URL {
  const url = new URL(`https://api.test${path}`);
  for (const [name, value] of Object.entries(params ?? {})) {
    url.searchParams.append(name, String(value));
  }
  return url;
}

function paramsOf(url: URL): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const name of new Set(url.searchParams.keys())) {
    params[name] = url.searchParams.getAll(name);
  }
  return params;
}
