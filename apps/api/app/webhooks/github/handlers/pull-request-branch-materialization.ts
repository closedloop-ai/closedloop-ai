import type { PullRequest } from "@octokit/webhooks-types";
import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import { branchService } from "@/app/branches/branch-service";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import { buildWebhookHeadRepositoryObservation } from "./pull-request-projection";

type PullRequestBranchMaterializationInput = {
  organizationId: string;
  repo: { id: string; fullName: string };
  artifact: {
    id: string;
    projectId: string | null;
    createdById: string | null;
  };
  pullRequest: PullRequest;
  observationContext?: GitHubWebhookObservationContext;
};

/**
 * Materializes a webhook PR using head authority for Branch identity while the
 * verified base installation repository owns authorization and PR context.
 */
export async function materializeWebhookPullRequestBranch(
  input: PullRequestBranchMaterializationInput
): Promise<string | null> {
  const observation = buildWebhookHeadRepositoryObservation(
    input.pullRequest,
    input.observationContext
  );
  const headAuthority = observation?.authority;
  if (!headAuthority) {
    log.warn(
      "[handlePullRequest] Skipping linkage — head repository authority unavailable",
      {
        prNumber: input.pullRequest.number,
        organizationId: input.organizationId,
        githubPrId: input.pullRequest.id,
      }
    );
    return null;
  }
  const headMatchesBase =
    headAuthority.repository.providerRepositoryId ===
      String(input.pullRequest.base.repo?.id) &&
    normalizeRepoFullName(headAuthority.repository.fullName) ===
      normalizeRepoFullName(input.repo.fullName);

  const result = await branchService.upsertBranchArtifact({
    organizationId: input.organizationId,
    repositoryFullName: headAuthority.repository.fullName,
    projectId: input.artifact.projectId,
    repositoryId: headMatchesBase ? input.repo.id : null,
    pullRequestRepositoryId: input.repo.id,
    pullRequestBaseRepositoryFullName: input.repo.fullName,
    repositoryDefaultObservation: observation,
    baseBranch: input.pullRequest.base.ref,
    baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    branchName: input.pullRequest.head.ref,
    defaultBranch: input.pullRequest.base.repo?.default_branch ?? null,
    headSha: input.pullRequest.head.sha,
    headShaSource: BranchHeadShaSource.PullRequestWebhook,
    headShaObservedAt: new Date(),
    // Head observation time is ordering metadata, not PR activity evidence.
    // The centralized producer writes only action-specific provider time.
    activityAt: null,
    sourceArtifactId: input.artifact.id,
    createdById: input.artifact.createdById,
    fetchProvenance: githubAppWebhookFetchProvenance(),
    pullRequest: {
      githubId: String(input.pullRequest.id),
      number: input.pullRequest.number,
      title: input.pullRequest.title,
      body: input.pullRequest.body ?? null,
      htmlUrl: input.pullRequest.html_url,
      state: resolvePullRequestState(input.pullRequest),
      isDraft: input.pullRequest.draft ?? false,
      additions: input.pullRequest.additions,
      deletions: input.pullRequest.deletions,
      changedFiles: input.pullRequest.changed_files,
      githubCreatedAt: dateOrNull(input.pullRequest.created_at),
      closedAt: dateOrNull(input.pullRequest.closed_at),
      mergedAt: dateOrNull(input.pullRequest.merged_at),
      mergeCommitSha: input.pullRequest.merge_commit_sha ?? null,
      headRepositoryObservation: observation,
    },
  });
  if (result.ok) {
    return result.value.id;
  }
  log.warn("[handlePullRequest] Skipping linkage — branch artifact rejected", {
    prNumber: input.pullRequest.number,
    organizationId: input.organizationId,
    githubPrId: input.pullRequest.id,
    status: result.error,
  });
  return null;
}

function resolvePullRequestState(pullRequest: PullRequest): GitHubPRState {
  if (pullRequest.state !== "closed") {
    return GitHubPRState.Open;
  }
  return pullRequest.merged ? GitHubPRState.Merged : GitHubPRState.Closed;
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}
