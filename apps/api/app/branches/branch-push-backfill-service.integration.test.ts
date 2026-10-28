import { randomUUID } from "node:crypto";
import { ArtifactType, BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github";
import {
  BranchPushTransitionState,
  verifyBranchPushTransition,
} from "@repo/github/branch-push-transition";
import { getCheckSuitePushEvidenceForCommit } from "@repo/github/check-suite-push-evidence";
import { getVerifiedBranchPushEvidence } from "@repo/github/verified-branch-push-evidence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";

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

import { acquireInstallationClient } from "@/lib/github/installation-client";
import { branchPushBackfillService } from "./branch-push-backfill-service";

const tracker = createCommittedTestOrganizationTracker();
const REPOSITORY = "closedloop-ai/closedloop-ai";
const BRANCH = "feature/collaborators";
const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const OBSERVED_AT = new Date("2026-09-30T00:00:00.000Z");

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 Branch pusher backfill tenant boundary",
  () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(async () => {
      vi.useRealTimers();
      await tracker.cleanup();
    });

    it("stores one webhook account receipt across replay and rejects a foreign tenant", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const repositoryId = await seedRepository(organizationId);
      const branchArtifactId = await seedBranch(
        organizationId,
        repositoryId,
        BRANCH,
        null
      );
      vi.mocked(acquireInstallationClient).mockResolvedValue({
        status: GitHubProviderResultStatus.Success,
        value: {} as never,
      });
      vi.mocked(verifyBranchPushTransition).mockResolvedValue(
        BranchPushTransitionState.NewCommits
      );
      vi.mocked(getCheckSuitePushEvidenceForCommit).mockResolvedValue({
        pushes: [],
        availability: BranchIdentityAvailability.Incomplete,
      });
      const input = {
        organizationId,
        branchArtifactId,
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        observedAt: OBSERVED_AT,
        sender: {
          id: 123,
          login: "reported-account",
          type: GitHubActorType.User,
        },
        deliveryId: "webhook-replay-1",
      };

      await expect(
        branchPushBackfillService.captureWebhookPush(input)
      ).resolves.toEqual({
        availability: BranchIdentityAvailability.Incomplete,
        observedCount: 1,
        recordedCount: 1,
      });
      await expect(
        branchPushBackfillService.captureWebhookPush(input)
      ).resolves.toEqual({
        availability: BranchIdentityAvailability.Incomplete,
        observedCount: 1,
        recordedCount: 0,
      });
      await expect(
        branchPushBackfillService.captureWebhookPush({
          ...input,
          organizationId: foreignOrganizationId,
          deliveryId: "foreign-webhook",
        })
      ).resolves.toEqual({
        availability: BranchIdentityAvailability.Unavailable,
        observedCount: 0,
        recordedCount: 0,
      });
      const rows = await withDb((db) =>
        db.branchPushContribution.findMany({
          where: { organizationId, branchArtifactId },
          select: {
            providerUserId: true,
            source: true,
            sourceEventId: true,
            repositoryFullName: true,
            refName: true,
          },
        })
      );
      expect(rows).toEqual([
        {
          providerUserId: "123",
          source: BranchPushContributionSource.Webhook,
          sourceEventId: "webhook-replay-1",
          repositoryFullName: REPOSITORY,
          refName: BRANCH,
        },
      ]);
      expect(acquireInstallationClient).toHaveBeenCalledTimes(2);
    });

    it("skips an earlier cross-org repository pointer and records only the owned Branch", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const foreignRepoId = await seedRepository(foreignOrganizationId);
      const ownRepoId = await seedRepository(organizationId);
      const mismatchedBranchId = await seedBranch(
        organizationId,
        foreignRepoId,
        "feature/mismatched",
        null
      );
      const branchArtifactId = await seedBranch(
        organizationId,
        ownRepoId,
        BRANCH,
        new Date("2026-01-01T00:00:00.000Z")
      );
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
            observedAt: OBSERVED_AT,
          },
        ],
        availability: BranchIdentityAvailability.Incomplete,
      });

      const result = await branchPushBackfillService.runNext({
        organizationId,
      });

      expect(result).toEqual({
        availability: BranchIdentityAvailability.Incomplete,
        observedCount: 1,
        recordedCount: 1,
      });
      const rows = await withDb((db) =>
        db.branchPushContribution.findMany({
          where: { organizationId },
          select: { branchArtifactId: true, providerUserId: true },
        })
      );
      expect(rows).toEqual([{ branchArtifactId, providerUserId: "123" }]);
      const coverage = await withDb((db) =>
        db.branchDetail.findMany({
          where: {
            artifactId: { in: [branchArtifactId, mismatchedBranchId] },
            organizationId,
          },
          select: {
            artifactId: true,
            pushCoverageAvailability: true,
            pushCoverageLastAttemptAt: true,
          },
        })
      );
      expect(
        coverage.find((row) => row.artifactId === branchArtifactId)
      ).toMatchObject({
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
        pushCoverageLastAttemptAt: expect.any(Date),
      });
      expect(
        coverage.find((row) => row.artifactId === mismatchedBranchId)
      ).toMatchObject({
        pushCoverageAvailability: null,
        pushCoverageLastAttemptAt: null,
      });
    });

    it("does not let a stale same-org repository pointer starve a valid Branch", async () => {
      const organizationId = await tracker.create();
      const staleRepositoryId = await seedRepository(
        organizationId,
        "renamed-repository"
      );
      const validRepositoryId = await seedRepository(organizationId);
      const staleBranchId = await seedBranch(
        organizationId,
        staleRepositoryId,
        "feature/stale",
        null,
        OBSERVED_AT,
        "00000000-0000-7000-8000-000000000001"
      );
      const validBranchId = await seedBranch(
        organizationId,
        validRepositoryId,
        BRANCH,
        null,
        OBSERVED_AT,
        "00000000-0000-7000-8000-000000000002"
      );
      vi.mocked(acquireInstallationClient).mockResolvedValue({
        status: GitHubProviderResultStatus.Success,
        value: {} as never,
      });
      vi.mocked(getVerifiedBranchPushEvidence).mockResolvedValue({
        pushes: [],
        availability: BranchIdentityAvailability.Incomplete,
      });

      await expect(
        branchPushBackfillService.runNext({ organizationId })
      ).resolves.toEqual({
        availability: BranchIdentityAvailability.Incomplete,
        observedCount: 0,
        recordedCount: 0,
      });
      expect(getVerifiedBranchPushEvidence).toHaveBeenCalledOnce();
      await expect(
        branchPushBackfillService.runNext({ organizationId })
      ).resolves.toBeNull();
      expect(getVerifiedBranchPushEvidence).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ branchName: BRANCH })
      );
      const coverage = await withDb((db) =>
        db.branchDetail.findMany({
          where: {
            artifactId: { in: [staleBranchId, validBranchId] },
            organizationId,
          },
          select: {
            artifactId: true,
            pushCoverageLastAttemptAt: true,
          },
        })
      );
      expect(
        coverage.find((row) => row.artifactId === staleBranchId)
          ?.pushCoverageLastAttemptAt
      ).toBeInstanceOf(Date);
      expect(
        coverage.find((row) => row.artifactId === validBranchId)
          ?.pushCoverageLastAttemptAt
      ).toBeInstanceOf(Date);
    });

    it("gives due retries a turn alongside a larger never-attempted backlog", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const attemptAt = new Date("2030-01-01T00:00:00Z");
      vi.setSystemTime(attemptAt);
      const organizationId = await tracker.create();
      const repositoryId = await seedRepository(organizationId);
      for (let index = 0; index < 6; index++) {
        await seedBranch(
          organizationId,
          repositoryId,
          `feature/new-${index}`,
          null
        );
      }
      const retryName = "feature/due-retry";
      const retryId = await seedBranch(
        organizationId,
        repositoryId,
        retryName,
        new Date("2020-01-01T00:00:00Z")
      );
      vi.mocked(acquireInstallationClient).mockResolvedValue({
        status: GitHubProviderResultStatus.Success,
        value: {} as never,
      });
      vi.mocked(getVerifiedBranchPushEvidence).mockResolvedValue({
        pushes: [],
        availability: BranchIdentityAvailability.Incomplete,
      });

      await branchPushBackfillService.runNext({ organizationId });

      expect(getVerifiedBranchPushEvidence).toHaveBeenCalledTimes(7);
      expect(
        vi
          .mocked(getVerifiedBranchPushEvidence)
          .mock.calls.map((call) => call[1].branchName)
      ).toContain(retryName);
      const detail = await withDb((db) =>
        db.branchDetail.findUniqueOrThrow({
          where: { artifactId: retryId },
          select: { pushCoverageLastAttemptAt: true },
        })
      );
      expect(detail.pushCoverageLastAttemptAt).toEqual(attemptAt);
    });

    it("scans a PR-backed Branch before a first-push timestamp is known", async () => {
      const organizationId = await tracker.create();
      const repositoryId = await seedRepository(organizationId);
      const branchArtifactId = await seedBranch(
        organizationId,
        repositoryId,
        BRANCH,
        null,
        null
      );
      await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId,
            branchArtifactId,
            repositoryFullName: REPOSITORY,
            number: 5133,
            headRefName: BRANCH,
            headRepositoryFullName: REPOSITORY,
          },
        })
      );
      vi.mocked(acquireInstallationClient).mockResolvedValue({
        status: GitHubProviderResultStatus.Success,
        value: {} as never,
      });
      vi.mocked(getVerifiedBranchPushEvidence).mockResolvedValue({
        pushes: [],
        availability: BranchIdentityAvailability.Incomplete,
      });

      const result = await branchPushBackfillService.runNext({
        organizationId,
      });

      expect(result).toEqual({
        availability: BranchIdentityAvailability.Incomplete,
        observedCount: 0,
        recordedCount: 0,
      });
      expect(getVerifiedBranchPushEvidence).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          pullRequests: [
            { owner: "closedloop-ai", repo: "closedloop-ai", number: 5133 },
          ],
          branchName: BRANCH,
        })
      );
    });
  }
);

async function seedRepository(
  organizationId: string,
  name = "closedloop-ai"
): Promise<string> {
  return await withDb(async (db) => {
    const installation = await db.gitHubInstallation.upsert({
      where: { organizationId },
      create: {
        organizationId,
        installationId: randomUUID(),
        accountId: randomUUID(),
        accountLogin: "closedloop-ai",
        accountType: "Organization",
        senderLogin: "fixture-user",
        senderId: randomUUID(),
        status: GitHubInstallationStatus.ACTIVE,
      },
      update: {},
      select: { id: true },
    });
    const repository = await db.gitHubInstallationRepository.create({
      data: {
        installationId: installation.id,
        githubRepoId: randomUUID(),
        fullName: `closedloop-ai/${name}`,
        owner: "closedloop-ai",
        name,
        private: false,
      },
      select: { id: true },
    });
    return repository.id;
  });
}

async function seedBranch(
  organizationId: string,
  repositoryId: string,
  branchName: string,
  pushCoverageLastAttemptAt: Date | null,
  firstPushedAt: Date | null = OBSERVED_AT,
  id?: string
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        ...(id ? { id } : {}),
        organizationId,
        type: ArtifactType.Branch,
        name: branchName,
        status: BranchStatus.Open,
        branch: {
          create: {
            organizationId,
            repositoryId,
            repositoryFullName: REPOSITORY,
            branchName,
            firstPushedAt,
            pushSource: firstPushedAt ? BranchPushSource.Session : null,
            pushCoverageLastAttemptAt,
          },
        },
      },
      select: { id: true },
    })
  );
  return artifact.id;
}
