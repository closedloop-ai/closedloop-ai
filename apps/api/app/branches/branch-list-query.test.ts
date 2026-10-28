import {
  BRANCH_SESSION_PRESENCE_PARAM,
  BranchSessionPresence,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { branchListCohortKey } from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_MAX_FILTER_VALUES,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { CLOUD_BRANCH_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/branch-list-query-capabilities";
import { BRANCH_LIST_QUERY_VOCABULARY } from "@repo/api/src/types/branch-list-query-registry";
import { Priority } from "@repo/api/src/types/common";
import { BranchListField } from "@repo/api/src/types/list-query-fields";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { describe, expect, it } from "vitest";
import {
  BRANCH_LIST_QUERY_PARAM_KEYS,
  branchAnalyticsQuerySchema,
  branchListQuerySchema,
} from "./branch-list-query";
import { toBranchServerPageQuery } from "./branch-server-page-query";

describe("branchListQuerySchema priority (ISS-10332)", () => {
  const serverPage = {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
  };

  it("accepts the priority sort and the priorities facet, and carries both into the strict page query", () => {
    const parsed = branchListQuerySchema.parse({
      ...serverPage,
      sortKey: BranchListSortKey.Priority,
      priorities: [Priority.High, PRIORITY_UNSET_VALUE],
    });
    expect(toBranchServerPageQuery(parsed)).toMatchObject({
      sortKey: BranchListSortKey.Priority,
      priorities: [Priority.High, PRIORITY_UNSET_VALUE],
    });
    // One repeated-key value arrives as a scalar.
    expect(
      branchListQuerySchema.parse({ ...serverPage, priorities: Priority.Low })
        .priorities
    ).toEqual([Priority.Low]);
    // Absent stays absent: no key is serialized into the page query.
    expect(
      toBranchServerPageQuery(branchListQuerySchema.parse(serverPage))
    ).not.toHaveProperty("priorities");
  });

  it("rejects an off-vocabulary priority, and the facet outside server page mode", () => {
    expect(
      branchListQuerySchema.safeParse({ ...serverPage, priorities: ["urgent"] })
        .success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({ priorities: [Priority.Low] }).success
    ).toBe(false);
  });
});

describe("branchListQuerySchema server-page vocabulary", () => {
  it("accepts every aligned filter and rejects unsupported or unaligned input", () => {
    const query = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 40,
      names: ["feature/x"],
      owners: ["closedloop:user-1"],
      collaborators: ["github:2"],
      statuses: [BranchStatus.Review, BranchStatus.Blocked],
      pullRequests: [BranchListPullRequestPresence.Linked],
      lastActiveRanges: [BranchListLastActiveRange.WithinLastHour],
      repositories: ["closedloop-ai/closedloop-ai"],
      tags: ["tag-1"],
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    };

    expect(branchListQuerySchema.parse(query)).toMatchObject(query);
    expect(
      branchListQuerySchema.parse({ ...query, limit: 50, offset: 100 })
    ).toMatchObject({ limit: 50, offset: 100 });
    expect(
      branchListQuerySchema.safeParse({ ...query, limit: 30 }).success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({ ...query, offset: 1 }).success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({ ...query, limit: 50, offset: 40 })
        .success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({
        ...query,
        unsupportedFacet: ["x"],
      }).success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({ ...query, repo: ["acme/web"] }).success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({
        ...query,
        [BRANCH_SESSION_PRESENCE_PARAM]: BranchSessionPresence.Has,
      }).success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({ names: ["feature/x"] }).success
    ).toBe(false);
  });

  it("keeps every advertised aligned page and canonical filter selection reachable", () => {
    const names = Array.from(
      { length: BRANCH_LIST_MAX_FILTER_VALUES },
      (_, index) => `feature/${index}`
    );
    const query = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 10_020,
      names,
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    };

    expect(branchListQuerySchema.parse(query)).toMatchObject(query);
    expect(
      branchListQuerySchema.safeParse({
        ...query,
        names: [...names, "feature/overflow"],
      }).success
    ).toBe(false);
  });

  /**
   * The cloud list keys `branchListCohortKey(snapshotQuery)` — the value THIS
   * schema parsed to — and the browser rebuilds the key from the wire query it
   * sent (`buildBranchServerPageFilters`). If a coercion here rewrites a value
   * the key can see, the two name different requests, `resolveBranchCohortNotice`
   * rejects the cohort, and the notice silently reverts to the page-scoped
   * undercount.
   *
   * The consumer builder lives in `@repo/app`, which `apps/api` does not (and
   * must not) depend on, so this pins the PRODUCER half only: the wire shape
   * below is what that builder emits at full facet coverage, held byte-stable
   * by the `toEqual` in its own suite. A change here that adds a facet default
   * or rewrites a facet value reds this; a change to the BUILDER does not.
   */
  it("parses a full server-page query without rewriting its cohort key", () => {
    const wireQuery = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 40,
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-08-18T23:59:59.999Z",
      names: ["feature/x", "feature/y"],
      owners: ["closedloop:user-1"],
      collaborators: ["closedloop:user-2", "closedloop:user-3"],
      statuses: [BranchStatus.Open, BranchStatus.Merged],
      pullRequests: [BranchListPullRequestPresence.Linked],
      lastActiveRanges: [BranchListLastActiveRange.WithinLastHour],
      repositories: ["closedloop-ai/closedloop-ai", "closedloop-ai/pensero"],
      tags: ["release", "hotfix"],
      locMin: 5,
      locMax: 500,
      sortKey: BranchListSortKey.Owner,
      sortDir: BranchListSortDirection.Asc,
    };

    expect(branchListCohortKey(branchListQuerySchema.parse(wireQuery))).toBe(
      branchListCohortKey(wireQuery)
    );

    // The builder OMITS an empty facet rather than sending `[]`, so a facet
    // that gained a `.default([])` here would key a filter the browser never
    // sent. Only a query with no optional facets can catch that.
    const minimalWireQuery = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    };

    expect(
      branchListCohortKey(branchListQuerySchema.parse(minimalWireQuery))
    ).toBe(branchListCohortKey(minimalWireQuery));
  });

  it("injects internal paging only after analytics omits wire limit and offset", () => {
    expect(
      branchAnalyticsQuerySchema.parse({
        pageMode: BranchListPageMode.Server,
        names: ["feature/x"],
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      })
    ).toMatchObject({
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      names: ["feature/x"],
    });
  });
});

// PRD-721: the `listQuery` mixing rule and the client builder read the
// registry's classification of every list param, so a param this schema
// admits that the registry does not classify would travel beside an
// expression unjudged.
describe("Branches listQuery vocabulary", () => {
  it("classifies every param the list schema admits", () => {
    const unclassified = BRANCH_LIST_QUERY_PARAM_KEYS.filter(
      (name) =>
        !(
          BRANCH_LIST_QUERY_VOCABULARY.fieldByLegacyParam.has(name) ||
          Object.hasOwn(BRANCH_LIST_QUERY_VOCABULARY.nonFieldParams, name)
        )
    );
    expect(unclassified).toEqual([]);
  });

  it("declares exactly the statuses and recency buckets the schema reads", () => {
    const fields = CLOUD_BRANCH_LIST_QUERY_CAPABILITY.fields;
    const statuses = fields[BranchListField.Status]?.values ?? [];
    const ranges = fields[BranchListField.LastActivity]?.values ?? [];
    const serverPage = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
    };

    expect(
      branchListQuerySchema.parse({ ...serverPage, statuses: [...statuses] })
    ).toMatchObject({ statuses });
    expect(
      branchListQuerySchema.parse({
        ...serverPage,
        lastActiveRanges: [...ranges],
      })
    ).toMatchObject({ lastActiveRanges: ranges });
    expect(
      branchListQuerySchema.safeParse({ ...serverPage, statuses: ["stale"] })
        .success
    ).toBe(false);
  });
});
