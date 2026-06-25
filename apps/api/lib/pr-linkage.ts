import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  ArtifactType,
  GitHubInstallationStatus,
  GitHubPRState,
  type TransactionClient,
} from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Input for creating or deduplicating branch linkage records from PR data.
 * Used by both the workflow-completion handler and the loop execute handler
 * to ensure idempotent branch artifact + ArtifactLink creation.
 */
type PrLinkageInput = {
  organizationId: string;
  projectId: string | null;
  documentId: string;
  prUrl: string;
  prTitle: string;
  prNumber: number;
  githubId: string;
  headBranch: string;
  baseBranch: string;
  commitSha: string | null;
};

const PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/;

/**
 * Resolve the `github_installation_repositories.id` for the repo encoded in
 * `prUrl`, scoped to `organizationId`. Returns null when no active
 * installation covers that repo.
 */
async function resolveRepositoryId(
  tx: TransactionClient,
  prUrl: string,
  organizationId: string
): Promise<{ id: string; fullName: string } | null> {
  const match = PR_URL_REGEX.exec(prUrl);
  if (!match) {
    return null;
  }
  const [, owner, repo] = match;
  const fullName = `${owner}/${repo}`;
  const row = await tx.gitHubInstallationRepository.findFirst({
    where: {
      fullName,
      installation: {
        organizationId,
        status: GitHubInstallationStatus.ACTIVE,
      },
    },
    select: { id: true, fullName: true },
  });
  return row ?? null;
}

/**
 * Create branch artifact (+ current PullRequestDetail) and ArtifactLink records
 * for PR output, deduplicating against records that may already exist from a racing
 * handler.
 *
 * Two code paths can create these records for the same PR:
 * - loop execute handler (ingestExecutionArtifacts)
 * - pull-request webhook handler (createLinkageRecords)
 *
 * This function checks for existing records before creating.
 */
export async function ensurePrLinkageRecords(
  tx: TransactionClient,
  input: PrLinkageInput
): Promise<void> {
  // Dedup by githubId (unique on PullRequestDetail).
  const existingDetail = await tx.pullRequestDetail.findUnique({
    where: { githubId: input.githubId },
    select: { artifactId: true, branchArtifactId: true },
  });

  let branchArtifactId: string;

  if (existingDetail) {
    const existingArtifactId =
      existingDetail.branchArtifactId ?? existingDetail.artifactId;
    if (!existingArtifactId) {
      log.warn("[pr-linkage] Existing PR detail has no linkable artifact", {
        githubId: input.githubId,
        prNumber: input.prNumber,
      });
      return;
    }
    branchArtifactId = existingArtifactId;
  } else {
    // Resolve repositoryId from PR URL + org. PullRequestDetail.repositoryId
    // is required, so if we can't resolve it we skip artifact creation and
    // rely on the pr-read-repair / webhook paths to backfill later.
    const repository = await resolveRepositoryId(
      tx,
      input.prUrl,
      input.organizationId
    );
    if (!repository) {
      log.warn(
        "[pr-linkage] Skipping branch artifact creation — no active installation for repo",
        {
          organizationId: input.organizationId,
          prUrl: input.prUrl,
          prNumber: input.prNumber,
          githubId: input.githubId,
        }
      );
      return;
    }

    const created = await tx.artifact.create({
      data: {
        type: ArtifactType.BRANCH,
        organizationId: input.organizationId,
        projectId: input.projectId,
        name: input.headBranch,
        status: GitHubPRState.OPEN,
        externalUrl: `https://github.com/${repository.fullName}/tree/${encodeURIComponent(input.headBranch)}`,
        branch: {
          create: {
            repositoryId: repository.id,
            branchName: input.headBranch,
            baseBranch: input.baseBranch,
            baseBranchSource: BranchBaseBranchSource.PullRequestBase,
            headSha: input.commitSha,
            headShaSource: input.commitSha
              ? BranchHeadShaSource.PullRequestWebhook
              : null,
          },
        },
        pullRequestDetails: {
          create: {
            repositoryId: repository.id,
            githubId: input.githubId,
            number: input.prNumber,
            title: input.prTitle,
            htmlUrl: input.prUrl,
            prState: GitHubPRState.OPEN,
            isCurrent: true,
          },
        },
      },
      select: { id: true, pullRequestDetails: { select: { id: true } } },
    });
    branchArtifactId = created.id;
    const currentDetailId = created.pullRequestDetails[0]?.id ?? null;
    if (currentDetailId) {
      await tx.branchDetail.update({
        where: { artifactId: branchArtifactId },
        data: { currentPullRequestDetailId: currentDetailId },
      });
    }
  }

  // Dedup ArtifactLink: source artifact → PRODUCES → branch artifact.
  const existingLink = await tx.artifactLink.findFirst({
    where: {
      organizationId: input.organizationId,
      sourceId: input.documentId,
      targetId: branchArtifactId,
      linkType: LinkType.Produces,
    },
    select: { id: true },
  });

  if (!existingLink) {
    await tx.artifactLink.create({
      data: {
        organizationId: input.organizationId,
        sourceId: input.documentId,
        targetId: branchArtifactId,
        linkType: LinkType.Produces,
      },
    });
  }

  log.info("[pr-linkage] Ensured PR linkage records", {
    documentId: input.documentId,
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    branchArtifactId,
  });
}
