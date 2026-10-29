import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import {
  BranchPushTransitionState,
  verifyBranchPushTransition,
} from "@repo/github/branch-push-transition";
import { getCheckSuitePushEvidenceForCommit } from "@repo/github/check-suite-push-evidence";
import {
  getVerifiedBranchPushEvidence,
  MAX_ASSOCIATED_PULL_REQUESTS,
} from "@repo/github/verified-branch-push-evidence";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: vi.fn(),
}));
vi.mock(
  "@repo/github/verified-branch-push-evidence",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getVerifiedBranchPushEvidence: vi.fn(),
  })
);
vi.mock("@/lib/github/installation-client", () => ({
  acquireInstallationClient: vi.fn(),
}));
vi.mock("@repo/github/branch-push-transition", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyBranchPushTransition: vi.fn(),
}));
vi.mock("@repo/github/check-suite-push-evidence", () => ({
  getCheckSuitePushEvidenceForCommit: vi.fn(),
}));
vi.mock("./branch-push-contribution-service", () => ({
  BranchPushContributionWriteResult: {
    Recorded: "recorded",
    Duplicate: "duplicate",
    Ignored: "ignored",
  },
  recordBranchPushContribution: vi.fn(),
}));

import { acquireInstallationClient } from "@/lib/github/installation-client";
import { branchPushBackfillService } from "./branch-push-backfill-service";
import {
  BranchPushContributionWriteResult,
  recordBranchPushContribution,
} from "./branch-push-contribution-service";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "55555555-5555-4555-8555-555555555551";
const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const NOW = new Date("2026-09-30T00:00:00.000Z");
const branch = {
  repositoryFullName: "closedloop-ai/closedloop-ai",
  branchName: "feature/collaborators",
  pushCoverageLastAttemptAt: null,
  repository: {
    owner: "closedloop-ai",
    name: "closedloop-ai",
    fullName: "closedloop-ai/closedloop-ai",
    removedAt: null,
    installation: {
      organizationId: ORGANIZATION_ID,
      installationId: "installation-123",
      status: GitHubInstallationStatus.ACTIVE,
    },
  },
};
const branchFindFirst = vi.fn();
const branchUpdateMany = vi.fn();
const pullRequestFindMany = vi.fn();
const db = {
  branchDetail: {
    findFirst: branchFindFirst,
    updateMany: branchUpdateMany,
  },
  pullRequestDetail: { findMany: pullRequestFindMany },
};

describe("backfillBranchPushContributions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(withDb).mockImplementation(async (fn) => await fn(db as never));
    branchFindFirst.mockResolvedValue(branch);
    branchUpdateMany.mockResolvedValue({ count: 1 });
    pullRequestFindMany.mockResolvedValue([
      {
        number: 5133,
        repositoryFullName: branch.repositoryFullName,
        repository: null,
        headRefName: branch.branchName,
        headRepositoryFullName: branch.repositoryFullName,
      },
      {
        number: 7338,
        repositoryFullName: branch.repositoryFullName,
        repository: null,
        headRefName: branch.branchName,
        headRepositoryFullName: branch.repositoryFullName,
      },
    ]);
    vi.mocked(acquireInstallationClient).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {} as never,
    });
    vi.mocked(getVerifiedBranchPushEvidence).mockResolvedValue({
      pushes: [
        {
          source: BranchPushContributionSource.GraphqlPush,
          sourceEventId: "PSH_1",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          actorType: GitHubActorType.User,
          observedAt: NOW,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    vi.mocked(recordBranchPushContribution).mockResolvedValue(
      BranchPushContributionWriteResult.Recorded
    );
  });

  it("captures only the GraphQL-reported account on the webhook's exact transition", async () => {
    vi.mocked(verifyBranchPushTransition).mockResolvedValue(
      BranchPushTransitionState.NewCommits
    );
    vi.mocked(getCheckSuitePushEvidenceForCommit).mockResolvedValue({
      availability: BranchIdentityAvailability.Incomplete,
      pushes: [
        {
          pushId: "PSH_webhook",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "456",
          providerLogin: "graphql-pusher",
          actorType: GitHubActorType.User,
        },
        {
          pushId: "PSH_earlier",
          beforeSha: "c".repeat(40),
          afterSha: AFTER_SHA,
          providerUserId: "789",
          actorType: GitHubActorType.User,
        },
      ],
    });

    await expect(
      branchPushBackfillService.captureWebhookPush({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        observedAt: NOW,
        sender: {
          id: 123,
          login: "webhook-sender",
          type: GitHubActorType.User,
        },
        deliveryId: "delivery-preferred-pusher",
      })
    ).resolves.toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      observedCount: 1,
      recordedCount: 1,
    });
    expect(verifyBranchPushTransition).toHaveBeenCalledWith(expect.anything(), {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
    });
    expect(getCheckSuitePushEvidenceForCommit).toHaveBeenCalledWith(
      expect.anything(),
      {
        owner: "closedloop-ai",
        repo: "closedloop-ai",
        branchName: branch.branchName,
        commitSha: AFTER_SHA,
      }
    );
    expect(recordBranchPushContribution).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      repositoryFullName: branch.repositoryFullName,
      refName: branch.branchName,
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      source: BranchPushContributionSource.GraphqlPush,
      sourceEventId: "PSH_webhook",
      providerUserId: "456",
      providerLogin: "graphql-pusher",
      actorType: GitHubActorType.User,
      newCommitCount: 1,
      observedAt: NOW,
    });
    expect(branchUpdateMany).not.toHaveBeenCalled();
  });

  it("does not replace unavailable CheckSuite pusher evidence with the webhook sender", async () => {
    vi.mocked(verifyBranchPushTransition).mockResolvedValue(
      BranchPushTransitionState.NewCommits
    );
    vi.mocked(getCheckSuitePushEvidenceForCommit).mockResolvedValue({
      pushes: [],
      availability: BranchIdentityAvailability.Unavailable,
    });

    const result = await branchPushBackfillService.captureWebhookPush({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      observedAt: NOW,
      sender: { id: 123, login: "alice", type: GitHubActorType.User },
      deliveryId: "delivery-unavailable-checks",
    });

    expect(result).toEqual({
      availability: BranchIdentityAvailability.Unavailable,
      observedCount: 0,
      recordedCount: 0,
    });
    expect(recordBranchPushContribution).not.toHaveBeenCalled();
  });

  it("records the webhook-reported account by delivery ID when check suites have no pusher", async () => {
    vi.mocked(verifyBranchPushTransition).mockResolvedValue(
      BranchPushTransitionState.NewCommits
    );
    vi.mocked(getCheckSuitePushEvidenceForCommit).mockResolvedValue({
      pushes: [],
      availability: BranchIdentityAvailability.Incomplete,
    });
    const result = await branchPushBackfillService.captureWebhookPush({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      observedAt: NOW,
      sender: { id: 123, login: "alice", type: GitHubActorType.User },
      deliveryId: "delivery-fallback",
    });

    expect(result).toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      observedCount: 1,
      recordedCount: 1,
    });
    expect(recordBranchPushContribution).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      repositoryFullName: branch.repositoryFullName,
      refName: branch.branchName,
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      source: BranchPushContributionSource.Webhook,
      sourceEventId: "delivery-fallback",
      providerUserId: "123",
      providerLogin: "alice",
      actorType: GitHubActorType.User,
      newCommitCount: 1,
      observedAt: NOW,
    });
  });

  it.each([
    { id: 123, login: "ghost", type: GitHubActorType.User },
    { id: 123, login: "bot", type: GitHubActorType.Bot },
    { id: 123, login: "unknown", type: GitHubActorType.Unknown },
    { id: -1, login: "alice", type: GitHubActorType.User },
  ])(
    "does not infer a person from a non-qualifying webhook sender %j",
    async (sender) => {
      vi.mocked(verifyBranchPushTransition).mockResolvedValue(
        BranchPushTransitionState.NewCommits
      );
      vi.mocked(getCheckSuitePushEvidenceForCommit).mockResolvedValue({
        pushes: [],
        availability: BranchIdentityAvailability.Incomplete,
      });

      const result = await branchPushBackfillService.captureWebhookPush({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        observedAt: NOW,
        sender,
        deliveryId: "delivery-excluded",
      });

      expect(result).toEqual({
        availability: BranchIdentityAvailability.Incomplete,
        observedCount: 0,
        recordedCount: 0,
      });
      expect(recordBranchPushContribution).not.toHaveBeenCalled();
    }
  );

  it("does not replace a provider-excluded pusher with the webhook sender", async () => {
    vi.mocked(verifyBranchPushTransition).mockResolvedValue(
      BranchPushTransitionState.NewCommits
    );
    vi.mocked(getCheckSuitePushEvidenceForCommit).mockResolvedValue({
      pushes: [],
      availability: BranchIdentityAvailability.Incomplete,
      excludedTransitions: [{ beforeSha: BEFORE_SHA, afterSha: AFTER_SHA }],
    });

    const result = await branchPushBackfillService.captureWebhookPush({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      observedAt: NOW,
      sender: { id: 123, login: "alice", type: GitHubActorType.User },
      deliveryId: "delivery-provider-bot",
    });

    expect(result).toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      observedCount: 0,
      recordedCount: 0,
    });
    expect(recordBranchPushContribution).not.toHaveBeenCalled();
  });

  it.each([
    BranchPushTransitionState.NoNewCommits,
    BranchPushTransitionState.Unavailable,
  ])("does not capture an unproven webhook transition (%s)", async (state) => {
    vi.mocked(verifyBranchPushTransition).mockResolvedValue(state);

    const result = await branchPushBackfillService.captureWebhookPush({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      observedAt: NOW,
    });

    expect(result).toEqual({
      availability: BranchIdentityAvailability.Unavailable,
      observedCount: 0,
      recordedCount: 0,
    });
    expect(getCheckSuitePushEvidenceForCommit).not.toHaveBeenCalled();
    expect(recordBranchPushContribution).not.toHaveBeenCalled();
  });

  it("keeps missing webhook pusher evidence incomplete for the scheduled backfill", async () => {
    vi.mocked(verifyBranchPushTransition).mockResolvedValue(
      BranchPushTransitionState.NewCommits
    );
    vi.mocked(getCheckSuitePushEvidenceForCommit).mockResolvedValue({
      pushes: [],
      availability: BranchIdentityAvailability.Incomplete,
    });

    await expect(
      branchPushBackfillService.captureWebhookPush({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        observedAt: NOW,
      })
    ).resolves.toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      observedCount: 0,
      recordedCount: 0,
    });
    expect(recordBranchPushContribution).not.toHaveBeenCalled();
    expect(branchUpdateMany).not.toHaveBeenCalled();
  });

  it("uses the org's installation and persists only verified exact-ref pushes", async () => {
    await expect(
      branchPushBackfillService.backfillBranch({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
        observedAt: NOW,
      })
    ).resolves.toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      observedCount: 1,
      recordedCount: 1,
    });
    expect(branchFindFirst).toHaveBeenCalledWith({
      where: {
        artifactId: BRANCH_ID,
        organizationId: ORGANIZATION_ID,
        artifact: { type: ArtifactType.Branch },
      },
      select: expect.any(Object),
    });
    expect(pullRequestFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
      },
      select: {
        number: true,
        repositoryFullName: true,
        headRefName: true,
        headRepositoryFullName: true,
        repository: { select: { fullName: true } },
      },
      orderBy: [{ number: "asc" }, { id: "asc" }],
      take: MAX_ASSOCIATED_PULL_REQUESTS + 1,
    });
    expect(acquireInstallationClient).toHaveBeenCalledWith("installation-123", {
      fetch: expect.any(Function),
    });
    expect(branchUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        artifactId: BRANCH_ID,
        organizationId: ORGANIZATION_ID,
        pushCoverageLastAttemptAt: null,
      },
      data: {
        pushCoverageLastAttemptAt: NOW,
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
      },
    });
    expect(branchUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        artifactId: BRANCH_ID,
        organizationId: ORGANIZATION_ID,
        pushCoverageLastAttemptAt: NOW,
      },
      data: { pushCoverageAvailability: BranchIdentityAvailability.Incomplete },
    });
    expect(getVerifiedBranchPushEvidence).toHaveBeenCalledWith(
      expect.anything(),
      {
        owner: "closedloop-ai",
        repo: "closedloop-ai",
        branchName: branch.branchName,
        pullRequests: [
          { owner: "closedloop-ai", repo: "closedloop-ai", number: 5133 },
          { owner: "closedloop-ai", repo: "closedloop-ai", number: 7338 },
        ],
        observedAt: NOW,
        readBudget: expect.objectContaining({
          fetch: expect.any(Function),
          withRequestLimit: expect.any(Function),
        }),
      }
    );
    expect(recordBranchPushContribution).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      repositoryFullName: branch.repositoryFullName,
      refName: branch.branchName,
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      source: BranchPushContributionSource.GraphqlPush,
      sourceEventId: "PSH_1",
      providerUserId: "123",
      actorType: GitHubActorType.User,
      newCommitCount: 1,
      observedAt: NOW,
    });
  });

  it("verifies a legacy PR with no base repository through the Branch repository", async () => {
    pullRequestFindMany.mockResolvedValue([
      {
        number: 42,
        repositoryFullName: null,
        repository: null,
      },
    ]);
    const get = vi.fn().mockResolvedValue({
      data: {
        head: {
          ref: branch.branchName,
          repo: { full_name: branch.repositoryFullName },
        },
      },
    });
    vi.mocked(acquireInstallationClient).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: { rest: { pulls: { get } } } as never,
    });

    await branchPushBackfillService.backfillBranch({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      observedAt: NOW,
    });

    expect(get).toHaveBeenCalledWith({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      pull_number: 42,
    });
    expect(getVerifiedBranchPushEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pullRequests: [
          { owner: "closedloop-ai", repo: "closedloop-ai", number: 42 },
        ],
      })
    );
  });

  it("excludes a same-named PR head in another repository", async () => {
    pullRequestFindMany.mockResolvedValue([
      {
        number: 7338,
        repositoryFullName: "upstream/base",
        repository: null,
        headRefName: branch.branchName,
        headRepositoryFullName: "other/fork",
      },
    ]);
    const get = vi.fn().mockResolvedValue({
      data: {
        head: {
          ref: branch.branchName,
          repo: { full_name: "other/fork" },
        },
      },
    });
    vi.mocked(acquireInstallationClient).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: { rest: { pulls: { get } } } as never,
    });
    vi.mocked(getVerifiedBranchPushEvidence).mockResolvedValue({
      pushes: [],
      availability: BranchIdentityAvailability.Incomplete,
    });

    await branchPushBackfillService.backfillBranch({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      observedAt: NOW,
    });

    expect(get).toHaveBeenCalledWith({
      owner: "upstream",
      repo: "base",
      pull_number: 7338,
    });
    expect(getVerifiedBranchPushEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pullRequests: [] })
    );
    expect(recordBranchPushContribution).not.toHaveBeenCalled();
  });

  it("recovers a stale stored PR head only after exact provider verification", async () => {
    pullRequestFindMany.mockResolvedValue([
      {
        number: 7338,
        repositoryFullName: "upstream/base",
        repository: null,
        headRefName: "feature/old",
        headRepositoryFullName: "other/fork",
      },
    ]);
    const get = vi.fn().mockResolvedValue({
      data: {
        head: {
          ref: branch.branchName,
          repo: { full_name: branch.repositoryFullName },
        },
      },
    });
    vi.mocked(acquireInstallationClient).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: { rest: { pulls: { get } } } as never,
    });

    await branchPushBackfillService.backfillBranch({
      organizationId: ORGANIZATION_ID,
      branchArtifactId: BRANCH_ID,
      observedAt: NOW,
    });

    expect(getVerifiedBranchPushEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pullRequests: [{ owner: "upstream", repo: "base", number: 7338 }],
      })
    );
  });

  it("does not fetch or write for a foreign or uninstalled Branch", async () => {
    branchFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...branch,
      repository: {
        ...branch.repository,
        installation: {
          ...branch.repository.installation,
          organizationId: "22222222-2222-4222-8222-222222222222",
        },
      },
    });

    await expect(
      branchPushBackfillService.backfillBranch({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
      })
    ).resolves.toEqual({
      availability: BranchIdentityAvailability.Unavailable,
      observedCount: 0,
      recordedCount: 0,
    });
    await expect(
      branchPushBackfillService.backfillBranch({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
      })
    ).resolves.toMatchObject({
      availability: BranchIdentityAvailability.Unavailable,
    });
    expect(acquireInstallationClient).not.toHaveBeenCalled();
    expect(recordBranchPushContribution).not.toHaveBeenCalled();
  });

  it("marks coverage incomplete before a provider acquisition failure", async () => {
    vi.mocked(acquireInstallationClient).mockRejectedValue(
      new Error("provider unavailable")
    );

    await expect(
      branchPushBackfillService.backfillBranch({
        organizationId: ORGANIZATION_ID,
        branchArtifactId: BRANCH_ID,
        observedAt: NOW,
      })
    ).rejects.toThrow("provider unavailable");

    expect(branchUpdateMany).toHaveBeenCalledOnce();
    expect(branchUpdateMany).toHaveBeenCalledWith({
      where: {
        artifactId: BRANCH_ID,
        organizationId: ORGANIZATION_ID,
        pushCoverageLastAttemptAt: null,
      },
      data: {
        pushCoverageLastAttemptAt: NOW,
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
      },
    });
    expect(recordBranchPushContribution).not.toHaveBeenCalled();
  });
});
