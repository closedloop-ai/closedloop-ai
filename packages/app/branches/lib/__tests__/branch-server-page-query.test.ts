import type { BranchQueryFilters } from "@repo/api/src/types/branch";
import {
  BranchSessionPresence,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { branchListCohortKey } from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_MAX_OFFSET,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { branchServerPageQuerySchema } from "@repo/api/src/types/branch-list-contract-schema";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { resolveMaxPageIndex } from "@repo/api/src/utils/math";
import { describe, expect, it } from "vitest";
import type { BranchFilters } from "../branch-row";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import {
  buildBranchServerPageFilters,
  isBranchServerPageResponse,
} from "../branch-server-page-query";

const CONSUMER_PAGE = 2;
const CONSUMER_START_DATE = "2026-08-01T00:00:00.000Z";
const CONSUMER_END_DATE = "2026-08-18T23:59:59.999Z";

/**
 * Every `BranchFilters` facet paired with the server-page key the builder must
 * send it under, or `null` for the one facet it deliberately drops.
 *
 * `satisfies Record<keyof BranchFilters, ...>` alone only forces a new facet to
 * be GIVEN a fixture value; pairing each with its wire key is what makes an
 * UNWIRED one fail, because the mapping assertion builds its expectation here.
 */
const FACET_WIRE_KEYS = {
  names: "names",
  statuses: "statuses",
  owners: "owners",
  collaborators: "collaborators",
  repos: "repositories",
  pullRequests: "pullRequests",
  lastActiveRanges: "lastActiveRanges",
  tags: "tags",
  // ISS-10332: the priority facet, members plus the unset token.
  priorities: "priorities",
  locMin: "locMin",
  locMax: "locMax",
  search: "search",
  // Legacy-only compatibility state; approved List controls never expose it and
  // the builder never sends it.
  sessionPresence: null,
} satisfies Record<keyof BranchFilters, keyof BranchQueryFilters | null>;

/**
 * One value for EVERY facet above, so all their mappings are exercised at once.
 *
 * Several values carry surrounding whitespace on purpose: a bookmarked
 * `?tag=release+` decodes to `"release "`, and the Desktop producer's schema
 * trims it, so the key must fold whitespace or the two sides name different
 * requests (ISS-7125).
 */
const EXERCISED_BRANCH_FILTERS = {
  names: ["feature/x", " feature/padded "],
  statuses: [BranchStatus.Open, BranchStatus.Merged],
  owners: ["closedloop:user-1"],
  collaborators: ["closedloop:user-2", "closedloop:user-3"],
  repos: ["closedloop-ai/closedloop-ai", "closedloop-ai/pensero"],
  pullRequests: [BranchListPullRequestPresence.Linked],
  lastActiveRanges: [BranchListLastActiveRange.WithinLastHour],
  tags: ["release ", " hotfix"],
  priorities: [Priority.High, PRIORITY_UNSET_VALUE],
  // Non-empty on purpose: what proves the builder's omission is a decision.
  sessionPresence: [BranchSessionPresence.Has],
  locMin: 5,
  locMax: 500,
  search: "feature",
} satisfies BranchFilters & Record<keyof BranchFilters, unknown>;

describe("branch server-page consumer query", () => {
  /**
   * `resolveBranchCohortNotice` trusts a producer cohort only when its
   * `cohortKey` equals the key of the filter set the list is rendering, so the
   * two must normalize to one string or every notice on the server-page path
   * fails closed and reverts to the page-derived undercount.
   *
   * This pins the DESKTOP pair against both real implementations: the Desktop
   * main parses the renderer's request through `branchServerPageQueryShape`
   * (`coerceSharedBranchesQuery`) and keys the PARSED value, and that shape is
   * `branchServerPageQuerySchema` — reachable from here, so no hand-mirror.
   * The CLOUD producer keys post-`branchListQuerySchema`, which lives in
   * `apps/api` and `packages/app` may not depend on; that half is pinned by
   * `apps/api/app/branches/branch-list-query.test.ts` against the wire shape
   * this builder emits, and is NOT pinned here.
   */
  it("keys identically to the Desktop producer's post-coercion query", () => {
    const consumerFilters = buildBranchServerPageFilters({
      filters: EXERCISED_BRANCH_FILTERS,
      page: CONSUMER_PAGE,
      sortKey: BranchListSortKey.Owner,
      sortDir: BranchListSortDirection.Asc,
      startDate: CONSUMER_START_DATE,
      endDate: CONSUMER_END_DATE,
    });
    const producerQuery = branchServerPageQuerySchema.parse(consumerFilters);

    expect(branchListCohortKey(consumerFilters)).toBe(
      branchListCohortKey(producerQuery)
    );
  });

  it("sends a trimmed, capped search the contract accepts, and none for a blank one", () => {
    const filtersFor = (search: string) =>
      buildBranchServerPageFilters({
        filters: { ...DEFAULT_BRANCH_FILTERS, search },
        page: CONSUMER_PAGE,
        sortKey: BranchListSortKey.Owner,
        sortDir: BranchListSortDirection.Asc,
        startDate: CONSUMER_START_DATE,
        endDate: CONSUMER_END_DATE,
      });

    expect(filtersFor(" ").search).toBeUndefined();
    expect(filtersFor("  feature  ").search).toBe("feature");
    for (const search of [" ", "  feature  ", "x".repeat(300)]) {
      expect(() =>
        branchServerPageQuerySchema.parse(filtersFor(search))
      ).not.toThrow();
    }
    expect(filtersFor("x".repeat(300)).search).toHaveLength(200);
  });

  it("keys one filter set identically across its pages and sorts", () => {
    const atPage = (page: number, sortDir: BranchListSortDirection) =>
      branchListCohortKey(
        buildBranchServerPageFilters({
          filters: { ...DEFAULT_BRANCH_FILTERS, owners: ["closedloop:user-1"] },
          page,
          sortKey: BranchListSortKey.Owner,
          sortDir,
          startDate: "2026-08-01T00:00:00.000Z",
        })
      );

    expect(atPage(3, BranchListSortDirection.Desc)).toBe(
      atPage(0, BranchListSortDirection.Asc)
    );
  });

  // Every facet at once, asserted whole: dropping ANY single mapping from the
  // builder reds this, which a fixture setting only five of them could not do.
  it("maps every active control under its wire name", () => {
    expect(
      buildBranchServerPageFilters({
        filters: EXERCISED_BRANCH_FILTERS,
        page: CONSUMER_PAGE,
        sortKey: BranchListSortKey.Owner,
        sortDir: BranchListSortDirection.Asc,
        startDate: CONSUMER_START_DATE,
        endDate: CONSUMER_END_DATE,
      })
    ).toEqual({
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: CONSUMER_PAGE * BRANCH_LIST_SERVER_PAGE_SIZE,
      startDate: CONSUMER_START_DATE,
      endDate: CONSUMER_END_DATE,
      sortKey: BranchListSortKey.Owner,
      sortDir: BranchListSortDirection.Asc,
      ...expectedWireFacets(),
    });
  });

  it("omits empty facets and the legacy-only session-presence control", () => {
    expect(
      buildBranchServerPageFilters({
        filters: {
          ...DEFAULT_BRANCH_FILTERS,
          sessionPresence: [BranchSessionPresence.Has],
        },
        page: 0,
        sortKey: BranchListSortKey.Owner,
        sortDir: BranchListSortDirection.Asc,
      })
    ).toEqual({
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      sortKey: BranchListSortKey.Owner,
      sortDir: BranchListSortDirection.Asc,
    });
  });

  it("maps the Grid Table v2 page size into the server page boundary", () => {
    expect(
      buildBranchServerPageFilters({
        filters: DEFAULT_BRANCH_FILTERS,
        page: 2,
        pageSize: 50,
        sortKey: BranchListSortKey.LastActivity,
        sortDir: BranchListSortDirection.Desc,
      })
    ).toEqual({
      pageMode: BranchListPageMode.Server,
      limit: 50,
      offset: 100,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    });
  });

  it("clamps an over-cap page to the last servable offset (ISS-10434)", () => {
    const pageSize = 25;
    const maxPage = resolveMaxPageIndex(BRANCH_LIST_MAX_OFFSET, pageSize);
    const result = buildBranchServerPageFilters({
      filters: DEFAULT_BRANCH_FILTERS,
      page: 400_000_000_000_000,
      pageSize,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    });
    expect(result.offset).toBe(maxPage * pageSize);
    expect(Number.isSafeInteger(result.offset)).toBe(true);
    expect(result.offset).toBeLessThanOrEqual(BRANCH_LIST_MAX_OFFSET);
  });

  it("leaves a normal page unchanged after the clamp (ISS-10434)", () => {
    const result = buildBranchServerPageFilters({
      filters: DEFAULT_BRANCH_FILTERS,
      page: 3,
      pageSize: 25,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    });
    expect(result.offset).toBe(75);
  });

  it("requires the complete validated envelope before cutting over", () => {
    expect(
      isBranchServerPageResponse({
        pageInfo: { capability: BranchListCapability.ServerPaginationV1 },
      })
    ).toBe(false);
    expect(
      isBranchServerPageResponse({
        ...validServerPage(),
        facets: null,
      })
    ).toBe(false);
    expect(isBranchServerPageResponse(validServerPage())).toBe(true);
    expect(isBranchServerPageResponse({ facets: {} })).toBe(false);
  });
});

/** The wire half of `FACET_WIRE_KEYS`, valued from the exercised fixture. */
function expectedWireFacets(): Record<string, unknown> {
  const expected: Record<string, unknown> = {};
  for (const [facet, wireKey] of Object.entries(FACET_WIRE_KEYS)) {
    if (wireKey !== null) {
      expected[wireKey] =
        EXERCISED_BRANCH_FILTERS[facet as keyof BranchFilters];
    }
  }
  return expected;
}

function validServerPage() {
  const facet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    items: [
      {
        id: "branch",
        branchName: "feature/branch",
        baseBranch: "main",
        repoFullName: "acme/web",
        owner: null,
        status: BranchStatus.Open,
        prNumber: null,
        prTitle: null,
        prState: null,
        prUrl: null,
        multiPrWarning: false,
        checksStatus: null,
        checksPassed: null,
        checksTotal: null,
        reviewDecision: null,
        ahead: null,
        behind: null,
        additions: null,
        deletions: null,
        filesChanged: null,
        lastActivityAt: "",
        sessionIds: [],
        estimatedCostUsd: null,
      },
    ],
    total: 1,
    viewerScope: BranchViewerScope.Organization,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      requestedOffset: 0,
      now: "2026-08-18T18:00:00.000Z",
    },
    facets: {
      names: facet,
      owners: facet,
      collaborators: facet,
      statuses: facet,
      pullRequests: facet,
      lastActiveRanges: facet,
      repositories: facet,
      tags: facet,
    },
  };
}
