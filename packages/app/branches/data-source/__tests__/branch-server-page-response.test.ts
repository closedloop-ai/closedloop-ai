import {
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchListCohortScope,
  completeBranchLastActiveCohort,
} from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BRANCH_LIST_SERVER_PAGE_SIZE_MAX,
  BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS,
  BranchListPageMode,
  type BranchListServerPageSize,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { buildBranchServerPage } from "@repo/lib/branches/branch-list-page";
import { describe, expect, it } from "vitest";
import { adaptBranchRows } from "../../lib/branch-row-adapter";
import {
  hasBranchServerPageCapability,
  parseBranchServerPageResponse,
} from "../branch-server-page-response";

const NOW = "2026-08-18T18:00:00.000Z";
const ARTIFACT_ID = "0199d0a4-0000-7000-8000-000000000001";

describe("branch server-page response boundary", () => {
  it("accepts the complete envelope and additive optional maps", () => {
    const response = serverPage();
    expect(parseBranchServerPageResponse(response)).toEqual(response);
  });

  // This fixture used to carry the base `total: 1` with one row at `offset: 50`
  // — a page whose rows reach position 51 of a 1-row population, which ISS-9668
  // made a validation failure. The EXPECTATION here is unchanged (Grid Table v2
  // page sizes are accepted, a misaligned offset is not); only the fixture was
  // repaired to a page a producer could actually emit: the last page of a
  // 51-row cohort at limit 50.
  it("accepts Grid Table v2 page-size metadata when offsets align to that size", () => {
    const response = {
      ...serverPage(),
      total: 51,
      pageInfo: {
        ...serverPage().pageInfo,
        limit: 50,
        offset: 50,
        requestedOffset: 50,
      },
    };

    expect(parseBranchServerPageResponse(response)).toEqual(response);
    expect(() =>
      parseBranchServerPageResponse({
        ...response,
        pageInfo: { ...response.pageInfo, offset: 20 },
      })
    ).toThrow();
  });

  // ISS-9668: `items` was bounded from ABOVE only, so a page could declare
  // itself the LAST page while rows still counted in `total` had never been
  // delivered — the exact shape that renders a prefix as the whole population.
  // Literals are pinned here rather than derived from the schema's own
  // arithmetic, so the implementation cannot move the goalposts.
  it("rejects a truncated page that claims no rows remain", () => {
    const truncated = {
      ...serverPage(),
      items: rows(5),
      total: 60,
      hasMore: false,
      pageInfo: { ...serverPage().pageInfo, limit: 20, offset: 0 },
    };

    expect(hasBranchServerPageCapability(truncated)).toBe(true);
    expect(() => parseBranchServerPageResponse(truncated)).toThrow();
  });

  it("accepts a short page that is genuinely the last page of the cohort", () => {
    const lastPage = {
      ...serverPage(),
      items: rows(5),
      total: 25,
      hasMore: false,
      pageInfo: {
        ...serverPage().pageInfo,
        limit: 20,
        offset: 20,
        requestedOffset: 20,
      },
    };

    expect(parseBranchServerPageResponse(lastPage).items).toHaveLength(5);
  });

  it("rejects a page claiming more rows exist once it has reached the total", () => {
    const lying = {
      ...serverPage(),
      items: rows(20),
      total: 20,
      hasMore: true,
      pageInfo: { ...serverPage().pageInfo, limit: 20, offset: 0 },
    };

    expect(() => parseBranchServerPageResponse(lying)).toThrow();
  });

  it("rejects a page whose rows reach past the population it reports", () => {
    const overreaching = {
      ...serverPage(),
      items: rows(20),
      total: 5,
      pageInfo: { ...serverPage().pageInfo, limit: 20, offset: 0 },
    };

    expect(() => parseBranchServerPageResponse(overreaching)).toThrow();
  });

  // Version skew: a producer that never sends `hasMore` makes no completeness
  // claim for the schema to contradict, so a short page from one stays valid —
  // the surface still reads its own `total` and keeps paging.
  it("keeps accepting a short page from a producer that omits hasMore", () => {
    const { hasMore: _hasMore, ...withoutHasMore } = {
      ...serverPage(),
      items: rows(5),
      total: 60,
      pageInfo: { ...serverPage().pageInfo, limit: 20, offset: 0 },
      hasMore: true,
    };

    expect(parseBranchServerPageResponse(withoutHasMore).items).toHaveLength(5);
  });

  // The load-bearing regression: a population LARGER THAN ONE PAGE must fully
  // arrive, and the boundary must accept every page of it. Driven through the
  // real producer rather than hand-built envelopes, so a rule that a conformant
  // page cannot satisfy fails here — which is exactly how the first draft of
  // this validator was caught rejecting legitimate short pages.
  it("carries a population larger than one page across pages with no rows lost", () => {
    const population = 45;
    const pageSize = 20;
    const cohort = rows(population);
    const pages = [0, 20, 40].map((offset) =>
      parseBranchServerPageResponse({
        ...buildBranchServerPage(
          cohort,
          {
            pageMode: BranchListPageMode.Server,
            limit: pageSize,
            offset,
            sortKey: BranchListSortKey.Name,
            sortDir: BranchListSortDirection.Asc,
          },
          NOW
        ),
        viewerScope: BranchViewerScope.Organization,
      })
    );

    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 5]);
    expect(
      new Set(pages.flatMap((page) => page.items.map((i) => i.id))).size
    ).toBe(population);
  });

  it("accepts the largest configured server-page option", () => {
    const pageSize = largestPageSizeOption();
    const response = {
      ...buildBranchServerPage(
        rows(pageSize),
        {
          pageMode: BranchListPageMode.Server,
          limit: pageSize,
          offset: 0,
          sortKey: BranchListSortKey.LastActivity,
          sortDir: BranchListSortDirection.Desc,
        },
        NOW
      ),
      viewerScope: BranchViewerScope.Organization,
    };

    expect(BRANCH_LIST_SERVER_PAGE_SIZE_MAX).toBe(pageSize);
    expect(parseBranchServerPageResponse(response).items).toHaveLength(
      pageSize
    );
  });

  it("rejects pages with more rows than the negotiated page limit", () => {
    const response = {
      ...serverPage(),
      items: Array.from({ length: 26 }, (_value, index) => ({
        ...row(),
        id: `branch-${index}`,
        branchName: `feature/branch-${index}`,
      })),
      total: 26,
      pageInfo: {
        ...serverPage().pageInfo,
        limit: 25,
      },
    };

    expect(hasBranchServerPageCapability(response)).toBe(true);
    expect(() => parseBranchServerPageResponse(response)).toThrow();
  });

  it.each([
    [
      "null facets",
      (value: ReturnType<typeof serverPage>) => ({ ...value, facets: null }),
    ],
    [
      "missing facet group",
      (value: ReturnType<typeof serverPage>) => {
        const { tags: _tags, ...facets } = value.facets;
        return { ...value, facets };
      },
    ],
    [
      "invalid page metadata",
      (value: ReturnType<typeof serverPage>) => ({
        ...value,
        pageInfo: { ...value.pageInfo, offset: 1 },
      }),
    ],
    [
      "invalid optional map",
      (value: ReturnType<typeof serverPage>) => ({
        ...value,
        sessionBranchCount: { session: 0 },
      }),
    ],
    [
      "malformed row",
      (value: ReturnType<typeof serverPage>) => ({
        ...value,
        items: [{ ...value.items[0], branchName: null }],
      }),
    ],
  ])("rejects a capability-bearing envelope with %s", (_name, mutate) => {
    const malformed = mutate(serverPage());
    expect(hasBranchServerPageCapability(malformed)).toBe(true);
    expect(() => parseBranchServerPageResponse(malformed)).toThrow();
  });

  // Behavior change (ISS-7356): "invalid cohort metadata" used to sit in the
  // reject table above. Rejecting the envelope errored the whole Branches page
  // over one optional field AND threw away `pageInfo.now`, so the clock fix
  // could never be reached on the path that needed it most. The expectation
  // moved because the contract did — the cohort is now dropped, not fatal.
  it.each([
    [
      "an unparseable evaluation instant",
      (value: ReturnType<typeof serverPage>) => ({
        ...value.lastActiveCohort,
        evaluationNow: "not-a-timestamp",
      }),
    ],
    [
      "counts that violate the total equation",
      (value: ReturnType<typeof serverPage>) => ({
        ...value.lastActiveCohort,
        retainedUnavailable: {
          ...value.lastActiveCohort.retainedUnavailable,
          value: 2,
        },
      }),
    ],
  ])("drops a present-but-invalid cohort carrying %s", (_name, mutate) => {
    const response = serverPage();
    const malformed = { ...response, lastActiveCohort: mutate(response) };

    const parsed = parseBranchServerPageResponse(malformed);

    // Absent, not present-but-empty: an empty object would still be "supplied"
    // and could shadow the envelope clock below.
    expect(parsed.lastActiveCohort).toBeUndefined();
    // The rest of the page survives intact — that is the whole point.
    expect(parsed.items).toEqual(response.items);
    expect(parsed.pageInfo?.now).toBe(NOW);
  });

  // ISS-8884: every nested object used to be `.strict()`, so one additive
  // producer field anywhere inside it failed the whole envelope and errored the
  // Branches page. One row per formerly-strict object.
  it.each<{
    name: string;
    skew: (page: ServerPage) => ServerPage;
    path: string[];
  }>([
    {
      name: "a ninth facet",
      skew: (page) => ({
        ...page,
        facets: { ...page.facets, phases: page.facets.names },
      }),
      path: ["facets", "phases"],
    },
    {
      name: "an extra key on a facet result",
      skew: (page) => ({
        ...page,
        facets: {
          ...page.facets,
          names: { ...page.facets.names, note: "additive" },
        },
      }),
      path: ["facets", "names", "note"],
    },
    {
      name: "an extra key on a facet option",
      skew: (page) => ({
        ...page,
        facets: {
          ...page.facets,
          names: {
            ...page.facets.names,
            options: [{ id: "a", label: "A", count: 1, description: "x" }],
          },
        },
      }),
      path: ["facets", "names", "options", "0", "description"],
    },
    {
      name: "an extra key on pageInfo",
      skew: (page) => ({
        ...page,
        pageInfo: { ...page.pageInfo, generatedBy: "newer-producer" },
      }),
      path: ["pageInfo", "generatedBy"],
    },
  ])("keeps the page when the producer adds $name", ({ skew, path }) => {
    const skewed = skew(serverPage());

    const parsed = parseBranchServerPageResponse(skewed);

    expect(Object.keys(parsed.facets ?? {})).toEqual(
      expect.arrayContaining(Object.keys(serverPage().facets))
    );
    expect(readPath(parsed, path)).toBeDefined();
    expect(parsed.items).toEqual(skewed.items);
  });

  // ISS-9456 version skew: a desktop built before a server starts sending a
  // row key it has never heard of must keep rendering the list. The row schema
  // stays open, and the key an artifact-keyed read needs is validated on the
  // way through.
  it("keeps a row key this build does not know and still adapts the row", () => {
    const page = serverPage();
    const newerRow = {
      ...row(),
      artifactId: ARTIFACT_ID,
      relatedSessions: [{ sessionId: "session", kind: "contribution" }],
    };
    const parsed = parseBranchServerPageResponse({
      ...page,
      items: [newerRow],
    });

    expect(parsed.items).toEqual([newerRow]);
    const [adapted] = adaptBranchRows(parsed.items);
    expect(adapted?.artifactId).toBe(ARTIFACT_ID);
    expect(adapted?.sessionCount).toBe(newerRow.sessionIds.length);
  });

  // A local or legacy producer omits the key; it must stay omitted, not
  // arrive as a present-but-undefined key.
  it("preserves an omitted artifactId as omitted", () => {
    const parsed = parseBranchServerPageResponse(serverPage());

    expect(
      parsed.items.every((item) => !Object.hasOwn(item, "artifactId"))
    ).toBe(true);
  });

  // A producer that sends something other than a non-empty string for
  // artifactId must not take the page down (a strict field would fail the
  // whole envelope), and must not hand that value to an artifact-keyed read.
  it.each([
    ["a number", 7],
    ["null", null],
    ["an empty string", ""],
  ])(
    "folds %s artifactId to absent and keeps the row",
    (_label, artifactId) => {
      const page = serverPage();
      const parsed = parseBranchServerPageResponse({
        ...page,
        items: [{ ...row(), artifactId }],
      });

      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]?.artifactId).toBeUndefined();
      const [adapted] = adaptBranchRows(parsed.items);
      expect(adapted?.artifactId).toBeUndefined();
      expect(adapted?.sessionCount).toBe(row().sessionIds.length);
    }
  );

  it("leaves a capability-absent legacy response eligible for fallback", () => {
    const { pageInfo: _pageInfo, facets: _facets, ...legacy } = serverPage();
    expect(hasBranchServerPageCapability(legacy)).toBe(false);
  });
});

function serverPage() {
  return {
    ...buildBranchServerPage(
      [row()],
      {
        pageMode: BranchListPageMode.Server,
        limit: BRANCH_LIST_SERVER_PAGE_SIZE,
        offset: 0,
        sortKey: BranchListSortKey.LastActivity,
        sortDir: BranchListSortDirection.Desc,
      },
      NOW
    ),
    viewerScope: BranchViewerScope.Organization,
    sessionCostUsd: { session: 1.25 },
    lifetimeSessionCostUsd: { session: 2.5 },
    sessionBranchCount: { session: 1 },
    lastActiveCohort: completeBranchLastActiveCohort({
      scope: BranchListCohortScope.RequestFilters,
      cohortKey: "{}",
      evaluationNow: new Date(NOW),
      total: 1,
      retainedUnavailable: 0,
    }),
  };
}

function row(): BranchRow {
  return {
    id: "branch",
    branchName: "feature/branch",
    baseBranch: "main",
    repoFullName: "acme/web",
    owner: "Alice",
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
    additions: 10,
    deletions: 5,
    filesChanged: 1,
    lastActivityAt: NOW,
    sessionIds: ["session"],
    estimatedCostUsd: 1.25,
  };
}

function rows(count: number): BranchRow[] {
  return Array.from({ length: count }, (_value, index) => ({
    ...row(),
    id: `branch-${index}`,
    branchName: `feature/branch-${index}`,
  }));
}

function largestPageSizeOption(): BranchListServerPageSize {
  const pageSize = BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS.at(-1);
  if (pageSize === undefined) {
    throw new Error("Branch server page-size options cannot be empty");
  }
  return pageSize;
}

type ServerPage = Record<string, unknown> & {
  facets: ReturnType<typeof serverPage>["facets"];
  pageInfo: ReturnType<typeof serverPage>["pageInfo"];
  items: ReturnType<typeof serverPage>["items"];
};

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
