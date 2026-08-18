import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  GitHubFetchCredentialType,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubProviderResultStatus,
  type GitHubSinglePullRequestResult,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { branchService } from "@/app/branches/branch-service";
import {
  createPullRequestRestAuthorityProvenance,
  toPullRequestRestAuthorityObservation,
} from "@/app/branches/pull-request-authority-producer";
import { pullRequestHeadRepositoryObservation } from "@/app/branches/pull-request-head-authority";
import { readWithInstallationClient } from "@/lib/github/installation-client";

/** Input for provider-verified loop PR materialization. */
export type PrLinkageInput = {
  organizationId: string;
  projectId: string | null;
  documentId: string;
  prNumber: number;
  baseRepository: {
    id: string;
    fullName: string;
    installationId: string;
  };
};

/** Explicit fail-closed outcome for loop PR evidence that cannot form a Branch. */
export type PrLinkageResult =
  | { status: "linked"; branchArtifactId: string }
  | {
      status: "not_materialized";
      reason:
        | "provider_unavailable"
        | "head_authority_unavailable"
        | "branch_rejected";
    };

/**
 * Re-reads the PR from GitHub, then routes branch and PR persistence through the
 * canonical Branch service. The execution artifact remains the historical PR
 * evidence when GitHub cannot establish an eligible head repository.
 */
export async function ensurePrLinkageRecords(
  input: PrLinkageInput
): Promise<PrLinkageResult> {
  const [owner, repo] = input.baseRepository.fullName.split("/");
  if (!(owner && repo)) {
    return notMaterialized(input, "head_authority_unavailable");
  }

  const provenance = createPullRequestRestAuthorityProvenance({
    trigger: GitHubFetchTrigger.UserAction,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observedAt: new Date(),
  });
  const providerResult = await readWithInstallationClient(
    input.baseRepository.installationId,
    (octokit) =>
      getSinglePullRequestWithProviderResult(
        octokit,
        owner,
        repo,
        input.prNumber,
        toPullRequestRestAuthorityObservation(provenance)
      )
  );
  if (providerResult.status !== GitHubProviderResultStatus.Success) {
    return notMaterialized(input, "provider_unavailable");
  }

  return materializeProviderPullRequest(input, providerResult.value);
}

async function materializeProviderPullRequest(
  input: PrLinkageInput,
  pullRequest: GitHubSinglePullRequestResult
): Promise<PrLinkageResult> {
  const headObservation = pullRequestHeadRepositoryObservation(pullRequest);
  const headAuthority = headObservation?.authority;
  if (!headAuthority) {
    return notMaterialized(input, "head_authority_unavailable");
  }

  const result = await branchService.upsertBranchArtifact({
    organizationId: input.organizationId,
    repositoryId:
      normalizeRepoFullName(headAuthority.repository.fullName) ===
      normalizeRepoFullName(input.baseRepository.fullName)
        ? input.baseRepository.id
        : null,
    repositoryFullName: headAuthority.repository.fullName,
    repositoryDefaultObservation: headObservation,
    branchName: pullRequest.headBranch,
    pullRequestRepositoryId: input.baseRepository.id,
    pullRequestBaseRepositoryFullName: input.baseRepository.fullName,
    projectId: input.projectId,
    baseBranch: pullRequest.baseBranch,
    baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    headSha: pullRequest.headSha,
    headShaSource: BranchHeadShaSource.PullRequestWebhook,
    sourceArtifactId: input.documentId,
    pullRequest: {
      githubId: pullRequest.githubId,
      number: pullRequest.number,
      title: pullRequest.title,
      htmlUrl: pullRequest.htmlUrl,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changedFiles,
      githubCreatedAt: pullRequest.createdAt
        ? new Date(pullRequest.createdAt)
        : null,
      closedAt: pullRequest.closedAt ? new Date(pullRequest.closedAt) : null,
      mergedAt: pullRequest.mergedAt ? new Date(pullRequest.mergedAt) : null,
      mergeCommitSha: pullRequest.mergeCommitSha,
      headRepositoryObservation: headObservation,
    },
  });
  if (!result.ok) {
    return notMaterialized(input, "branch_rejected");
  }

  log.info("[pr-linkage] Ensured provider-verified PR linkage records", {
    documentId: input.documentId,
    prNumber: input.prNumber,
    branchArtifactId: result.value.id,
  });
  return { status: "linked", branchArtifactId: result.value.id };
}

function notMaterialized(
  input: PrLinkageInput,
  reason: Extract<PrLinkageResult, { status: "not_materialized" }>["reason"]
): PrLinkageResult {
  log.warn(
    "[pr-linkage] Preserved PR evidence without Branch materialization",
    {
      organizationId: input.organizationId,
      documentId: input.documentId,
      prNumber: input.prNumber,
      baseRepositoryFullName: input.baseRepository.fullName,
      reason,
    }
  );
  return { status: "not_materialized", reason };
}
