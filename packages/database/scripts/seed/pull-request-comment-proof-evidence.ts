import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  ArtifactType,
  GitHubPRState,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
} from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { deterministicUuid } from "./helpers";
import {
  PullRequestCommentProofFixture,
  pullRequestCommentProofIdentity,
} from "./pull-request-comment-proof-identity";
import { seedWroteSessionLink } from "./wrote-session-link";

const ALL_LANES = Object.values(PullRequestCommentLane);

/**
 * One merged PR per Branch, so the comment reconcile cron (open, current PRs)
 * never revisits it and overwrites the seeded proof (ISS-11767). A non-NULL
 * `comments_reconciled_at` means every lane was read complete (#8321), so only
 * the all-lanes fixture carries it; that also keeps a first view of it from
 * starting an on-demand reconcile.
 */
const PROOF_BRANCHES = [
  {
    key: PullRequestCommentProofFixture.Complete,
    branchName: "seed/pr-comment-proof-complete",
    number: 11_767,
    lanes: ALL_LANES,
    reconciled: true,
  },
  {
    key: PullRequestCommentProofFixture.MissingLane,
    branchName: "seed/pr-comment-proof-missing-lane",
    number: 11_768,
    lanes: ALL_LANES.filter((lane) => lane !== PullRequestCommentLane.REVIEWS),
    reconciled: false,
  },
] as const;

/** Branches whose PR-comment acquisition proof is complete, or missing one lane. */
export async function seedPullRequestCommentProofEvidence(
  prisma: TransactionClient,
  input: {
    organizationId: string;
    githubRepositoryId: string;
    projectId: string;
    computeTargetId: string;
  }
): Promise<void> {
  const observedAt = new Date("2026-01-01T11:00:00.000Z");
  for (const fixture of PROOF_BRANCHES) {
    const identity = pullRequestCommentProofIdentity(
      input.organizationId,
      fixture.key
    );
    const branchArtifactId = identity.branchArtifactId;
    const pullRequestDetailId = deterministicUuid(
      `pull-request-detail:${input.organizationId}:pr-comment-proof-${fixture.key}`
    );
    await prisma.artifact.upsert({
      where: { id: branchArtifactId },
      select: { id: true },
      create: {
        id: branchArtifactId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.BRANCH,
        name: fixture.branchName,
        slug: identity.branchSlug,
        status: BranchStatus.Merged,
        branch: {
          create: {
            organizationId: input.organizationId,
            repositoryId: input.githubRepositoryId,
            repositoryFullName: "seed-org/seed-repo",
            branchName: fixture.branchName,
            baseBranch: "main",
            firstPushedAt: observedAt,
            pushSource: BranchPushSource.Session,
          },
        },
      },
      update: {},
    });
    await seedWroteSessionLink(prisma, {
      organizationId: input.organizationId,
      computeTargetId: input.computeTargetId,
      branchArtifactId,
      observedAt,
      linkId: deterministicUuid(
        `artifact-link:${input.organizationId}:pr-comment-proof-${fixture.key}`
      ),
      session: {
        id: identity.sessionArtifactId,
        name: `Seed PR Comment Proof Session (${fixture.key})`,
        slug: identity.sessionSlug,
        externalSessionId: `seed-pr-comment-proof-${fixture.key}-${input.organizationId}`,
      },
    });
    await prisma.pullRequestDetail.upsert({
      where: { id: pullRequestDetailId },
      select: { id: true },
      create: {
        id: pullRequestDetailId,
        branchArtifactId,
        organizationId: input.organizationId,
        repositoryId: input.githubRepositoryId,
        repositoryFullName: "seed-org/seed-repo",
        number: fixture.number,
        title: `Seed pull request: ${fixture.branchName}`,
        prState: GitHubPRState.MERGED,
        mergedAt: observedAt,
        isCurrent: true,
        commentsReconciledAt: fixture.reconciled ? observedAt : null,
      },
      update: {},
    });
    for (const lane of fixture.lanes) {
      const proof = {
        generation: 1,
        status: PullRequestCommentLaneStatus.COMPLETE,
        itemCount: null,
        errorCode: null,
        listedAt: observedAt,
        lastCompleteListedAt: observedAt,
        incompleteStreak: 0,
        retractedCount: null,
        recordedAt: observedAt,
      };
      await prisma.pullRequestCommentAcquisition.upsert({
        where: { pullRequestDetailId_lane: { pullRequestDetailId, lane } },
        select: { pullRequestDetailId: true, lane: true },
        create: {
          pullRequestDetailId,
          organizationId: input.organizationId,
          lane,
          ...proof,
        },
        update: proof,
      });
    }
  }
}
