import { BranchSyncStatus } from "@repo/api/src/types/artifact";
import {
  BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS,
  BranchViewSyncErrorCode,
  BranchViewSyncThrottleReason,
} from "@repo/api/src/types/branch-view";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  markBranchSyncCompleted,
  markBranchSyncFailed,
  markBranchSyncProviderRateLimited,
  parseBranchSyncStatus,
  startBranchSync,
} from "./branch-sync-status";

const mockWithDb = vi.mocked(withDb);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseBranchSyncStatus", () => {
  it("accepts known persisted branch-sync statuses", () => {
    expect(parseBranchSyncStatus(BranchSyncStatus.Syncing)).toBe(
      BranchSyncStatus.Syncing
    );
  });

  it("treats unknown persisted branch-sync status strings as absent", () => {
    expect(parseBranchSyncStatus("future_sync_status")).toBeNull();
    expect(parseBranchSyncStatus(null)).toBeNull();
  });
});

function providerThrottleElapsedPredicate(providerThrottleCutoff: Date) {
  return {
    OR: [
      { lastSyncErrorCode: null },
      { lastSyncErrorCode: { not: BranchViewSyncErrorCode.SyncThrottled } },
      { lastSyncCompletedAt: { lt: providerThrottleCutoff } },
      {
        AND: [
          { lastSyncCompletedAt: null },
          { lastSyncStartedAt: { lt: providerThrottleCutoff } },
        ],
      },
    ],
  };
}

describe("startBranchSync", () => {
  it("throttles recent branch sync attempts even when the file-cache head is stale", async () => {
    const startedAt = new Date("2026-05-24T18:00:30Z");

    const result = await startBranchSync({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      headSha: "new-head-sha",
      currentFileCacheHeadSha: "old-head-sha",
      currentLastSyncStartedAt: new Date("2026-05-24T18:00:00Z"),
      currentSyncStatus: BranchSyncStatus.Syncing,
      startedAt,
    });

    expect(result).toEqual({
      throttled: true,
      retryAfterSeconds: 30,
      throttleReason: BranchViewSyncThrottleReason.InFlight,
    });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("throttles settled duplicate attempts inside the local dedupe window", async () => {
    const result = await startBranchSync({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      headSha: "head-sha",
      currentFileCacheHeadSha: "head-sha",
      currentLastSyncStartedAt: new Date("2026-05-24T18:00:00Z"),
      currentSyncStatus: BranchSyncStatus.Fresh,
      startedAt: new Date("2026-05-24T18:00:02Z"),
    });

    expect(result).toEqual({
      throttled: true,
      retryAfterSeconds: 3,
      throttleReason: BranchViewSyncThrottleReason.LocalDedupe,
    });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("preserves the provider retry window after a settled provider throttle", async () => {
    const result = await startBranchSync({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      headSha: "head-sha",
      currentFileCacheHeadSha: "head-sha",
      currentLastSyncStartedAt: new Date("2026-05-24T18:00:00Z"),
      currentLastSyncCompletedAt: new Date("2026-05-24T18:00:10Z"),
      currentLastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
      currentSyncStatus: BranchSyncStatus.Failed,
      startedAt: new Date("2026-05-24T18:00:30Z"),
    });

    expect(result).toEqual({
      throttled: true,
      retryAfterSeconds: 40,
      throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
    });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("does not bypass a settled provider throttle for stale cache-head refreshes", async () => {
    const result = await startBranchSync({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      headSha: "new-head-sha",
      currentFileCacheHeadSha: "old-head-sha",
      currentLastSyncStartedAt: new Date("2026-05-24T18:00:00Z"),
      currentLastSyncCompletedAt: new Date("2026-05-24T18:00:10Z"),
      currentLastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
      currentSyncStatus: BranchSyncStatus.Failed,
      startedAt: new Date("2026-05-24T18:00:30Z"),
      allowStaleCacheHeadBypass: true,
    });

    expect(result).toEqual({
      throttled: true,
      retryAfterSeconds: 40,
      throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
    });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("starts a sync when the previous branch sync is outside the throttle window", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );
    const startedAt = new Date("2026-05-24T18:02:00Z");
    const providerThrottleCutoff = new Date(
      startedAt.getTime() - BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS * 1000
    );

    const result = await startBranchSync({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      headSha: "new-head-sha",
      currentFileCacheHeadSha: "old-head-sha",
      currentLastSyncStartedAt: new Date("2026-05-24T18:00:00Z"),
      currentSyncStatus: BranchSyncStatus.Fresh,
      startedAt,
    });

    expect(result).toEqual({ throttled: false, fileCount: 0, patchBytes: 0 });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        OR: [
          { lastSyncStartedAt: null },
          {
            AND: [
              { syncStatus: BranchSyncStatus.Syncing },
              { lastSyncStartedAt: { lt: new Date("2026-05-24T18:01:00Z") } },
            ],
          },
          {
            AND: [
              { syncStatus: { not: BranchSyncStatus.Syncing } },
              { lastSyncStartedAt: { lt: new Date("2026-05-24T18:01:55Z") } },
              providerThrottleElapsedPredicate(providerThrottleCutoff),
            ],
          },
        ],
      },
      data: {
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: startedAt,
      },
    });
  });

  it("lets background file-cache refreshes bypass the throttle for a newly pushed head", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );
    const startedAt = new Date("2026-05-24T18:00:30Z");
    const providerThrottleCutoff = new Date(
      startedAt.getTime() - BRANCH_VIEW_PROVIDER_RETRY_FALLBACK_SECONDS * 1000
    );

    const result = await startBranchSync({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      headSha: "new-head-sha",
      currentFileCacheHeadSha: "old-head-sha",
      currentLastSyncStartedAt: new Date("2026-05-24T18:00:00Z"),
      currentSyncStatus: BranchSyncStatus.Fresh,
      startedAt,
      allowStaleCacheHeadBypass: true,
    });

    expect(result).toEqual({ throttled: false, fileCount: 0, patchBytes: 0 });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        OR: [
          { lastSyncStartedAt: null },
          {
            AND: [
              { syncStatus: BranchSyncStatus.Syncing },
              { lastSyncStartedAt: { lt: new Date("2026-05-24T17:59:30Z") } },
            ],
          },
          {
            AND: [
              { syncStatus: { not: BranchSyncStatus.Syncing } },
              { lastSyncStartedAt: { lt: new Date("2026-05-24T18:00:25Z") } },
              providerThrottleElapsedPredicate(providerThrottleCutoff),
            ],
          },
          {
            AND: [
              { syncStatus: { not: BranchSyncStatus.Syncing } },
              providerThrottleElapsedPredicate(providerThrottleCutoff),
              {
                OR: [
                  { fileCacheHeadSha: null },
                  { fileCacheHeadSha: { not: "new-head-sha" } },
                ],
              },
            ],
          },
        ],
      },
      data: {
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: startedAt,
      },
    });
  });

  it("returns the provider retry window when acquisition loses to a persisted provider throttle", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({
          lastSyncCompletedAt: new Date("2026-05-24T18:00:20Z"),
          lastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
          lastSyncStartedAt: new Date("2026-05-24T18:00:00Z"),
          syncStatus: BranchSyncStatus.Failed,
        }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );

    const result = await startBranchSync({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      headSha: "head-sha",
      currentFileCacheHeadSha: "head-sha",
      currentLastSyncStartedAt: new Date("2026-05-24T17:58:00Z"),
      currentSyncStatus: BranchSyncStatus.Fresh,
      startedAt: new Date("2026-05-24T18:00:45Z"),
    });

    expect(result).toEqual({
      throttled: true,
      retryAfterSeconds: 35,
      throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
    });
    expect(mockDb.branchDetail.findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
      },
      select: {
        lastSyncCompletedAt: true,
        lastSyncErrorCode: true,
        lastSyncStartedAt: true,
        syncStatus: true,
      },
    });
  });
});

describe("markBranchSyncFailed", () => {
  it("settles only the acquired syncing attempt when startedAt is supplied", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );
    const completedAt = new Date("2026-05-24T18:03:00Z");
    const startedAt = new Date("2026-05-24T18:02:00Z");

    const result = await markBranchSyncFailed({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      message: "Failed to refresh pull request lifecycle",
      completedAt,
      startedAt,
    });

    expect(result).toEqual({ updated: true });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: startedAt,
      },
      data: {
        syncStatus: BranchSyncStatus.Failed,
        lastSyncStartedAt: startedAt,
        lastSyncCompletedAt: completedAt,
        lastSyncErrorCode: BranchViewSyncErrorCode.PrLifecycleUnavailable,
        lastSyncErrorMessage: "Failed to refresh pull request lifecycle",
      },
    });
  });

  it("treats zero-row acquired-attempt failure settlement as a no-op", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );

    const result = await markBranchSyncFailed({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
      message: "Failed to refresh branch file cache",
      completedAt: new Date("2026-05-24T18:03:00Z"),
      startedAt: new Date("2026-05-24T18:02:00Z"),
    });

    expect(result).toEqual({ updated: false });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy failure marking broad when no attempt token is supplied", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );
    const completedAt = new Date("2026-05-24T18:03:00Z");

    const result = await markBranchSyncFailed({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      message: "Failed to refresh pull request lifecycle",
      completedAt,
    });

    expect(result).toEqual({ updated: true });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
      },
      data: {
        syncStatus: BranchSyncStatus.Failed,
        lastSyncCompletedAt: completedAt,
        lastSyncErrorCode: BranchViewSyncErrorCode.PrLifecycleUnavailable,
        lastSyncErrorMessage: "Failed to refresh pull request lifecycle",
      },
    });
  });
});

describe("markBranchSyncCompleted", () => {
  it("settles only the acquired syncing attempt as fresh", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );
    const completedAt = new Date("2026-05-24T18:03:00Z");
    const startedAt = new Date("2026-05-24T18:02:00Z");

    const result = await markBranchSyncCompleted({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      completedAt,
      startedAt,
    });

    expect(result).toEqual({ updated: true });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: startedAt,
      },
      data: {
        syncStatus: BranchSyncStatus.Fresh,
        lastSyncCompletedAt: completedAt,
        lastSyncErrorCode: null,
        lastSyncErrorMessage: null,
      },
    });
  });
});

describe("markBranchSyncProviderRateLimited", () => {
  it("settles only the acquired syncing attempt with safe provider metadata", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );
    const completedAt = new Date("2026-05-24T18:03:00Z");
    const startedAt = new Date("2026-05-24T18:02:00Z");

    const result = await markBranchSyncProviderRateLimited({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      completedAt,
      startedAt,
    });

    expect(result).toEqual({ updated: true });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifactId: "branch-artifact-1",
        artifact: { organizationId: "org-1" },
        syncStatus: BranchSyncStatus.Syncing,
        lastSyncStartedAt: startedAt,
      },
      data: {
        syncStatus: BranchSyncStatus.Failed,
        lastSyncCompletedAt: completedAt,
        lastSyncErrorCode: BranchViewSyncErrorCode.SyncThrottled,
        lastSyncErrorMessage: "GitHub rate limited Branch View refresh",
      },
    });
  });

  it("treats zero-row attempt settlement as a non-overwrite no-op", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mockWithDb.mockImplementation(async (callback) =>
      callback(mockDb as never)
    );

    const result = await markBranchSyncProviderRateLimited({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      completedAt: new Date("2026-05-24T18:03:00Z"),
      startedAt: new Date("2026-05-24T18:02:00Z"),
    });

    expect(result).toEqual({ updated: false });
    expect(mockDb.branchDetail.updateMany).toHaveBeenCalledTimes(1);
  });
});
