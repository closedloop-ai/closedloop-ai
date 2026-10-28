/**
 * ISS-12636: the route accepts the sort it can honor, refuses the rest, and
 * hands the resolved pair to whichever derivation serves the request.
 *
 * Production-wiring coverage, not unit coverage: the services are mocked, so
 * what is under test is the query contract and the dispatch. The ordering's own
 * correctness is `assigned-tree-root-sort-parity`'s job.
 */

import {
  ArtifactGroupByMode,
  ArtifactSectionOrdering,
} from "@repo/api/src/types/artifact-group-by-mode";
import {
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
} from "@repo/api/src/types/assigned-tree-sort";
import { ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM } from "@repo/api/src/types/project-tree";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAssignedArtifactTree: vi.fn(),
  getAssignedArtifactTreePage: vi.fn(),
  getAssignedArtifactTreeSectionPage: vi.fn(),
  getManuallyOrderedAssignedArtifactTreePage: vi.fn(),
  getManuallyOrderedAssignedArtifactTreeSectionPage: vi.fn(),
  manualOrderingEnabled: false,
  resolveOrdering: vi.fn(),
  user: {
    clerkId: "user_clerk_abc",
    id: "22222222-2222-7222-8222-222222222222",
    organizationId: "11111111-1111-7111-8111-111111111111",
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, _context: unknown) =>
      handler({ user: mocks.user }, request),
}));

vi.mock("../assigned-artifact-tree-service", () => ({
  assignedArtifactTreeService: {
    getAssignedArtifactTree: mocks.getAssignedArtifactTree,
    getAssignedArtifactTreePage: mocks.getAssignedArtifactTreePage,
    getAssignedArtifactTreeSectionPage:
      mocks.getAssignedArtifactTreeSectionPage,
    getManuallyOrderedAssignedArtifactTreePage:
      mocks.getManuallyOrderedAssignedArtifactTreePage,
    getManuallyOrderedAssignedArtifactTreeSectionPage:
      mocks.getManuallyOrderedAssignedArtifactTreeSectionPage,
  },
}));

vi.mock("../assigned-tree-section-ordering", () => ({
  resolveAssignedTreeSectionOrdering: mocks.resolveOrdering,
}));

vi.mock("@/lib/manual-artifact-ordering-feature", () => ({
  isManualArtifactOrderingEnabled: vi.fn(
    async () => mocks.manualOrderingEnabled
  ),
}));

import { GET } from "../assigned-tree/route";

const ASSIGNEE_ID = "33333333-3333-7333-8333-333333333333";
const EMPTY_TREE = { externalParents: [], nodes: [] };
const RESOLVED_ORDERING = ArtifactSectionOrdering.RootFirst;

function context() {
  return { params: Promise.resolve({}) };
}

function request(query: string) {
  return new NextRequest(
    `http://localhost/artifacts/assigned-tree?${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&${query}`
  );
}

describe("GET /artifacts/assigned-tree root sort (ISS-12636)", () => {
  beforeEach(() => {
    mocks.manualOrderingEnabled = false;
    mocks.getAssignedArtifactTree.mockResolvedValue(EMPTY_TREE);
    mocks.getAssignedArtifactTreePage.mockResolvedValue(EMPTY_TREE);
    mocks.getAssignedArtifactTreeSectionPage.mockResolvedValue(EMPTY_TREE);
    mocks.getManuallyOrderedAssignedArtifactTreePage.mockResolvedValue(
      EMPTY_TREE
    );
    mocks.getManuallyOrderedAssignedArtifactTreeSectionPage.mockResolvedValue(
      EMPTY_TREE
    );
    mocks.resolveOrdering.mockResolvedValue(RESOLVED_ORDERING);
  });

  it("passes the resolved pair to the row-paged read", async () => {
    await GET(
      request(
        `limit=25&offset=50&sortBy=${AssignedTreeSortKey.Title}&sortDir=${AssignedTreeSortDirection.Desc}`
      ),
      context()
    );

    expect(mocks.getAssignedArtifactTreePage.mock.calls[0][3]).toEqual({
      limit: 25,
      offset: 50,
      sort: {
        direction: AssignedTreeSortDirection.Desc,
        key: AssignedTreeSortKey.Title,
      },
    });
  });

  it("passes it to the section-paged read too, where it orders roots inside a section", async () => {
    await GET(
      request(
        `limit=25&pageIndex=1&groupBy=${ArtifactGroupByMode.Status}&sortBy=${AssignedTreeSortKey.Slug}`
      ),
      context()
    );

    expect(mocks.getAssignedArtifactTreeSectionPage.mock.calls[0][3]).toEqual({
      groupBy: ArtifactGroupByMode.Status,
      ordering: RESOLVED_ORDERING,
      pageIndex: 1,
      pageSize: 25,
      sort: {
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Slug,
      },
    });
  });

  it("passes it to the manually-ordered reads when that rollout is on", async () => {
    mocks.manualOrderingEnabled = true;

    await GET(
      request(`limit=10&sortBy=${AssignedTreeSortKey.Updated}`),
      context()
    );

    expect(
      mocks.getManuallyOrderedAssignedArtifactTreePage.mock.calls[0][3].sort
    ).toEqual({
      direction: AssignedTreeSortDirection.Asc,
      key: AssignedTreeSortKey.Updated,
    });
  });

  it("passes it to the manually-ordered SECTION read, the fourth dispatch arm", async () => {
    // The arm a PostHog rollout turns on. Without this case, deleting `sort`
    // from the manually-ordered grouped call leaves the whole suite green.
    mocks.manualOrderingEnabled = true;

    await GET(
      request(
        `limit=10&pageIndex=0&groupBy=${ArtifactGroupByMode.Status}&sortBy=${AssignedTreeSortKey.Title}`
      ),
      context()
    );

    expect(
      mocks.getManuallyOrderedAssignedArtifactTreeSectionPage.mock.calls[0][3]
    ).toEqual({
      groupBy: ArtifactGroupByMode.Status,
      ordering: RESOLVED_ORDERING,
      pageIndex: 0,
      pageSize: 10,
      sort: {
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Title,
      },
    });
  });

  it("defaults the direction to ascending", async () => {
    await GET(
      request(`limit=10&sortBy=${AssignedTreeSortKey.Assignee}`),
      context()
    );

    expect(
      mocks.getAssignedArtifactTreePage.mock.calls[0][3].sort.direction
    ).toBe(AssignedTreeSortDirection.Asc);
  });

  it("sends NO sort when the column was not requested, so the read stays stack-ranked", async () => {
    await GET(request("limit=10&offset=0"), context());

    expect(
      mocks.getAssignedArtifactTreePage.mock.calls[0][3].sort
    ).toBeUndefined();
  });

  it("rejects a column this read cannot order by", async () => {
    // `status` is a real client `SortKey` and is deliberately NOT in the
    // server's vocabulary: which of the three ISS-9437 orderings to reproduce
    // is unsettled. Accepted, it would serve stack-rank order under a
    // parameter the caller believes sorted — the failure `.strict()` exists to
    // refuse.
    const response = await GET(request("limit=10&sortBy=status"), context());

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("rejects an unknown column outright", async () => {
    const response = await GET(request("limit=10&sortBy=whenever"), context());

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("rejects an unknown direction rather than falling back to ascending", async () => {
    const response = await GET(
      request(`limit=10&sortBy=${AssignedTreeSortKey.Title}&sortDir=sideways`),
      context()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("rejects a direction with no column to apply it to", async () => {
    const response = await GET(
      request(`limit=10&sortDir=${AssignedTreeSortDirection.Desc}`),
      context()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("rejects a sort with NO limit rather than serving the whole tree unsorted", async () => {
    // The unpaged arm resolves roots in Node and orders them by stack rank; it
    // has no ORDER BY this column can reach. Accepted, `?sortBy=title` would
    // 200 with the tree in stack-rank order — a sort that reported success and
    // did nothing.
    const response = await GET(
      request(`sortBy=${AssignedTreeSortKey.Title}`),
      context()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
  });

  it("still serves the unpaged tree when no sort is asked for", async () => {
    // The parameter is additive: a caller from before it existed must not start
    // getting a 400.
    const response = await GET(request("status=TODO"), context());

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledTimes(1);
  });
});
