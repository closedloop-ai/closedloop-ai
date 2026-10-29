import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/app/comments/external-authors", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveExternalGitHubAuthorInTransaction: vi.fn(),
}));

import {
  ExternalGitHubCollaboratorSourceKind,
  resolveExternalGitHubAuthorInTransaction,
} from "@/app/comments/external-authors";
import {
  BranchPushContributionWriteResult,
  invalidateBranchPushCoverageAfterWebhook,
  recordBranchPushContribution,
} from "./branch-push-contribution-service";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "55555555-5555-4555-8555-555555555551";
const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const input = {
  organizationId: ORGANIZATION_ID,
  branchArtifactId: BRANCH_ID,
  repositoryFullName: "ClosedLoop-AI/ClosedLoop-AI.git",
  refName: "feature/collaborators",
  beforeSha: BEFORE_SHA,
  afterSha: AFTER_SHA,
  source: BranchPushContributionSource.GraphqlPush,
  sourceEventId: "delivery-1",
  providerUserId: "123",
  providerLogin: "alice",
  actorType: GitHubActorType.User,
  newCommitCount: 1,
  observedAt: new Date("2026-09-30T00:00:00.000Z"),
} as const;

const branchFindFirst = vi.fn();
const createMany = vi.fn();
const branchUpdateMany = vi.fn();
const tx = {
  branchDetail: { findFirst: branchFindFirst },
  branchPushContribution: { createMany },
};
const db = {
  branchDetail: { updateMany: branchUpdateMany },
};

describe("recordBranchPushContribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    branchFindFirst.mockResolvedValue({ artifactId: BRANCH_ID });
    createMany.mockResolvedValue({ count: 1 });
    vi.mocked(withDb.tx).mockImplementation(async (fn) => fn(tx as never));
    vi.mocked(withDb).mockImplementation(async (fn) => fn(db as never));
  });

  it("records the reported human account only for the exact org/repo/ref", async () => {
    await expect(recordBranchPushContribution(input)).resolves.toBe(
      BranchPushContributionWriteResult.Recorded
    );

    expect(branchFindFirst).toHaveBeenCalledWith({
      where: {
        artifactId: BRANCH_ID,
        organizationId: ORGANIZATION_ID,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        branchName: "feature/collaborators",
        artifact: { type: ArtifactType.Branch },
      },
      select: { artifactId: true },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: ORGANIZATION_ID,
          branchArtifactId: BRANCH_ID,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          refName: "feature/collaborators",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          source: BranchPushContributionSource.GraphqlPush,
          sourceEventId: "delivery-1",
          providerUserId: "123",
          actorType: GitHubActorType.User,
          observedAt: input.observedAt,
        },
      ],
      skipDuplicates: true,
    });
    expect(resolveExternalGitHubAuthorInTransaction).toHaveBeenCalledWith(tx, {
      organizationId: ORGANIZATION_ID,
      author: {
        id: "123",
        login: "alice",
        actorType: GitHubActorType.User,
      },
      source: {
        sourceKind: ExternalGitHubCollaboratorSourceKind.Push,
        githubObjectId: "delivery-1",
      },
    });
  });

  it("recognizes a repeated delivery without duplicating its contribution", async () => {
    createMany.mockResolvedValue({ count: 0 });

    await expect(recordBranchPushContribution(input)).resolves.toBe(
      BranchPushContributionWriteResult.Duplicate
    );
    expect(resolveExternalGitHubAuthorInTransaction).not.toHaveBeenCalled();
  });

  it.each([
    { newCommitCount: 0 },
    { afterSha: BEFORE_SHA },
    { actorType: GitHubActorType.Bot },
    { actorType: GitHubActorType.Unknown },
  ])("ignores a non-qualifying transition %j", async (change) => {
    await expect(
      recordBranchPushContribution({ ...input, ...change })
    ).resolves.toBe(BranchPushContributionWriteResult.Ignored);

    expect(branchFindFirst).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("refuses a push whose Branch identity does not match", async () => {
    branchFindFirst.mockResolvedValue(null);

    await expect(recordBranchPushContribution(input)).resolves.toBe(
      BranchPushContributionWriteResult.Ignored
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it("rejects an invalid provider account instead of inventing one", async () => {
    await expect(
      recordBranchPushContribution({ ...input, providerUserId: "unknown" })
    ).rejects.toBeDefined();
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an impossible new-commit count %s",
    async (newCommitCount) => {
      await expect(
        recordBranchPushContribution({ ...input, newCommitCount })
      ).rejects.toBeDefined();
      expect(createMany).not.toHaveBeenCalled();
    }
  );

  it("resets the push coverage retry clock after a webhook transition", async () => {
    branchUpdateMany.mockResolvedValue({ count: 1 });

    await invalidateBranchPushCoverageAfterWebhook({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
    });

    expect(branchUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: ORGANIZATION_ID,
        artifactId: BRANCH_ID,
        artifact: { type: ArtifactType.Branch },
      },
      data: {
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
        pushCoverageLastAttemptAt: null,
      },
    });
  });
});
