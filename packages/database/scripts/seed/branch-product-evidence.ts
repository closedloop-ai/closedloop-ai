import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { ArtifactType } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { deterministicUuid } from "./helpers";
import { seedPullRequestCommentProofEvidence } from "./pull-request-comment-proof-evidence";
import { seedWroteSessionLink } from "./wrote-session-link";

/** Synthetic fixture evidence isolates native commenter membership from seeded authors and comments. */
export async function seedBranchProductEvidence(
  prisma: TransactionClient,
  input: {
    organizationId: string;
    githubRepositoryId: string;
    projectId: string;
    computeTargetId: string;
  }
): Promise<void> {
  const observedAt = new Date("2026-01-01T11:00:00.000Z");
  await prisma.gitHubInstallationRepository.update({
    where: { id: input.githubRepositoryId },
    select: { id: true },
    data: {
      defaultBranchName: "main",
      defaultBranchAvailability: RepositoryDefaultAvailability.Available,
      defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
      defaultBranchSource: RepositoryDefaultSource.PushWebhook,
      defaultBranchMechanism: GitHubFetchMechanism.Webhook,
      defaultBranchTrigger: GitHubFetchTrigger.Webhook,
      defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
      defaultBranchObservationKey: `seed-default:${input.organizationId}`,
      defaultBranchObservedAt: observedAt,
    },
  });
  const branchArtifactId = deterministicUuid(
    `artifact:branch:${input.organizationId}:collaborator-fixture`
  );
  const orgPrefix = input.organizationId.slice(0, 8);
  await prisma.artifact.upsert({
    where: { id: branchArtifactId },
    select: { id: true },
    create: {
      id: branchArtifactId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      type: ArtifactType.BRANCH,
      name: "seed/collaborators-branch",
      slug: `seed-collaborator-branch-${orgPrefix}`,
      status: BranchStatus.Open,
      branch: {
        create: {
          organizationId: input.organizationId,
          repositoryId: input.githubRepositoryId,
          repositoryFullName: "seed-org/seed-repo",
          branchName: "seed/collaborators-branch",
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
      `seed-collaborator-session-branch:${input.organizationId}`
    ),
    session: {
      id: deterministicUuid(
        `artifact:session:${input.organizationId}:collaborator-fixture`
      ),
      name: "Seed Collaborator Evidence Session",
      slug: `seed-collaborator-session-${orgPrefix}`,
      externalSessionId: `seed-collaborator-evidence-${input.organizationId}`,
    },
  });
  await seedPullRequestCommentProofEvidence(prisma, input);
}
