import { describe, expect, it } from "vitest";
import {
  BRANCH_LIST_NON_FIELD_PARAMS,
  BRANCH_LIST_QUERY_FIELDS,
  type BranchListLegacyFilterParam,
} from "../branch-list-query-registry.ts";
import { branchStatusOrderingFor } from "../branch-status-order.ts";
import { CUSTOM_FIELD_FILTER_MAX_FACETS } from "../custom-field-list-query.ts";
import {
  LIST_QUERY_MAX_CLAUSES,
  type ListFieldSpec,
  ListSortRank,
  listFieldLegacyParams,
} from "../list-query-expression.ts";
import {
  BRANCH_LIST_FIELD_BY_FILTER_FACET,
  BranchListField,
  LIST_QUERY_SEMANTIC_SORT_RANKS,
  SessionListField,
} from "../list-query-fields.ts";
import { PRIORITY_ORDINAL } from "../search-query.ts";
import { SESSION_LIST_QUERY_FIELDS } from "../session-list-query-registry.ts";

/**
 * Which field claims each `BranchServerPageQuery` filter param. A literal
 * `Record` keyed by the param union, so a new filter axis on the Branches
 * server-page query fails `tsc` here until a field claims it.
 */
const BRANCH_FIELD_BY_FILTER_PARAM = {
  startDate: BranchListField.LastActivity,
  endDate: BranchListField.LastActivity,
  names: BranchListField.Name,
  owners: BranchListField.Owner,
  collaborators: BranchListField.Collaborators,
  statuses: BranchListField.Status,
  pullRequests: BranchListField.PullRequest,
  lastActiveRanges: BranchListField.LastActivity,
  repositories: BranchListField.Repo,
  tags: BranchListField.Tags,
  priorities: BranchListField.Priority,
  locMin: BranchListField.Changes,
  locMax: BranchListField.Changes,
} satisfies Record<BranchListLegacyFilterParam, BranchListField>;

/** Every (param, field) claim in a registry, duplicates kept. */
function claimedParams(
  registry: Readonly<Record<string, ListFieldSpec<string>>>
): [string, string][] {
  return Object.entries(registry).flatMap(([field, spec]) =>
    listFieldLegacyParams(spec).map((param): [string, string] => [param, field])
  );
}

describe("Branches field registry", () => {
  it("claims every server-page filter param exactly once, by the right field", () => {
    const claims = claimedParams(BRANCH_LIST_QUERY_FIELDS);
    expect(Object.fromEntries(claims)).toEqual(BRANCH_FIELD_BY_FILTER_PARAM);
    expect(claims).toHaveLength(
      Object.keys(BRANCH_FIELD_BY_FILTER_PARAM).length
    );
  });

  it("maps every filter facet to a field that can filter", () => {
    for (const [facet, field] of Object.entries(
      BRANCH_LIST_FIELD_BY_FILTER_FACET
    )) {
      const spec = BRANCH_LIST_QUERY_FIELDS[field];
      expect(spec.anyOf ?? spec.between, `${facet} → ${field}`).not.toBeNull();
    }
  });

  it("fits a clause on every filterable field plus every custom-field facet", () => {
    const filterable = Object.values(BRANCH_LIST_QUERY_FIELDS).filter(
      (spec) => spec.anyOf !== null || spec.between !== null
    ).length;
    expect(filterable + CUSTOM_FIELD_FILTER_MAX_FACETS).toBeLessThanOrEqual(
      LIST_QUERY_MAX_CLAUSES
    );
  });

  it("keeps paging and the legacy sort pair out of the fields", () => {
    const claimed = new Set(
      claimedParams(BRANCH_LIST_QUERY_FIELDS).map(([param]) => param)
    );
    for (const param of Object.keys(BRANCH_LIST_NON_FIELD_PARAMS)) {
      expect(claimed.has(param)).toBe(false);
    }
  });

  it("keeps the date window's null rows and drops the LOC range's", () => {
    expect(
      BRANCH_LIST_QUERY_FIELDS[BranchListField.LastActivity].between
        ?.includeEmptyByDefault
    ).toBe(true);
    expect(
      BRANCH_LIST_QUERY_FIELDS[BranchListField.LastActivity].anyOf
        ?.includeEmptyByDefault
    ).toBe(false);
    expect(
      BRANCH_LIST_QUERY_FIELDS[BranchListField.Changes].between
        ?.includeEmptyByDefault
    ).toBe(false);
  });

  it("ranks status by the branch status ordering and priority by PRIORITY_ORDINAL", () => {
    expect(BRANCH_LIST_QUERY_FIELDS[BranchListField.Status].sortRank).toBe(
      ListSortRank.BranchStatusOrdering
    );
    expect(BRANCH_LIST_QUERY_FIELDS[BranchListField.Priority].sortRank).toBe(
      ListSortRank.PriorityOrdinal
    );
  });
});

describe("Sessions field registry", () => {
  // Coverage of the AgentSessionListQuery keys is pinned in apps/api
  // (list-query-session-registry.test.ts), which can see that schema.
  it("claims no legacy filter param twice", () => {
    const params = claimedParams(SESSION_LIST_QUERY_FIELDS).map(
      ([param]) => param
    );
    expect(new Set(params).size).toBe(params.length);
  });

  it("keeps session status on raw-string order and priority on PRIORITY_ORDINAL", () => {
    expect(SESSION_LIST_QUERY_FIELDS[SessionListField.Status].sortRank).toBe(
      ListSortRank.Value
    );
    expect(SESSION_LIST_QUERY_FIELDS[SessionListField.Priority].sortRank).toBe(
      ListSortRank.PriorityOrdinal
    );
  });
});

describe("semantic sort rank sources", () => {
  it("are the canonical consts themselves", () => {
    expect(LIST_QUERY_SEMANTIC_SORT_RANKS[ListSortRank.PriorityOrdinal]).toBe(
      PRIORITY_ORDINAL
    );
    expect(
      LIST_QUERY_SEMANTIC_SORT_RANKS[ListSortRank.BranchStatusOrdering]
    ).toBe(branchStatusOrderingFor);
  });
});
