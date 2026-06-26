import type * as GitHubModule from "@repo/github";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  return { withDb: mockWithDb };
});

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    compareBranchFileChangesWithProviderResult: vi.fn(),
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

import {
  BranchFileCacheStatus,
  BranchSyncStatus,
} from "@repo/api/src/types/artifact";
import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncErrorCode,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import { withDb } from "@repo/database";
import {
  compareBranchFileChangesWithProviderResult,
  GitHubProviderResultStatus,
} from "@repo/github";
import { refreshBranchFileChangeCache } from "./file-cache-service";

const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockCompareBranchFileChanges =
  compareBranchFileChangesWithProviderResult as unknown as Mock;

let mockDb: any;
let mockTx: any;

function providerSuccess<T>(value: T) {
  return { status: GitHubProviderResultStatus.Success, value };
}

function providerUnavailable() {
  return { status: GitHubProviderResultStatus.ProviderUnavailable };
}

function providerRateLimit(retryAfterSeconds: number | null = null) {
  return {
    status: GitHubProviderResultStatus.ProviderRateLimit,
    retryAfterSeconds,
  };
}

describe("refreshBranchFileChangeCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue({
          artifactId: "branch-artifact-1",
          baseBranch: "main",
          headSha: "sha-2",
          fileCacheHeadSha: null,
          lastSyncStartedAt: null,
          repository: {
            owner: "closedloop-ai",
            name: "symphony-alpha",
            installation: { installationId: "123456" },
          },
          syncStatus: BranchSyncStatus.Fresh,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockTx = {
      branchFileChange: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      branchDetail: {
        updateMany: vi.fn(),
      },
    };
    mockWithDb.mockImplementation((callback: any) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback: any) => callback(mockTx));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transactionally replaces rows only after GitHub compare succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    mockCompareBranchFileChanges.mockResolvedValue(
      providerSuccess([
        {
          filename: "apps/api/app/branches/service.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: "@@ patch",
        },
      ])
    );

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({
      ok: true,
      value: { throttled: false, fileCount: 1, patchBytes: 8 },
    });
    expect(mockDb.branchDetail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: "branch-artifact-1",
          artifact: { organizationId: "org-1" },
        },
      })
    );
    expect(mockCompareBranchFileChanges).toHaveBeenCalledWith(
      "123456",
      "closedloop-ai",
      "symphony-alpha",
      "main",
      "sha-2"
    );
    expect(mockTx.branchFileChange.deleteMany).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        branch: { artifact: { organizationId: "org-1" } },
      },
    });
    expect(mockTx.branchFileChange.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          branchArtifactId: "branch-artifact-1",
          headSha: "sha-2",
          path: "apps/api/app/branches/service.ts",
          isBinary: false,
          patch: "@@ patch",
          patchBytes: 8,
          patchOmittedReason: null,
        }),
      ],
    });
    expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
      },
      data: expect.objectContaining({
        fileCacheStatus: "fresh",
        fileCacheHeadSha: "sha-2",
        fileCacheFileCount: 1,
        fileCachePatchBytes: 8,
      }),
    });
    expect(mockTx.branchDetail.updateMany.mock.calls[0][0].data).not.toEqual(
      expect.objectContaining({
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
      })
    );
    expect(mockDb.branchDetail.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
      },
      data: {
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncCompletedAt: new Date("2026-06-01T12:00:00.000Z"),
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
      },
    });
  });

  it("treats zero-row self-acquired compare success settlement as a no-op", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    mockDb.branchDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockCompareBranchFileChanges.mockResolvedValue(
      providerSuccess([
        {
          filename: "apps/api/app/branches/service.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: "@@ patch",
        },
      ])
    );

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({
      ok: true,
      value: { throttled: false, fileCount: 1, patchBytes: 8 },
    });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledTimes(2);
    expect(mockDb.branchDetail.updateMany).toHaveBeenLastCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
      },
      data: expect.objectContaining({
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
      }),
    });
  });

  it("does not settle branch-wide sync success when the caller already acquired it", async () => {
    mockCompareBranchFileChanges.mockResolvedValue(
      providerSuccess([
        {
          filename: "apps/api/app/branches/service.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: "@@ patch",
        },
      ])
    );

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
      syncAlreadyStarted: true,
    });

    expect(result).toEqual({
      ok: true,
      value: { throttled: false, fileCount: 1, patchBytes: 8 },
    });
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
      },
      data: expect.objectContaining({
        fileCacheStatus: "fresh",
        fileCacheHeadSha: "sha-2",
        fileCacheFileCount: 1,
        fileCachePatchBytes: 8,
      }),
    });
    expect(mockTx.branchDetail.updateMany.mock.calls[0][0].data).not.toEqual(
      expect.objectContaining({
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
      })
    );
  });

  it("records coherent start and completion timestamps when compare refs are missing", async () => {
    mockDb.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      baseBranch: null,
      headSha: "sha-2",
      repository: {
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "123456" },
      },
    });

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({ ok: false, error: 400 });
    expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
    const failureData = mockDb.branchDetail.updateMany.mock.calls[0][0].data;
    expect(failureData).toMatchObject({
      fileCacheStatus: "failed",
      syncStatus: "failed",
      lastSyncErrorCode: "missing_compare_refs",
    });
    expect(failureData.lastSyncStartedAt).toBeInstanceOf(Date);
    expect(failureData.lastSyncCompletedAt).toBe(failureData.lastSyncStartedAt);
  });

  it("does not clobber the caller's branch-sync token when compare refs are missing", async () => {
    mockDb.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      baseBranch: null,
      headSha: "sha-2",
      repository: {
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "123456" },
      },
    });

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
      syncAlreadyStarted: true,
    });

    expect(result).toEqual({ ok: false, error: 400 });
    expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
      },
      data: {
        fileCacheStatus: BranchFileCacheStatus.Failed,
      },
    });
  });

  it("preserves existing rows and settles self-acquired compare failure by attempt token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    mockCompareBranchFileChanges.mockResolvedValue(providerUnavailable());

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({ ok: false, error: 500 });
    expect(mockTx.branchFileChange.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.branchFileChange.createMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          syncStatus: BranchSyncStatus.Syncing,
          lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
        },
      })
    );
    expect(mockDb.branchDetail.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
      },
      data: {
        fileCacheStatus: BranchFileCacheStatus.Failed,
      },
    });
    expect(mockDb.branchDetail.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
      },
      data: {
        syncStatus: BranchSyncStatus.Failed,
        lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
        lastSyncCompletedAt: new Date("2026-06-01T12:00:00.000Z"),
        lastSyncErrorCode: BranchViewFileCacheSyncErrorCode.CompareFailed,
        lastSyncErrorMessage:
          "GitHub compare failed while refreshing branch file cache.",
      },
    });
  });

  it("treats zero-row self-acquired compare failure settlement as a no-op", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    mockDb.branchDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockCompareBranchFileChanges.mockResolvedValue(providerUnavailable());

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({ ok: false, error: 500 });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledTimes(3);
    expect(mockDb.branchDetail.updateMany).toHaveBeenLastCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
      },
      data: expect.objectContaining({
        syncStatus: BranchSyncStatus.Failed,
        lastSyncErrorCode: BranchViewFileCacheSyncErrorCode.CompareFailed,
      }),
    });
  });

  it("throttles refreshes for the same cached head when the prior sync is recent", async () => {
    const recentStart = new Date();
    mockDb.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      baseBranch: "main",
      headSha: "sha-2",
      fileCacheHeadSha: "sha-2",
      lastSyncStartedAt: recentStart,
      repository: {
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "123456" },
      },
    });

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.throttled).toBe(true);
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
  });

  it("does not throttle a new branch head against a stale file cache head", async () => {
    mockDb.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      baseBranch: "main",
      headSha: "sha-2",
      fileCacheHeadSha: "sha-1",
      lastSyncStartedAt: new Date(),
      repository: {
        owner: "closedloop-ai",
        name: "symphony-alpha",
        installation: { installationId: "123456" },
      },
    });
    mockCompareBranchFileChanges.mockResolvedValue(providerUnavailable());

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({ ok: false, error: 500 });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactId: "branch-artifact-1",
          artifact: { organizationId: "org-1" },
          OR: expect.arrayContaining([
            expect.objectContaining({
              AND: expect.arrayContaining([
                {
                  OR: expect.arrayContaining([
                    { fileCacheHeadSha: null },
                    { fileCacheHeadSha: { not: "sha-2" } },
                  ]),
                },
              ]),
            }),
          ]),
        }),
      })
    );
    expect(mockCompareBranchFileChanges).toHaveBeenCalledWith(
      "123456",
      "closedloop-ai",
      "symphony-alpha",
      "main",
      "sha-2"
    );
  });

  it("recomputes retryAfter from the current row when sync-start loses a race", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T12:00:00.000Z"));
    mockDb.branchDetail.findFirst
      .mockResolvedValueOnce({
        artifactId: "branch-artifact-1",
        baseBranch: "main",
        headSha: "sha-2",
        fileCacheHeadSha: "sha-1",
        lastSyncStartedAt: new Date("2026-05-18T11:00:00.000Z"),
        repository: {
          owner: "closedloop-ai",
          name: "symphony-alpha",
          installation: { installationId: "123456" },
        },
      })
      .mockResolvedValueOnce({
        lastSyncStartedAt: new Date("2026-05-18T11:59:30.000Z"),
        syncStatus: BranchSyncStatus.Syncing,
      });
    mockDb.branchDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        throttled: true,
        retryAfterSeconds: 30,
        throttleReason: BranchViewSyncThrottleReason.InFlight,
      },
    });
    expect(mockCompareBranchFileChanges).not.toHaveBeenCalled();
  });

  it("settles a locally acquired sync attempt when compare is provider-throttled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    mockCompareBranchFileChanges.mockResolvedValue(providerRateLimit(23));

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        throttled: true,
        retryAfterSeconds: 23,
        throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
      },
    });
    expect(mockDb.branchDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          syncStatus: BranchSyncStatus.Syncing,
          lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
        },
      })
    );
    expect(mockDb.branchDetail.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: new Date("2026-06-01T12:00:00.000Z"),
      },
      data: expect.objectContaining({
        syncStatus: BranchSyncStatus.Failed,
        lastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
        lastSyncErrorMessage: "GitHub rate limited Branch View refresh",
      }),
    });
    expect(mockTx.branchFileChange.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves provider-throttle settlement to the caller when sync was already acquired", async () => {
    mockCompareBranchFileChanges.mockResolvedValue(providerRateLimit(null));

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
      syncAlreadyStarted: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        throttled: true,
        retryAfterSeconds: 60,
        throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
      },
    });
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockTx.branchFileChange.deleteMany).not.toHaveBeenCalled();
  });

  it("does not settle branch-wide failure fields when the caller already acquired sync", async () => {
    mockCompareBranchFileChanges.mockResolvedValue(providerUnavailable());

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
      syncAlreadyStarted: true,
    });

    expect(result).toEqual({ ok: false, error: 500 });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
      },
      data: {
        fileCacheStatus: BranchFileCacheStatus.Failed,
      },
    });
    expect(mockTx.branchFileChange.deleteMany).not.toHaveBeenCalled();
  });

  it("omits oversized patch bodies before persistence", async () => {
    mockCompareBranchFileChanges.mockResolvedValue(
      providerSuccess([
        {
          filename: "big.diff",
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: "x".repeat(64 * 1024 + 1),
        },
      ])
    );

    await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(mockTx.branchFileChange.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          path: "big.diff",
          patch: null,
          patchBytes: 0,
          patchOmittedReason: "patch_too_large",
        }),
      ],
    });
  });

  it("keeps unavailable patches distinct from binary-file detection", async () => {
    mockCompareBranchFileChanges.mockResolvedValue(
      providerSuccess([
        {
          filename: "src/no-patch.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: undefined,
        },
      ])
    );

    await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(mockTx.branchFileChange.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          path: "src/no-patch.ts",
          patch: null,
          patchBytes: 0,
          patchOmittedReason: "patch_unavailable",
          isBinary: false,
        }),
      ],
    });
  });

  it("persists changed files 101 through 500 from the compare helper result", async () => {
    mockCompareBranchFileChanges.mockResolvedValue(
      providerSuccess(
        Array.from({ length: 501 }, (_, index) => ({
          filename: `src/file-${index + 1}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: undefined,
        }))
      )
    );

    const result = await refreshBranchFileChangeCache("branch-artifact-1", {
      organizationId: "org-1",
    });

    expect(result).toEqual({
      ok: true,
      value: { throttled: false, fileCount: 500, patchBytes: 0 },
    });
    expect(mockTx.branchFileChange.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ path: "src/file-101.ts" }),
        expect.objectContaining({ path: "src/file-500.ts" }),
      ]),
    });
    const persistedRows =
      mockTx.branchFileChange.createMany.mock.calls[0][0].data;
    expect(persistedRows).toHaveLength(500);
    expect(
      persistedRows.some(
        (row: { path: string }) => row.path === "src/file-501.ts"
      )
    ).toBe(false);
  });
});
