import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  BranchIdentityAvailability,
  isHumanGitHubActor,
} from "@repo/api/src/types/branch-identity";
import {
  BRANCH_PUSH_SHA_RE,
  BranchPushContributionSource,
  isPlausibleBranchPushTransition,
} from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { ArtifactType, withDb } from "@repo/database";
import { z } from "zod";
import {
  ExternalGitHubCollaboratorSourceKind,
  resolveExternalGitHubAuthorInTransaction,
} from "@/app/comments/external-authors";

const PROVIDER_USER_ID_RE = /^\d+$/;

const branchPushContributionInputSchema = z.object({
  organizationId: z.uuid(),
  branchArtifactId: z.uuid(),
  repositoryFullName: z.string().min(1),
  refName: z.string().min(1),
  beforeSha: z.string().regex(BRANCH_PUSH_SHA_RE),
  afterSha: z.string().regex(BRANCH_PUSH_SHA_RE),
  source: z.enum(BranchPushContributionSource),
  sourceEventId: z.string().trim().min(1).max(255),
  providerUserId: z.string().regex(PROVIDER_USER_ID_RE),
  providerLogin: z.string().min(1).optional(),
  actorType: z.enum(GitHubActorType),
  newCommitCount: z.number().int().min(0).refine(Number.isSafeInteger),
  observedAt: z.date(),
});

export type BranchPushContributionInput = z.infer<
  typeof branchPushContributionInputSchema
>;

export const BranchPushContributionWriteResult = {
  Recorded: "recorded",
  Duplicate: "duplicate",
  Ignored: "ignored",
} as const;
export type BranchPushContributionWriteResult =
  (typeof BranchPushContributionWriteResult)[keyof typeof BranchPushContributionWriteResult];

/** Persist only an exact-ref, new-commit GitHub account contribution. */
export async function recordBranchPushContribution(
  input: BranchPushContributionInput
): Promise<BranchPushContributionWriteResult> {
  const parsed = branchPushContributionInputSchema.parse(input);
  if (
    parsed.newCommitCount === 0 ||
    !isPlausibleBranchPushTransition(parsed.beforeSha, parsed.afterSha) ||
    !isHumanGitHubActor(parsed.actorType)
  ) {
    return BranchPushContributionWriteResult.Ignored;
  }
  const repositoryFullName = normalizeRepoFullName(parsed.repositoryFullName);
  return await withDb.tx(async (tx) => {
    const branch = await tx.branchDetail.findFirst({
      where: {
        artifactId: parsed.branchArtifactId,
        organizationId: parsed.organizationId,
        repositoryFullName,
        branchName: parsed.refName,
        artifact: { type: ArtifactType.BRANCH },
      },
      select: { artifactId: true },
    });
    if (!branch) {
      return BranchPushContributionWriteResult.Ignored;
    }
    const written = await tx.branchPushContribution.createMany({
      data: [
        {
          organizationId: parsed.organizationId,
          branchArtifactId: parsed.branchArtifactId,
          repositoryFullName,
          refName: parsed.refName,
          beforeSha: parsed.beforeSha.toLowerCase(),
          afterSha: parsed.afterSha.toLowerCase(),
          source: parsed.source,
          sourceEventId: parsed.sourceEventId,
          providerUserId: parsed.providerUserId,
          actorType: parsed.actorType,
          observedAt: parsed.observedAt,
        },
      ],
      skipDuplicates: true,
    });
    if (written.count === 1) {
      await resolveExternalGitHubAuthorInTransaction(tx, {
        organizationId: parsed.organizationId,
        author: {
          id: parsed.providerUserId,
          login: parsed.providerLogin,
          actorType: parsed.actorType,
        },
        source: {
          sourceKind: ExternalGitHubCollaboratorSourceKind.Push,
          githubObjectId: parsed.sourceEventId,
        },
      });
    }
    return written.count === 1
      ? BranchPushContributionWriteResult.Recorded
      : BranchPushContributionWriteResult.Duplicate;
  });
}

/** A new webhook transition invalidates lifetime coverage before attribution is reconciled. */
export async function invalidateBranchPushCoverageAfterWebhook(input: {
  organizationId: string;
  branchArtifactId: string;
}): Promise<void> {
  await withDb((db) =>
    db.branchDetail.updateMany({
      where: {
        organizationId: input.organizationId,
        artifactId: input.branchArtifactId,
        artifact: { type: ArtifactType.BRANCH },
      },
      data: {
        pushCoverageAvailability: BranchIdentityAvailability.Incomplete,
        pushCoverageLastAttemptAt: null,
      },
    })
  );
}
