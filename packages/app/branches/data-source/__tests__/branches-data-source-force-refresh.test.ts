import {
  type BranchAnalytics,
  type BranchListResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpBranchesDataSource } from "../branches-data-source";
import { makeBranchRow } from "./branch-row-test-fixture";

// ISS-7127: `forceRefresh` is honored only by a caching source. The cloud
// Branch routes parse with a `.strict()` validator, so leaking it into a query
// string 400s the required list read instead of being ignored.
describe("HTTP Branches transport-local forceRefresh", () => {
  // Restoring in the block, not at the end of the case that installs the fake
  // clock: a per-case restore is skipped the moment an assertion above it
  // throws, leaking a frozen clock into every later test in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("omits forceRefresh from every legacy list request", async () => {
    const paths: string[] = [];
    function get<T>(path: string): Promise<T> {
      paths.push(path);
      return Promise.resolve(makePage(offsetOf(path), 101) as T);
    }

    const result = await createHttpBranchesDataSource({ get }).list({
      repo: "acme/web",
      forceRefresh: true,
    });

    expect(result.total).toBe(101);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.every((path) => !path.includes("forceRefresh"))).toBe(true);
    expect(paths.every((path) => path.includes("repo=acme%2Fweb"))).toBe(true);
  });

  it("omits forceRefresh from both halves of a legacy page read", async () => {
    const paths: string[] = [];
    function get<T>(path: string): Promise<T> {
      paths.push(path);
      if (path.startsWith("/branches/analytics")) {
        return Promise.resolve({ activeBranches: 1 } as unknown as T);
      }
      return Promise.resolve(makePage(0, 1) as T);
    }

    const result = await createHttpBranchesDataSource({ get }).pageData({
      repo: "acme/web",
      forceRefresh: true,
    });

    expect(result.analyticsError).toBeUndefined();
    expect(
      paths.filter((path) => path.startsWith("/branches/analytics"))
    ).toHaveLength(1);
    expect(paths.filter((path) => path.startsWith("/branches?"))).toHaveLength(
      1
    );
    expect(paths.every((path) => !path.includes("forceRefresh"))).toBe(true);
  });

  it("omits forceRefresh from the server page list read", async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    const analytics = { activeBranches: 1 } as unknown as BranchAnalytics;
    function get<T>(path: string): Promise<T> {
      paths.push(path);
      if (path.startsWith("/branches/analytics")) {
        return Promise.resolve(analytics as T);
      }
      return Promise.resolve(serverPage() as T);
    }

    const pageDataPromise = createHttpBranchesDataSource({ get }).pageData({
      ...serverQuery(),
      forceRefresh: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await pageDataPromise;

    expect(result.analytics).toBe(analytics);
    const listPaths = paths.filter((path) => path.startsWith("/branches?"));
    expect(listPaths).toHaveLength(1);
    expect(listPaths[0]).toContain("pageMode=server");
    expect(listPaths[0]).not.toContain("evaluationNow=");
    expect(paths.every((path) => !path.includes("forceRefresh"))).toBe(true);
  });
});

function offsetOf(path: string): number {
  return Number(
    new URL(path, "https://closedloop.test").searchParams.get("offset")
  );
}

function makePage(offset: number, total: number): BranchListResponse {
  return {
    items: Array.from(
      { length: Math.min(100, Math.max(0, total - offset)) },
      (_, index) => makeBranchRow(`branch-${offset + index}`)
    ),
    total,
    viewerScope: BranchViewerScope.Organization,
    hasMore: offset + 100 < total,
  };
}

function serverQuery() {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 40,
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
  };
}

function serverPage(): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    ...makePage(40, 47),
    items: Array.from({ length: 7 }, (_, index) =>
      makeBranchRow(`branch-${40 + index}`)
    ),
    hasMore: false,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 40,
      requestedOffset: 40,
      now: "2026-08-18T18:00:00.000Z",
    },
    facets: {
      names: emptyFacet,
      owners: emptyFacet,
      collaborators: emptyFacet,
      statuses: emptyFacet,
      pullRequests: emptyFacet,
      lastActiveRanges: emptyFacet,
      repositories: emptyFacet,
      tags: emptyFacet,
    },
  };
}
