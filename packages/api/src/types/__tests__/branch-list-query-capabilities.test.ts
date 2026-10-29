import { describe, expect, it } from "vitest";
import { BranchStatus } from "../branch.ts";
import {
  BRANCH_LIST_MAX_FILTER_VALUES,
  BranchListLastActiveRange,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "../branch-list-contract.ts";
import {
  CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
  DESKTOP_BRANCH_LIST_QUERY_CAPABILITY,
} from "../branch-list-query-capabilities.ts";
import {
  BRANCH_LIST_SORT_DIR_PARAM,
  BRANCH_LIST_SORT_KEY_PARAM,
  lowerBranchListQueryExpression,
} from "../branch-list-query-lowering.ts";
import {
  BRANCH_LIST_QUERY_FIELDS,
  BRANCH_LIST_SET_PARAMS,
} from "../branch-list-query-registry.ts";
import { Priority } from "../common.ts";
import { expressionOf } from "../list-query.test-helpers.ts";
import type { ListQueryCapability } from "../list-query-capability.ts";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  LIST_QUERY_MAX_CLAUSES,
  LIST_QUERY_MAX_SORT_RULES,
  LIST_QUERY_MAX_VALUES_PER_CLAUSE,
  type ListFilterClause,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
} from "../list-query-expression.ts";
import { BranchListField } from "../list-query-fields.ts";
import type { ListQueryLoweringTarget } from "../list-query-lowering.ts";
import { PRIORITY_UNSET_VALUE } from "../search-query.ts";

const CAPABILITIES = {
  cloud: CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
  desktop: DESKTOP_BRANCH_LIST_QUERY_CAPABILITY,
} as const;

/** Every server-page param, as both hosts' server-page schemas accept them. */
const SERVER_PAGE_TARGET: ListQueryLoweringTarget = {
  acceptedParams: new Set([
    ...Object.values(BRANCH_LIST_QUERY_FIELDS).flatMap((spec) => [
      ...(spec.anyOf ? [spec.anyOf.param] : []),
      ...(spec.between ? [spec.between.minParam, spec.between.maxParam] : []),
    ]),
    BRANCH_LIST_SORT_KEY_PARAM,
    BRANCH_LIST_SORT_DIR_PARAM,
  ]),
  repeatableParams: BRANCH_LIST_SET_PARAMS,
};

describe("Branches list query capabilities", () => {
  it("declares the same fields, operators and caps on cloud and desktop", () => {
    expect(DESKTOP_BRANCH_LIST_QUERY_CAPABILITY).toEqual(
      CLOUD_BRANCH_LIST_QUERY_CAPABILITY
    );
  });

  it.each(Object.entries(CAPABILITIES))(
    "%s stays within the wire ceilings and serves one sort rule",
    (_host, capability) => {
      expect(capability.version).toBe(LIST_QUERY_EXPRESSION_VERSION);
      expect(capability.maxClauses).toBeLessThanOrEqual(LIST_QUERY_MAX_CLAUSES);
      expect(capability.maxValuesPerClause).toBe(
        Math.min(
          BRANCH_LIST_MAX_FILTER_VALUES,
          LIST_QUERY_MAX_VALUES_PER_CLAUSE
        )
      );
      expect(capability.maxSortRules).toBe(1);
      expect(capability.maxSortRules).toBeLessThanOrEqual(
        LIST_QUERY_MAX_SORT_RULES
      );
    }
  );

  it.each(Object.entries(CAPABILITIES))(
    "%s declares only operators the registry can lower",
    (_host, capability) => {
      for (const field of Object.values(BranchListField)) {
        const spec = BRANCH_LIST_QUERY_FIELDS[field];
        const served = capability.fields[field];
        expect(served, field).toBeDefined();
        expect(served?.sortable, field).toBe(spec.sortRank !== null);
        for (const operator of served?.operators ?? []) {
          expect(lowerableOperators(field), `${field} ${operator}`).toContain(
            operator
          );
        }
      }
    }
  );

  it.each(Object.entries(CAPABILITIES))(
    "%s lowers every served clause to a server-page param",
    (_host, capability) => {
      for (const clause of SERVED_CLAUSES) {
        const lowered = lowerBranchListQueryExpression(
          expressionOf([clause]),
          capability,
          SERVER_PAGE_TARGET
        );
        expect(lowered.ok, JSON.stringify(clause)).toBe(true);
      }
    }
  );
});

describe("lowerBranchListQueryExpression", () => {
  it("writes set values, typed bounds and the one sort rule", () => {
    const lowered = lower({
      version: LIST_QUERY_EXPRESSION_VERSION,
      filters: [
        anyOf(BranchListField.Owner, ["alice"]),
        {
          field: BranchListField.Changes,
          operator: ListFilterOperator.IsBetween,
          min: 5,
          max: 50,
        },
        {
          field: BranchListField.LastActivity,
          operator: ListFilterOperator.IsBetween,
          min: "2026-10-01T00:00:00",
        },
      ],
      sorts: [
        {
          field: BranchListSortKey.PullRequest,
          direction: BranchListSortDirection.Desc,
        },
      ],
    });

    expect(lowered).toEqual({
      ok: true,
      params: {
        owners: ["alice"],
        locMin: 5,
        locMax: 50,
        // ISS-9585: an offsetless bound names a UTC instant.
        startDate: "2026-10-01T00:00:00Z",
        sortKey: BranchListSortKey.PullRequest,
        sortDir: BranchListSortDirection.Desc,
      },
    });
  });

  it("lowers isEmpty and includeEmpty through the no-value token", () => {
    expect(
      lower(
        expressionOf([
          {
            field: BranchListField.PullRequest,
            operator: ListFilterOperator.IsEmpty,
          },
          {
            field: BranchListField.Priority,
            operator: ListFilterOperator.IsAnyOf,
            values: [Priority.High],
            includeEmpty: true,
          },
        ])
      )
    ).toEqual({
      ok: true,
      params: {
        pullRequests: [BranchListPullRequestPresence.None],
        priorities: [Priority.High, PRIORITY_UNSET_VALUE],
      },
    });
  });

  // The date window keeps empty rows by default; no param drops them.
  it("serves the window's own includeEmpty default and refuses the opposite", () => {
    const window = {
      field: BranchListField.LastActivity,
      operator: ListFilterOperator.IsBetween,
      min: "2026-10-01T00:00:00.000Z",
    } as const;

    expect(lower(expressionOf([{ ...window, includeEmpty: true }])).ok).toBe(
      true
    );
    expect(lower(expressionOf([{ ...window, includeEmpty: false }]))).toEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.UnsupportedOperator,
        details: {
          field: BranchListField.LastActivity,
          operator: ListFilterOperator.IsNotEmpty,
        },
      },
    });
  });

  it("refuses a value outside a closed vocabulary", () => {
    expect(
      lower(expressionOf([anyOf(BranchListField.Status, ["stale"])]))
    ).toEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.Malformed,
        details: {
          field: BranchListField.Status,
          operator: ListFilterOperator.IsAnyOf,
        },
      },
    });
  });

  it("refuses a second sort rule and a sort on a field with no sort key", () => {
    expect(
      lower({
        version: LIST_QUERY_EXPRESSION_VERSION,
        sorts: [
          { field: BranchListSortKey.Name, direction: "asc" },
          { field: BranchListSortKey.Repo, direction: "asc" },
        ],
      })
    ).toEqual({
      ok: false,
      refused: { code: ListQueryRefusal.TooManySortRules, details: {} },
    });
    expect(
      lower({
        version: LIST_QUERY_EXPRESSION_VERSION,
        sorts: [{ field: BranchListField.Tags, direction: "asc" }],
      })
    ).toEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.UnsupportedField,
        details: { field: BranchListField.Tags },
      },
    });
  });

  it("refuses a clause whose param the target does not accept", () => {
    const datesOnly: ListQueryLoweringTarget = {
      acceptedParams: new Set(["startDate", "endDate"]),
      repeatableParams: SERVER_PAGE_TARGET.repeatableParams,
    };

    expect(
      lowerBranchListQueryExpression(
        expressionOf([anyOf(BranchListField.Name, ["feat/a"])]),
        CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
        datesOnly
      )
    ).toEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.UnsupportedField,
        details: { field: BranchListField.Name },
      },
    });
  });
});

/** One served clause per filterable field and operator. */
const SERVED_CLAUSES: readonly ListFilterClause[] = [
  anyOf(BranchListField.Name, ["feat/a"]),
  anyOf(BranchListField.Owner, ["alice"]),
  anyOf(BranchListField.Collaborators, ["bob"]),
  anyOf(BranchListField.Status, Object.values(BranchStatus)),
  anyOf(BranchListField.PullRequest, [BranchListPullRequestPresence.Linked]),
  { field: BranchListField.PullRequest, operator: ListFilterOperator.IsEmpty },
  anyOf(BranchListField.LastActivity, [
    BranchListLastActiveRange.WithinLastHour,
  ]),
  {
    field: BranchListField.LastActivity,
    operator: ListFilterOperator.IsBetween,
    max: "2026-10-01T00:00:00.000Z",
  },
  anyOf(BranchListField.Repo, ["acme/web"]),
  anyOf(BranchListField.Tags, ["backend"]),
  anyOf(BranchListField.Priority, [Priority.Low]),
  { field: BranchListField.Priority, operator: ListFilterOperator.IsEmpty },
  { field: BranchListField.Priority, operator: ListFilterOperator.IsNotEmpty },
  {
    field: BranchListField.Changes,
    operator: ListFilterOperator.IsBetween,
    min: 1,
  },
];

/** The operators the registry has a legacy spelling for on `field`. */
function lowerableOperators(field: BranchListField): ListFilterOperator[] {
  const spec = BRANCH_LIST_QUERY_FIELDS[field];
  return [
    ...(spec.anyOf ? [ListFilterOperator.IsAnyOf] : []),
    ...(spec.anyOf?.emptyToken === undefined
      ? []
      : [ListFilterOperator.IsEmpty]),
    ...(spec.anyOf?.nonEmptyValues ? [ListFilterOperator.IsNotEmpty] : []),
    ...(spec.between ? [ListFilterOperator.IsBetween] : []),
  ];
}

function lower(
  expression: ListQueryExpression,
  capability: ListQueryCapability = CLOUD_BRANCH_LIST_QUERY_CAPABILITY
) {
  return lowerBranchListQueryExpression(
    expression,
    capability,
    SERVER_PAGE_TARGET
  );
}

function anyOf(field: string, values: string[]): ListFilterClause {
  return { field, operator: ListFilterOperator.IsAnyOf, values };
}
