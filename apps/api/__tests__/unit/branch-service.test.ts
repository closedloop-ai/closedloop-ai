import {
  BranchBaseBranchSource,
  BranchFileCacheStatus,
  BranchHeadShaSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",

    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
  ChecksStatus: {
    UNKNOWN: "UNKNOWN",
    PENDING: "PENDING",
    PASSING: "PASSING",
    FAILING: "FAILING",
  },
}));

import { ArtifactSubtype, ArtifactType, ChecksStatus } from "@repo/database";
import {
  applyDeleteTransition,
  applyHeadTransition,
  branchService,
  decideBranchStatus,
  resolveBaseProvenance,
  scheduleFileChangeCacheRefresh,
  type UpsertBranchArtifactInput,
} from "@/app/branches/branch-service";

const ORG_ID = "org-1";
const PROJECT_ID = "project-1";
const REPO_ID = "repo-1";
const REPO_FULL_NAME = "closedloop-ai/symphony-alpha";
const ZERO_GIT_SHA = "0000000000000000000000000000000000000000";
const expectedBranchInclude = {
  branch: { include: { currentPullRequestDetail: true } },
  pullRequest: true,
};

function branchInput(
  overrides: Partial<UpsertBranchArtifactInput> = {}
): UpsertBranchArtifactInput {
  return {
    organizationId: ORG_ID,
    repositoryId: REPO_ID,
    repositoryFullName: REPO_FULL_NAME,
    branchName: "feature/branch-artifact",
    defaultBranch: "main",
    projectId: PROJECT_ID,
    baseBranch: "main",
    baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
    headSha: "sha-2",
    headShaSource: BranchHeadShaSource.PushWebhook,
    beforeSha: "sha-1",
    ...overrides,
  };
}

describe("branchService helpers", () => {
  it("rejects stale push observations without clobbering stored head state", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-3",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "unrelated",
      },
      {
        headSha: "sha-2",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: "sha-1",
      }
    );

    expect(result).toMatchObject({
      accepted: false,
      reason: "stale_push",
      headSha: "sha-2",
      lastPushBeforeSha: "sha-1",
    });
  });

  it("accepts force-push-back-to-earlier-SHA when stored head matches before", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-earlier",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "sha-current",
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: "sha-previous",
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "sequential_push",
      headSha: "sha-earlier",
      lastPushBeforeSha: "sha-current",
    });
  });

  it("accepts GitHub-created zero-before pushes as tombstoned branch recreates", () => {
    const observedAt = new Date("2026-05-15T04:00:00Z");
    const deletedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-recreated",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        observedAt,
        isCreate: true,
      },
      {
        headSha: "sha-before-delete",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T02:00:00Z"),
        lastPushBeforeSha: "sha-before-delete-parent",
        deletedAt,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "recreated_after_delete",
      headSha: "sha-recreated",
      headShaObservedAt: observedAt,
      lastPushBeforeSha: ZERO_GIT_SHA,
    });
  });

  it("accepts delete-first tombstone recreates even when no head is stored", () => {
    const observedAt = new Date("2026-05-15T04:00:00Z");
    const deletedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-recreated",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        observedAt,
        isCreate: true,
      },
      {
        headSha: null,
        headShaSource: null,
        headShaObservedAt: null,
        lastPushBeforeSha: null,
        deletedAt,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "recreated_after_delete",
      headSha: "sha-recreated",
      lastPushBeforeSha: ZERO_GIT_SHA,
    });
  });

  it("rejects original create redeliveries after delete as stale pushes", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-before-delete",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        observedAt: new Date("2026-05-15T01:00:00Z"),
        isCreate: true,
      },
      {
        headSha: "sha-before-delete",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T01:00:00Z"),
        lastPushBeforeSha: ZERO_GIT_SHA,
        deletedAt: new Date("2026-05-15T03:00:00Z"),
      }
    );

    expect(result).toMatchObject({
      accepted: false,
      reason: "stale_push",
      headSha: "sha-before-delete",
      lastPushBeforeSha: ZERO_GIT_SHA,
    });
  });

  it("does not treat zero-before create pushes as recreates for active branches", () => {
    const result = applyHeadTransition(
      {
        headSha: "sha-recreated",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: ZERO_GIT_SHA,
        isCreate: true,
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T02:00:00Z"),
        lastPushBeforeSha: "sha-parent",
      }
    );

    expect(result).toMatchObject({
      accepted: false,
      reason: "stale_push",
      headSha: "sha-current",
    });
  });

  it("treats duplicate harness head callbacks as idempotent replays", () => {
    const observedAt = new Date("2026-05-15T00:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.HarnessInput,
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: observedAt,
        lastPushBeforeSha: "sha-previous",
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "duplicate_harness_input",
      headSha: "sha-current",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: "sha-previous",
    });
  });

  it("accepts same-head push webhooks as remote confirmation for non-push branches", () => {
    const observedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "sha-previous",
        observedAt,
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: null,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "push_confirmed",
      headSha: "sha-current",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: "sha-previous",
    });
  });

  it("keeps same-head push confirmation observed time monotonic", () => {
    const existingObservedAt = new Date("2026-05-15T03:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.PushWebhook,
        beforeSha: "sha-previous",
        observedAt: new Date("2026-05-15T01:00:00Z"),
      },
      {
        headSha: "sha-current",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: existingObservedAt,
        lastPushBeforeSha: null,
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "push_confirmed",
      headShaObservedAt: existingObservedAt,
    });
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt: new Date("2026-05-15T02:00:00Z"),
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-current",
        currentHeadSha: result.headSha,
        currentHeadShaObservedAt: result.headShaObservedAt,
      })
    ).toBeNull();
  });

  it("accepts newer harness callbacks for an existing materialized branch", () => {
    const observedAt = new Date("2026-05-15T00:00:00Z");
    const result = applyHeadTransition(
      {
        headSha: "sha-from-new-callback",
        headShaSource: BranchHeadShaSource.HarnessInput,
      },
      {
        headSha: "sha-from-existing-branch",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: observedAt,
        lastPushBeforeSha: "sha-before-newer-head",
      }
    );

    expect(result).toMatchObject({
      accepted: true,
      reason: "authoritative_refresh",
      headSha: "sha-from-new-callback",
      headShaSource: BranchHeadShaSource.HarnessInput,
      headShaObservedAt: expect.any(Date),
      lastPushBeforeSha: null,
    });
  });

  it("keeps higher-priority PR base provenance over repository default", () => {
    const result = resolveBaseProvenance(
      {
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      },
      {
        baseBranch: "release",
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      }
    );

    expect(result).toEqual({
      baseBranch: "release",
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    });
  });

  it("does not schedule cache refresh for rejected head transitions", () => {
    const schedule = scheduleFileChangeCacheRefresh({
      isDelete: false,
      headTransition: {
        accepted: false,
        reason: "stale_push",
        headSha: "sha-2",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: null,
        lastPushBeforeSha: "sha-1",
      },
    });

    expect(schedule).toEqual({ shouldSchedule: false });
  });

  it("does not schedule cache refresh for duplicate harness callbacks", () => {
    const schedule = scheduleFileChangeCacheRefresh({
      isDelete: false,
      headTransition: {
        accepted: true,
        reason: "duplicate_harness_input",
        headSha: "sha-from-existing-branch",
        headShaSource: BranchHeadShaSource.HarnessInput,
        headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
        lastPushBeforeSha: "sha-before-newer-head",
      },
    });

    expect(schedule).toEqual({ shouldSchedule: false });
  });

  it("preserves current PR status when no PR or delete input is authoritative", () => {
    expect(decideBranchStatus({ currentStatus: GitHubPRState.Merged })).toBe(
      GitHubPRState.Merged
    );
    expect(decideBranchStatus({ currentStatus: GitHubPRState.Closed })).toBe(
      GitHubPRState.Closed
    );
  });

  it("uses PR state as the authoritative branch status when present", () => {
    expect(
      decideBranchStatus({
        currentStatus: GitHubPRState.Merged,
        pullRequestState: GitHubPRState.Open,
      })
    ).toBe(GitHubPRState.Open);
  });

  it("applies delete transitions while preserving merged terminal state", () => {
    const deletedAt = new Date("2026-05-15T03:00:00Z");

    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt,
        currentStatus: GitHubPRState.Merged,
      })
    ).toEqual({ deletedAt, status: GitHubPRState.Merged });
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt,
        currentStatus: GitHubPRState.Open,
      })
    ).toEqual({ deletedAt, status: GitHubPRState.Closed });
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt,
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-current",
        currentHeadSha: "sha-current",
        currentHeadShaObservedAt: new Date("2026-05-15T02:00:00Z"),
      })
    ).toEqual({ deletedAt, status: GitHubPRState.Closed });
    expect(applyDeleteTransition({ isDelete: false })).toBeNull();
  });

  it("rejects stale delete redeliveries after a newer head observation", () => {
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt: new Date("2026-05-15T03:00:00Z"),
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-recreated",
        currentHeadSha: "sha-recreated",
        currentHeadShaObservedAt: new Date("2026-05-15T04:00:00Z"),
      })
    ).toBeNull();
    expect(
      applyDeleteTransition({
        isDelete: true,
        deletedAt: new Date("2026-05-15T05:00:00Z"),
        currentStatus: GitHubPRState.Open,
        beforeSha: "sha-before-delete",
        currentHeadSha: "sha-recreated",
        currentHeadShaObservedAt: new Date("2026-05-15T04:00:00Z"),
      })
    ).toBeNull();
  });
});

describe("branchService.upsertBranchArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a null projectId — only SESSION artifacts may be projectless", async () => {
    const mockDb = {
      artifact: { create: vi.fn() },
      branchDetail: { findUnique: vi.fn() },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({ projectId: null })
    );

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mockDb.branchDetail.findUnique).not.toHaveBeenCalled();
    expect(mockDb.artifact.create).not.toHaveBeenCalled();
  });

  it("creates a BRANCH artifact for a branch-native materialization", async () => {
    const created = {
      id: "branch-artifact-1",
      branch: { artifactId: "branch-artifact-1" },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue(created),
        findUnique: vi.fn().mockResolvedValue(created),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
        upsert: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(branchInput());

    expect(result).toEqual({ ok: true, value: created });
    expect(mockDb.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: ArtifactType.BRANCH,
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        createdById: null,
        name: "feature/branch-artifact",
        externalUrl:
          "https://github.com/closedloop-ai/symphony-alpha/tree/feature%2Fbranch-artifact",
        branch: {
          create: expect.objectContaining({
            repositoryId: REPO_ID,
            branchName: "feature/branch-artifact",
            baseBranch: "main",
            baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
            headSha: "sha-2",
            headShaSource: BranchHeadShaSource.PushWebhook,
            lastPushBeforeSha: "sha-1",
            checksStatus: ChecksStatus.UNKNOWN,
          }),
        },
      }),
      include: expectedBranchInclude,
    });
  });

  it("persists deletedAt when the first materialization is a delete push", async () => {
    const deletedAt = new Date("2026-05-15T02:00:00Z");
    const created = {
      id: "branch-artifact-1",
      branch: { artifactId: "branch-artifact-1" },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue(created),
        findUnique: vi.fn().mockResolvedValue(created),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
        upsert: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        isDelete: true,
        deletedAt,
        headSha: null,
        beforeSha: "sha-1",
      })
    );

    expect(result).toEqual({ ok: true, value: created });
    expect(mockDb.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: GitHubPRState.Closed,
        branch: {
          create: expect.objectContaining({
            deletedAt,
            fileCacheStatus: BranchFileCacheStatus.Absent,
          }),
        },
      }),
      include: expectedBranchInclude,
    });
  });

  it("clears deletedAt when GitHub reports a deleted branch was recreated", async () => {
    const deletedAt = new Date("2026-05-15T02:00:00Z");
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: "sha-before-delete",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T01:00:00Z"),
      lastPushBeforeSha: "sha-before-delete-parent",
      deletedAt,
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Closed,
      },
    };
    const reread = {
      id: "branch-artifact-1",
      branch: {
        ...existingBranch,
        headSha: "sha-recreated",
        lastPushBeforeSha: ZERO_GIT_SHA,
        deletedAt: null,
        currentPullRequestDetail: null,
      },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(reread),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        headSha: "sha-recreated",
        beforeSha: ZERO_GIT_SHA,
        headShaObservedAt: new Date("2026-05-15T03:00:01Z"),
        isCreate: true,
      })
    );

    expect(result).toEqual({ ok: true, value: reread });
    expect(mockDb.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: expect.objectContaining({
        headSha: "sha-recreated",
        lastPushBeforeSha: ZERO_GIT_SHA,
        deletedAt: null,
      }),
    });
    expect(mockDb.artifact.update).toHaveBeenCalledWith({
      where: { id: "branch-artifact-1" },
      data: expect.objectContaining({
        status: GitHubPRState.Open,
      }),
    });
  });

  it("clears deletedAt when a delete-first branch is later recreated", async () => {
    const deletedAt = new Date("2026-05-15T02:00:00Z");
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: null,
      headShaSource: null,
      headShaObservedAt: null,
      lastPushBeforeSha: null,
      deletedAt,
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Closed,
      },
    };
    const reread = {
      id: "branch-artifact-1",
      branch: {
        ...existingBranch,
        headSha: "sha-recreated",
        headShaSource: BranchHeadShaSource.PushWebhook,
        headShaObservedAt: new Date("2026-05-15T03:00:00Z"),
        lastPushBeforeSha: ZERO_GIT_SHA,
        deletedAt: null,
        currentPullRequestDetail: null,
      },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(reread),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        headSha: "sha-recreated",
        beforeSha: ZERO_GIT_SHA,
        headShaObservedAt: new Date("2026-05-15T03:00:00Z"),
        isCreate: true,
      })
    );

    expect(result).toEqual({ ok: true, value: reread });
    expect(mockDb.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: expect.objectContaining({
        headSha: "sha-recreated",
        lastPushBeforeSha: ZERO_GIT_SHA,
        deletedAt: null,
      }),
    });
  });

  it("rejects redelivered delete pushes after the branch is recreated", async () => {
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: "sha-recreated",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T04:00:00Z"),
      lastPushBeforeSha: ZERO_GIT_SHA,
      deletedAt: null,
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Open,
      },
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        headSha: null,
        headShaSource: null,
        beforeSha: "sha-before-delete",
        isDelete: true,
        deletedAt: new Date("2026-05-15T03:00:00Z"),
      })
    );

    expect(result).toEqual({ ok: false, error: Status.Conflict });
    expect(mockDb.artifact.update).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.update).not.toHaveBeenCalled();
  });

  it("rejects redelivered original branch-create pushes after delete", async () => {
    const deletedAt = new Date("2026-05-15T03:00:00Z");
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: "sha-before-delete",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T01:00:00Z"),
      lastPushBeforeSha: ZERO_GIT_SHA,
      deletedAt,
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Closed,
      },
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        headSha: "sha-before-delete",
        beforeSha: ZERO_GIT_SHA,
        headShaObservedAt: new Date("2026-05-15T01:00:00Z"),
        isCreate: true,
      })
    );

    expect(result).toEqual({ ok: false, error: Status.Conflict });
    expect(mockDb.artifact.update).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.update).not.toHaveBeenCalled();
  });

  it("does not clear deletedAt for duplicate pre-delete push redelivery", async () => {
    const deletedAt = new Date("2026-05-15T02:00:00Z");
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: "sha-before-delete",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T01:00:00Z"),
      lastPushBeforeSha: "sha-before-delete-parent",
      deletedAt,
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Closed,
      },
    };
    const reread = {
      id: "branch-artifact-1",
      branch: {
        ...existingBranch,
        currentPullRequestDetail: null,
      },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(reread),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        headSha: "sha-before-delete",
        beforeSha: "sha-before-delete-parent",
      })
    );

    expect(result).toEqual({ ok: true, value: reread });
    expect(mockDb.branchDetail.update).toHaveBeenCalled();
    const updateData = mockDb.branchDetail.update.mock.calls[0][0].data;
    expect(updateData.deletedAt).toBeUndefined();
    expect(mockDb.artifact.update).toHaveBeenCalledWith({
      where: { id: "branch-artifact-1" },
      data: expect.objectContaining({
        status: GitHubPRState.Closed,
      }),
    });
  });

  it("keeps tombstoned branches closed when unrelated stale push replay arrives", async () => {
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: "sha-before-delete",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T01:00:00Z"),
      lastPushBeforeSha: "sha-before-delete-parent",
      deletedAt: new Date("2026-05-15T02:00:00Z"),
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Closed,
      },
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        headSha: "sha-unrelated",
        beforeSha: "unrelated-parent",
      })
    );

    expect(result).toEqual({ ok: false, error: Status.Conflict });
    expect(mockDb.artifact.update).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.update).not.toHaveBeenCalled();
  });

  it("rejects same-project non-document source artifacts before linking", async () => {
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        findUnique: vi.fn(),
      },
      branchDetail: {
        findUnique: vi.fn(),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({ sourceArtifactId: "deployment-artifact-1" })
    );

    expect(result).toEqual({ ok: false, error: 403 });
    expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "deployment-artifact-1",
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        type: ArtifactType.DOCUMENT,
        subtype: {
          in: [
            ArtifactSubtype.PRD,
            ArtifactSubtype.IMPLEMENTATION_PLAN,
            ArtifactSubtype.FEATURE,
          ],
        },
      }),
      select: { document: { select: { repositorySnapshot: true } } },
    });
    expect(mockDb.artifact.create).not.toHaveBeenCalled();
    expect(mockDb.artifactLink.create).not.toHaveBeenCalled();
  });

  it("stores deprecated PR-route payloads as current PR detail on a branch artifact", async () => {
    const created = {
      id: "branch-artifact-1",
      branch: { artifactId: "branch-artifact-1" },
      pullRequest: null,
    };
    const reread = {
      ...created,
      pullRequest: { id: "pr-detail-1", githubId: "12345" },
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue({
          document: {
            repositorySnapshot: {
              repositories: [
                { fullName: REPO_FULL_NAME, role: "primary", position: 0 },
              ],
              source: "project_defaults",
            },
          },
        }),
        create: vi.fn().mockResolvedValue(created),
        findUnique: vi.fn().mockResolvedValue(reread),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
      pullRequestDetail: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: "pr-detail-1" }),
        updateMany: vi.fn(),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
        upsert: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        createdById: "user-1",
        sourceArtifactId: "plan-1",
        pullRequest: {
          githubId: "12345",
          number: 42,
          title: "Add branch artifacts",
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
          state: "OPEN",
          isDraft: false,
        },
      })
    );

    expect(result).toEqual({ ok: true, value: reread });
    expect(mockDb.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdById: "user-1",
      }),
      include: expectedBranchInclude,
    });
    expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: "plan-1",
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        type: ArtifactType.DOCUMENT,
        subtype: {
          in: [
            ArtifactSubtype.PRD,
            ArtifactSubtype.IMPLEMENTATION_PLAN,
            ArtifactSubtype.FEATURE,
          ],
        },
      },
      select: { document: { select: { repositorySnapshot: true } } },
    });
    expect(mockDb.pullRequestDetail.upsert).toHaveBeenCalledWith({
      where: { githubId: "12345" },
      create: expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        githubId: "12345",
        title: "Add branch artifacts",
        htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
        isCurrent: true,
      }),
      update: expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        title: "Add branch artifacts",
        isCurrent: true,
      }),
      select: { id: true },
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        isCurrent: true,
        id: { not: "pr-detail-1" },
      },
      data: { isCurrent: false },
    });
    expect(mockDb.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: { currentPullRequestDetailId: "pr-detail-1" },
    });
    expect(mockDb.artifactLink.upsert).toHaveBeenCalledWith({
      where: {
        sourceId_targetId_linkType: {
          sourceId: "plan-1",
          targetId: "branch-artifact-1",
          linkType: LinkType.Produces,
        },
      },
      create: {
        organizationId: ORG_ID,
        sourceId: "plan-1",
        targetId: "branch-artifact-1",
        linkType: LinkType.Produces,
      },
      update: {},
    });
  });

  it("backfills an existing branch artifact creator without replacing an existing creator", async () => {
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: "sha-1",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
      lastPushBeforeSha: "sha-0",
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Open,
      },
    };
    const reread = {
      id: "branch-artifact-1",
      branch: {
        ...existingBranch,
        currentPullRequestDetail: null,
      },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(reread),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({ createdById: "user-1", beforeSha: "sha-1" })
    );

    expect(result).toEqual({ ok: true, value: reread });
    expect(mockDb.artifact.update).toHaveBeenCalledWith({
      where: { id: "branch-artifact-1" },
      data: expect.objectContaining({
        createdById: "user-1",
      }),
    });

    existingBranch.artifact.createdById = "user-2";
    mockDb.artifact.update.mockClear();

    await branchService.upsertBranchArtifact(
      branchInput({ createdById: "user-1", beforeSha: "sha-1" })
    );

    expect(mockDb.artifact.update).toHaveBeenCalledWith({
      where: { id: "branch-artifact-1" },
      data: expect.not.objectContaining({
        createdById: expect.any(String),
      }),
    });
  });

  it("updates an existing branch head from a loop harness callback", async () => {
    const existingBranch = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.HarnessInput,
      headSha: "sha-from-prior-materialization",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
      lastPushBeforeSha: "sha-before-prior-materialization",
      currentPullRequestDetailId: null,
      artifact: {
        createdById: null as string | null,
        status: GitHubPRState.Open,
      },
    };
    const reread = {
      id: "branch-artifact-1",
      branch: {
        ...existingBranch,
        headSha: "sha-from-new-materialization",
        headShaSource: BranchHeadShaSource.HarnessInput,
        lastPushBeforeSha: null,
        currentPullRequestDetail: null,
      },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(reread),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(existingBranch),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        headSha: "sha-from-new-materialization",
        headShaSource: BranchHeadShaSource.HarnessInput,
        beforeSha: null,
      })
    );

    expect(result).toEqual({ ok: true, value: reread });
    expect(mockDb.branchDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "branch-artifact-1" },
      data: expect.objectContaining({
        headSha: "sha-from-new-materialization",
        headShaSource: BranchHeadShaSource.HarnessInput,
        lastPushBeforeSha: null,
      }),
    });
  });

  it("does not reopen a terminal branch artifact on push-only updates", async () => {
    const branchDetail = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      headSha: "sha-1",
      headShaSource: BranchHeadShaSource.PullRequestWebhook,
      headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
      lastPushBeforeSha: null,
      currentPullRequestDetailId: "pr-detail-1",
      artifact: { status: GitHubPRState.Merged },
    };
    const reread = {
      id: "branch-artifact-1",
      branch: {
        ...branchDetail,
        currentPullRequestDetail: {
          id: "pr-detail-1",
          prState: GitHubPRState.Merged,
        },
      },
      pullRequest: null,
    };
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(reread),
      },
      branchDetail: {
        findUnique: vi.fn().mockResolvedValue(branchDetail),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    const result = await branchService.upsertBranchArtifact(
      branchInput({
        baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
        headSha: "sha-2",
        beforeSha: "sha-1",
        pullRequest: null,
      })
    );

    expect(result).toEqual({
      ok: true,
      value: {
        ...reread,
        pullRequest: reread.branch.currentPullRequestDetail,
      },
    });
    expect(mockDb.artifact.update).toHaveBeenCalledWith({
      where: { id: "branch-artifact-1" },
      data: expect.objectContaining({
        status: GitHubPRState.Merged,
      }),
    });
  });

  it("demotes the previous current PR detail when a branch receives a different PR", async () => {
    const branchDetail = {
      artifactId: "branch-artifact-1",
      repositoryId: REPO_ID,
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
      headSha: "sha-2",
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
      lastPushBeforeSha: "sha-1",
      currentPullRequestDetailId: null as string | null,
    };
    const pullRequestDetails: Array<{
      id: string;
      branchArtifactId: string;
      repositoryId: string;
      githubId: string;
      number: number;
      title: string;
      htmlUrl: string;
      body: string | null;
      prState: string;
      isDraft: boolean;
      isCurrent: boolean;
      closedAt: Date | null;
      mergedAt: Date | null;
      mergeCommitSha: string | null;
    }> = [];
    const mockDb = {
      artifact: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "branch-artifact-1",
          branch: branchDetail,
          pullRequest: null,
        }),
        update: vi.fn(),
        findUnique: vi.fn().mockImplementation(() => {
          const currentPr =
            pullRequestDetails.find(
              (detail) => detail.id === branchDetail.currentPullRequestDetailId
            ) ?? null;
          return {
            id: "branch-artifact-1",
            branch: {
              ...branchDetail,
              currentPullRequestDetail: currentPr,
            },
            pullRequest: currentPr,
          };
        }),
      },
      branchDetail: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            ...branchDetail,
            artifact: { status: GitHubPRState.Open },
          }),
        update: vi.fn().mockImplementation(({ data }) => {
          Object.assign(branchDetail, data);
          return branchDetail;
        }),
      },
      pullRequestDetail: {
        // FEA-3212: adopt selects the single repo-less (githubId=null) row for
        // this branch+number, then updates it by id.
        findFirst: vi.fn().mockImplementation(({ where }) => {
          const match = pullRequestDetails.find(
            (detail) =>
              detail.branchArtifactId === where.branchArtifactId &&
              detail.number === where.number &&
              (detail.githubId === null || detail.githubId === undefined)
          );
          return match ? { id: match.id } : null;
        }),
        upsert: vi.fn().mockImplementation(({ where, create, update }) => {
          const existing = pullRequestDetails.find(
            (detail) => detail.githubId === where.githubId
          );
          if (existing) {
            Object.assign(existing, update);
            return { id: existing.id };
          }

          pullRequestDetails.push({ ...create });
          return { id: create.id };
        }),
        updateMany: vi.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const detail of pullRequestDetails) {
            if (
              detail.branchArtifactId === where.branchArtifactId &&
              detail.isCurrent === where.isCurrent &&
              detail.id !== where.id.not
            ) {
              Object.assign(detail, data);
              count += 1;
            }
          }
          return { count };
        }),
      },
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDbTx(mockDb);

    await branchService.upsertBranchArtifact(
      branchInput({
        pullRequest: {
          githubId: "111",
          number: 41,
          title: "First PR",
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/41",
          state: "OPEN",
        },
      })
    );
    await branchService.upsertBranchArtifact(
      branchInput({
        pullRequest: {
          githubId: "222",
          number: 42,
          title: "Second PR",
          htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
          state: "OPEN",
        },
      })
    );

    const firstPr = pullRequestDetails.find(
      (detail) => detail.githubId === "111"
    );
    const secondPr = pullRequestDetails.find(
      (detail) => detail.githubId === "222"
    );
    expect(pullRequestDetails).toHaveLength(2);
    expect(firstPr).toMatchObject({ title: "First PR", isCurrent: false });
    expect(secondPr).toMatchObject({ title: "Second PR", isCurrent: true });
    expect(branchDetail.currentPullRequestDetailId).toBe(secondPr?.id);
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenLastCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        isCurrent: true,
        id: { not: secondPr?.id },
      },
      data: { isCurrent: false },
    });
  });
});
