import {
  BranchCommentsState,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { ReadSource } from "@repo/api/src/types/read-source";
import { describe, expect, it, vi } from "vitest";
import { createHttpBranchesDataSource } from "../branches-data-source";

describe("createHttpBranchesDataSource", () => {
  it("loads every paginated branch list page when no explicit pagination is requested", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) =>
      makeBranchRow(`branch-${index}`)
    );
    const secondPageItems = [makeBranchRow("branch-101")];
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          items: firstPageItems,
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          items: secondPageItems,
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: false,
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({ owner: "alice" })).resolves.toMatchObject({
      items: [...firstPageItems, ...secondPageItems],
      total: 101,
      viewerScope: BranchViewerScope.Organization,
      hasMore: false,
    });
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches?owner=alice&limit=100&offset=0"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches?owner=alice&limit=100&offset=100"
    );
  });

  it("loads every paginated trace page before returning the array-shaped port contract", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
      type: "sessionstart" as const,
      sessionId: `session-artifact-${index}`,
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    }));
    const secondPageItems = [
      {
        type: "sessionstart" as const,
        sessionId: "session-artifact-2",
        t: "2026-07-03T05:01:00.000Z",
        actor: { name: "Codex", harness: "codex" },
      },
    ];
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: firstPageItems,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: secondPageItems,
          hasMore: false,
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.trace("branch-1")).resolves.toEqual([
      ...firstPageItems,
      ...secondPageItems,
    ]);
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches/branch-1/trace?limit=100&offset=0"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches/branch-1/trace?limit=100&offset=100"
    );
  });

  it("degrades a failed trace fetch to the items collected so far instead of rejecting", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
      type: "sessionstart" as const,
      sessionId: `session-artifact-${index}`,
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    }));
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: firstPageItems,
          hasMore: true,
        })
        .mockRejectedValueOnce(new Error("trace fetch failed")),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.trace("branch-1")).resolves.toEqual(firstPageItems);
  });

  it("degrades to an empty timeline when the first trace page fails", async () => {
    const api = {
      get: vi.fn().mockRejectedValue(new Error("trace fetch failed")),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.trace("branch-1")).resolves.toEqual([]);
  });

  it("serializes canonical shared filters into repeated REST query params", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await dataSource.list({
      limit: 25,
      offset: 50,
      owner: "alice",
      repo: "closedloop-ai/symphony-alpha",
      search: "branches",
      startDate: "2026-07-01T00:00:00.000Z",
      status: "open",
    });

    expect(api.get).toHaveBeenCalledWith(
      "/branches?limit=25&offset=50&owner=alice&repo=closedloop-ai%2Fsymphony-alpha&search=branches&startDate=2026-07-01T00%3A00%3A00.000Z&status=open"
    );
  });

  it("loads branch comments from the Branches-owned comments route", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        state: BranchCommentsState.UnsyncedUnknown,
        comments: [],
        budget: {
          maxComments: 100,
          pageSize: 50,
          maxBodyBytes: 16_384,
          maxResponseBytes: 524_288,
          providerTruncated: false,
          responseTruncated: false,
          omittedComments: 0,
          bodyTruncatedCount: 0,
        },
        providerProofedAt: null,
        stale: false,
        mixedProjection: false,
        prNumber: null,
        prUrl: null,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.comments("branch-1")).resolves.toMatchObject({
      branchId: "branch-1",
      state: BranchCommentsState.UnsyncedUnknown,
    });
    expect(api.get).toHaveBeenCalledWith("/branches/branch-1/comments");
  });

  // FEA-3120: the HTTP source always reads synced cloud state, so it stamps
  // `cloud` at the read boundary — on both the single-page and aggregated paths.
  it("stamps readSource=cloud on an explicitly paginated list", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(
      dataSource.list({ limit: 25, offset: 0 })
    ).resolves.toMatchObject({ readSource: ReadSource.Cloud });
  });

  it("stamps readSource=cloud on the aggregated multi-page list", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({})).resolves.toMatchObject({
      readSource: ReadSource.Cloud,
    });
  });

  it("preserves an explicit server-provided readSource across the aggregated list", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
        readSource: ReadSource.Fallback,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({})).resolves.toMatchObject({
      readSource: ReadSource.Fallback,
    });
  });
});

function makeBranchRow(id: string): BranchRow {
  return {
    additions: null,
    ahead: null,
    baseBranch: "main",
    behind: null,
    branchName: id,
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: null,
    estimatedCostUsd: null,
    filesChanged: null,
    id,
    lastActivityAt: "2026-07-03T05:00:00.000Z",
    multiPrWarning: false,
    owner: "alice",
    prNumber: null,
    prState: null,
    prTitle: null,
    prUrl: null,
    repoFullName: "closedloop-ai/symphony-alpha",
    reviewDecision: null,
    sessionIds: [],
    status: BranchStatus.Open,
  };
}
