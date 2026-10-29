/**
 * ISS-10472: the route picks the right derivation and hands it the right
 * arguments.
 *
 * This is production-wiring coverage, not unit coverage. Each service method is
 * mocked, so what is under test is only the dispatch: which one the route calls
 * for a given query, and what it passes. Deleting the grouped branch, or
 * passing a row offset where a page index belongs, has to fail here — nothing
 * else in this app's suites exercises the paged dispatch at all.
 */

import { ArtifactGroupByMode } from "@repo/api/src/types/artifact-group-by-mode";
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
const RESOLVED_ORDERING = "root_first";

/** The route context shape Next passes; this route reads no path params. */
function context() {
  return { params: Promise.resolve({}) };
}

function request(query: string) {
  return new NextRequest(
    `http://localhost/artifacts/assigned-tree?${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}&${query}`
  );
}

describe("GET /artifacts/assigned-tree paged dispatch (ISS-10472)", () => {
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

  it("serves the UNPAGED tree when no limit is sent", async () => {
    const response = await GET(request("status=TODO"), context());

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledTimes(1);
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
    expect(mocks.getAssignedArtifactTreeSectionPage).not.toHaveBeenCalled();
  });

  it("row-pages an UNGROUPED read, passing the row offset", async () => {
    await GET(request("limit=25&offset=50"), context());

    expect(mocks.getAssignedArtifactTreePage).toHaveBeenCalledTimes(1);
    expect(mocks.getAssignedArtifactTreePage.mock.calls[0][3]).toEqual({
      limit: 25,
      offset: 50,
    });
    expect(mocks.getAssignedArtifactTreePage.mock.calls[0]).toHaveLength(5);
    expect(mocks.getAssignedArtifactTreeSectionPage).not.toHaveBeenCalled();
    // No grouping means no flag round trip to spend.
    expect(mocks.resolveOrdering).not.toHaveBeenCalled();
  });

  it("passes manual child ordering to the row-paged service only when enabled", async () => {
    mocks.manualOrderingEnabled = true;

    await GET(request("limit=25&offset=50"), context());

    expect(
      mocks.getManuallyOrderedAssignedArtifactTreePage
    ).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      mocks.user.id,
      { limit: 25, offset: 50 },
      expect.any(Object)
    );
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("section-pages a GROUPED read, passing the page index and resolved ordering", async () => {
    await GET(
      request(`limit=25&pageIndex=3&groupBy=${ArtifactGroupByMode.Status}`),
      context()
    );

    expect(mocks.getAssignedArtifactTreeSectionPage).toHaveBeenCalledTimes(1);
    expect(mocks.getAssignedArtifactTreeSectionPage.mock.calls[0][3]).toEqual({
      groupBy: ArtifactGroupByMode.Status,
      ordering: RESOLVED_ORDERING,
      pageIndex: 3,
      pageSize: 25,
    });
    expect(mocks.getAssignedArtifactTreeSectionPage.mock.calls[0]).toHaveLength(
      5
    );
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("passes manual child ordering to the section-paged service only when enabled", async () => {
    mocks.manualOrderingEnabled = true;

    await GET(
      request(`limit=25&pageIndex=3&groupBy=${ArtifactGroupByMode.Status}`),
      context()
    );

    expect(
      mocks.getManuallyOrderedAssignedArtifactTreeSectionPage
    ).toHaveBeenCalledWith(
      ASSIGNEE_ID,
      mocks.user.organizationId,
      mocks.user.id,
      {
        groupBy: ArtifactGroupByMode.Status,
        ordering: RESOLVED_ORDERING,
        pageIndex: 3,
        pageSize: 25,
      },
      expect.any(Object)
    );
    expect(mocks.getAssignedArtifactTreeSectionPage).not.toHaveBeenCalled();
  });

  it("resolves the ordering against the CLERK id, not only the internal one", async () => {
    // The browser identifies PostHog with the Clerk id alone, so a percentage
    // rollout buckets on it. Dropping it here resolves a different ordering
    // than the client's own flags.
    await GET(
      request(`limit=10&groupBy=${ArtifactGroupByMode.Priority}`),
      context()
    );

    expect(mocks.resolveOrdering).toHaveBeenCalledWith({
      clerkUserId: mocks.user.clerkId,
      userId: mocks.user.id,
    });
  });

  it("treats groupBy=none as ungrouped and row-pages it", async () => {
    await GET(
      request(`limit=25&offset=25&groupBy=${ArtifactGroupByMode.None}`),
      context()
    );

    expect(mocks.getAssignedArtifactTreePage).toHaveBeenCalledTimes(1);
    expect(mocks.getAssignedArtifactTreeSectionPage).not.toHaveBeenCalled();
  });

  it("rejects a row offset on a grouped read rather than reinterpreting it", async () => {
    const response = await GET(
      request(`limit=25&offset=50&groupBy=${ArtifactGroupByMode.Status}`),
      context()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTreeSectionPage).not.toHaveBeenCalled();
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("rejects a page index on an ungrouped read", async () => {
    const response = await GET(request("limit=25&pageIndex=2"), context());

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTreePage).not.toHaveBeenCalled();
  });

  it("rejects a grouping with NO limit rather than serving the whole tree", async () => {
    // The shape that parsed and lost both parameters: a caller that asked for
    // page 3 of a grouped board got every root and no error (marisolashgrove, PR
    // #9026).
    const response = await GET(
      request(`pageIndex=3&groupBy=${ArtifactGroupByMode.Status}`),
      context()
    );

    expect(response.status).toBe(400);
    expect(mocks.getAssignedArtifactTree).not.toHaveBeenCalled();
    expect(mocks.getAssignedArtifactTreeSectionPage).not.toHaveBeenCalled();
  });

  it("still serves the unpaged tree for groupBy=none with no limit", async () => {
    // `none` asks for nothing paged, so it is not the shape above and must not
    // start 400ing a request that worked before this parameter existed.
    const response = await GET(
      request(`groupBy=${ArtifactGroupByMode.None}`),
      context()
    );

    expect(response.status).toBe(200);
    expect(mocks.getAssignedArtifactTree).toHaveBeenCalledTimes(1);
  });

  it("defaults a grouped read with no page index to the first page", async () => {
    await GET(
      request(`limit=25&groupBy=${ArtifactGroupByMode.Assignee}`),
      context()
    );

    expect(
      mocks.getAssignedArtifactTreeSectionPage.mock.calls[0][3].pageIndex
    ).toBe(0);
  });
});
