import { BranchViewerScope } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { Priority } from "@repo/api/src/types/common";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
} from "@repo/api/src/types/list-query-expression";
import { parseListQueryExpression } from "@repo/api/src/types/list-query-expression-schema";
import { BranchListField } from "@repo/api/src/types/list-query-fields";
import { describe, expect, it } from "vitest";
import { createHttpBranchesDataSource } from "../branches-data-source";

const WINDOW_START = "2026-10-01T00:00:00.000Z";

// PRD-721 / ISS-9346: the Branches grid sends its filter and sort as the
// canonical `listQuery` expression; paging stays a legacy param beside it.
describe("HTTP Branches list read sends listQuery", () => {
  it("sends a server page's filters and sort as one expression", async () => {
    const api = recordingApi();

    await createHttpBranchesDataSource(api).list({
      ...serverPage(),
      names: ["feat/a", "feat/b"],
      priorities: [Priority.High],
      locMin: 10,
      locMax: 200,
      startDate: WINDOW_START,
    });

    expect(requestOf(api.paths[0])).toEqual({
      path: "/branches",
      params: {
        pageMode: BranchListPageMode.Server,
        limit: String(BRANCH_LIST_SERVER_PAGE_SIZE),
        offset: "0",
      },
      expression: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: BranchListField.Name,
            operator: ListFilterOperator.IsAnyOf,
            values: ["feat/a", "feat/b"],
          },
          {
            field: BranchListField.Priority,
            operator: ListFilterOperator.IsAnyOf,
            values: [Priority.High],
          },
          {
            field: BranchListField.Changes,
            operator: ListFilterOperator.IsBetween,
            min: 10,
            max: 200,
          },
          {
            field: BranchListField.LastActivity,
            operator: ListFilterOperator.IsBetween,
            min: WINDOW_START,
          },
        ],
        sorts: [
          {
            field: BranchListSortKey.Name,
            direction: BranchListSortDirection.Asc,
          },
        ],
      },
    });
  });

  it("keeps the legacy params when the caller turns listQuery off", async () => {
    const api = recordingApi();

    await createHttpBranchesDataSource(api, {
      canonicalListQuery: false,
    }).list({ ...serverPage(), names: ["feat/a"] });

    const request = requestOf(api.paths[0]);
    expect(request.expression).toBeNull();
    expect(request.params).toEqual({
      pageMode: BranchListPageMode.Server,
      limit: String(BRANCH_LIST_SERVER_PAGE_SIZE),
      offset: "0",
      names: "feat/a",
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    });
  });

  // One clause per field: recency buckets and a date window are two lowerings
  // of Last active, which no v1 expression states at once.
  it("keeps the legacy params when no expression says the same thing", async () => {
    const api = recordingApi();

    await createHttpBranchesDataSource(api).list({
      ...serverPage(),
      lastActiveRanges: [BranchListLastActiveRange.WithinLastHour],
      startDate: WINDOW_START,
    });

    const request = requestOf(api.paths[0]);
    expect(request.expression).toBeNull();
    expect(request.params).toMatchObject({
      lastActiveRanges: BranchListLastActiveRange.WithinLastHour,
      startDate: WINDOW_START,
      sortKey: BranchListSortKey.Name,
    });
  });

  it("keeps the analytics read on its legacy params", async () => {
    const api = recordingApi();

    await createHttpBranchesDataSource(api).analytics({
      ...serverPage(),
      names: ["feat/a"],
    });

    const request = requestOf(api.paths[0]);
    expect(request.path).toBe("/branches/analytics");
    expect(request.expression).toBeNull();
    expect(request.params).toMatchObject({ names: "feat/a" });
  });
});

function serverPage() {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    sortKey: BranchListSortKey.Name,
    sortDir: BranchListSortDirection.Asc,
  };
}

/** An HTTP client that records each path and answers with an empty page. */
function recordingApi() {
  const paths: string[] = [];
  const page: unknown = {
    items: [],
    total: 0,
    viewerScope: BranchViewerScope.Organization,
  };
  return {
    paths,
    get: <T>(path: string): Promise<T> => {
      paths.push(path);
      return Promise.resolve(page as T);
    },
  };
}

/** One recorded path as its parsed `listQuery` and the params beside it. */
function requestOf(path: string | undefined) {
  const url = new URL(`https://cloud.invalid${path ?? ""}`);
  const raw = url.searchParams.get(LIST_QUERY_EXPRESSION_PARAM);
  url.searchParams.delete(LIST_QUERY_EXPRESSION_PARAM);
  const parsed = raw === null ? null : parseListQueryExpression(raw);
  return {
    path: url.pathname,
    params: Object.fromEntries(url.searchParams),
    expression: parsed?.ok ? parsed.expression : null,
  };
}
