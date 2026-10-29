/**
 * PRD-721: the desktop `listQuery` compiler at the Branches IPC request
 * boundary. Driven through `coerceSharedBranchesQuery`, the coercion every
 * Branches read channel runs, so each case is the request main actually
 * hands the read.
 */
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { Priority } from "@repo/api/src/types/common";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  type ListFilterClause,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefused,
} from "@repo/api/src/types/list-query-expression";
import { BranchListField } from "@repo/api/src/types/list-query-fields";
import { describe, expect, it } from "vitest";
import {
  BranchListQueryRefusedError,
  compileBranchListQueryRequest,
} from "../src/main/branch/branch-list-query-compiler.js";
import { coerceSharedBranchesQuery } from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";

const WINDOW_START = "2026-10-01T00:00:00.000Z";

const SERVER_PAGE = {
  pageMode: BranchListPageMode.Server,
  limit: BRANCH_LIST_SERVER_PAGE_SIZE,
  offset: 0,
  skipCloudHydration: true,
} as const;

const SORT = {
  sortKey: BranchListSortKey.Changes,
  sortDir: BranchListSortDirection.Asc,
} as const;

const NAME_EXPRESSION: ListQueryExpression = {
  version: LIST_QUERY_EXPRESSION_VERSION,
  filters: [anyOf(BranchListField.Name, ["feat/a"])],
  sorts: [{ field: SORT.sortKey, direction: SORT.sortDir }],
};

/** One clause per filterable field and served operator. */
const SERVED_CLAUSES: readonly ListFilterClause[] = [
  anyOf(BranchListField.Name, ["feat/a"]),
  anyOf(BranchListField.Owner, ["alice"]),
  anyOf(BranchListField.Collaborators, ["bob"]),
  anyOf(BranchListField.Status, Object.values(BranchStatus)),
  anyOf(
    BranchListField.PullRequest,
    Object.values(BranchListPullRequestPresence)
  ),
  { field: BranchListField.PullRequest, operator: ListFilterOperator.IsEmpty },
  anyOf(BranchListField.LastActivity, Object.values(BranchListLastActiveRange)),
  {
    field: BranchListField.LastActivity,
    operator: ListFilterOperator.IsBetween,
    min: WINDOW_START,
    max: "2026-10-08T00:00:00.000Z",
  },
  anyOf(BranchListField.Repo, ["acme/web"]),
  anyOf(BranchListField.Tags, ["backend"]),
  anyOf(BranchListField.Priority, [Priority.Low]),
  { field: BranchListField.Priority, operator: ListFilterOperator.IsEmpty },
  { field: BranchListField.Priority, operator: ListFilterOperator.IsNotEmpty },
  {
    field: BranchListField.Changes,
    operator: ListFilterOperator.IsBetween,
    min: 0,
    max: 10,
  },
];

describe("Branches IPC compiles listQuery (PRD-721)", () => {
  it("leaves a request without listQuery untouched", () => {
    const request = { ...SERVER_PAGE, ...SORT, names: ["feat/a"] };
    expect(compileBranchListQueryRequest(request)).toBe(request);
  });

  it("hands the read the same request the legacy params produce", () => {
    const legacy = {
      ...SERVER_PAGE,
      ...SORT,
      names: ["feat/a", "feat/b"],
      statuses: [BranchStatus.Open],
      pullRequests: [BranchListPullRequestPresence.Linked],
      priorities: [Priority.High],
      locMin: 5,
      locMax: 500,
      startDate: WINDOW_START,
    };
    const canonical = withListQuery(SERVER_PAGE, {
      version: LIST_QUERY_EXPRESSION_VERSION,
      filters: [
        anyOf(BranchListField.Name, ["feat/a", "feat/b"]),
        anyOf(BranchListField.Status, [BranchStatus.Open]),
        anyOf(BranchListField.PullRequest, [
          BranchListPullRequestPresence.Linked,
        ]),
        anyOf(BranchListField.Priority, [Priority.High]),
        {
          field: BranchListField.Changes,
          operator: ListFilterOperator.IsBetween,
          min: 5,
          max: 500,
        },
        {
          field: BranchListField.LastActivity,
          operator: ListFilterOperator.IsBetween,
          min: WINDOW_START,
        },
      ],
      sorts: [{ field: SORT.sortKey, direction: SORT.sortDir }],
    });

    expect(coerceSharedBranchesQuery(canonical)).toEqual(
      coerceSharedBranchesQuery(legacy)
    );
  });

  it("refuses an expression beside a legacy spelling of one of its axes", () => {
    expect(
      refusalOf({
        ...withListQuery(SERVER_PAGE, NAME_EXPRESSION),
        repositories: ["acme/web"],
      })
    ).toEqual({
      code: ListQueryRefusal.Malformed,
      details: { field: BranchListField.Repo },
    });
  });

  it("refuses an operator the field cannot serve", () => {
    expect(
      refusalOf(
        withListQuery(SERVER_PAGE, {
          version: LIST_QUERY_EXPRESSION_VERSION,
          filters: [
            {
              field: BranchListField.Tags,
              operator: ListFilterOperator.IsEmpty,
            },
          ],
        })
      )
    ).toEqual({
      code: ListQueryRefusal.UnsupportedOperator,
      details: {
        field: BranchListField.Tags,
        operator: ListFilterOperator.IsEmpty,
      },
    });
  });

  it("refuses a server-page facet on the complete-corpus read", () => {
    expect(
      refusalOf(withListQuery({ skipCloudHydration: true }, NAME_EXPRESSION))
    ).toEqual({
      code: ListQueryRefusal.UnsupportedField,
      details: { field: BranchListField.Name },
    });
  });

  it("windows the complete-corpus read through the expression", () => {
    expect(
      coerceSharedBranchesQuery(
        withListQuery(
          { skipCloudHydration: true },
          {
            version: LIST_QUERY_EXPRESSION_VERSION,
            filters: [
              {
                field: BranchListField.LastActivity,
                operator: ListFilterOperator.IsBetween,
                min: WINDOW_START,
              },
            ],
          }
        )
      )
    ).toEqual({ skipCloudHydration: true, startDate: WINDOW_START });
  });
});

/**
 * Conformance: every clause `DESKTOP_BRANCH_LIST_QUERY_CAPABILITY` declares
 * served compiles to a server page the desktop IPC schema accepts, so the
 * declaration claims nothing the host would then refuse.
 */
describe("desktop Branches capability conforms to its IPC schema", () => {
  it.each(SERVED_CLAUSES.map((clause) => [describeClause(clause), clause]))(
    "serves %s",
    (_name, clause) => {
      const request = withListQuery(SERVER_PAGE, {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [clause],
        sorts: [{ field: SORT.sortKey, direction: SORT.sortDir }],
      });
      expect(() => coerceSharedBranchesQuery(request)).not.toThrow();
    }
  );

  it.each(Object.values(BranchListSortKey))("sorts by %s", (sortKey) => {
    const request = withListQuery(SERVER_PAGE, {
      version: LIST_QUERY_EXPRESSION_VERSION,
      sorts: [{ field: sortKey, direction: BranchListSortDirection.Desc }],
    });
    expect(coerceSharedBranchesQuery(request)).toMatchObject({
      sortKey,
      sortDir: BranchListSortDirection.Desc,
    });
  });
});

function anyOf(field: string, values: string[]): ListFilterClause {
  return { field, operator: ListFilterOperator.IsAnyOf, values };
}

function withListQuery(
  rest: Record<string, unknown>,
  expression: ListQueryExpression
): Record<string, unknown> {
  return { ...rest, [LIST_QUERY_EXPRESSION_PARAM]: expression };
}

function refusalOf(request: Record<string, unknown>): ListQueryRefused | null {
  try {
    coerceSharedBranchesQuery(request);
    return null;
  } catch (error) {
    return error instanceof BranchListQueryRefusedError ? error.refused : null;
  }
}

function describeClause(clause: ListFilterClause): string {
  return `${clause.field} ${clause.operator}`;
}
