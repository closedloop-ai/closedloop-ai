import type { PullRequest } from "@octokit/webhooks-types";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultProvenance,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import type { TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  BranchProjectionMode,
  writeExistingBranchPullRequestProjection,
} from "@/app/branches/github-projection-writer";
import {
  type PullRequestHeadRepositoryObservation,
  persistPullRequestHeadRepositoryAuthority,
} from "@/app/branches/pull-request-head-authority";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { mapGitHubWebhookRepositoryDefaultAuthority } from "@/lib/github/repository-default-authority";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import { pullRequestState } from "./pull-request-lifecycle-decision";

/** Identifies the existing branch/PR projection targeted by a webhook. */
export type WebhookPullRequestProjectionTarget = {
  branchArtifactId: string;
  checksStatus: Parameters<
    typeof writeExistingBranchPullRequestProjection
  >[2]["checksStatus"];
  currentHeadSha: string | null;
  organizationId: string;
  pullRequestDetailId: string | null;
  repositoryId: string;
};

/** Route one existing PR through its branch or legacy detail-only authority path. */
export async function writeExistingWebhookPullRequestProjection(
  tx: TransactionClient,
  target: WebhookPullRequestProjectionTarget & { hasBranchArtifact: boolean },
  pullRequest: PullRequest,
  action: string,
  observationContext?: GitHubWebhookObservationContext
): Promise<void> {
  if (target.hasBranchArtifact) {
    await writeWebhookPullRequestProjection(
      tx,
      target,
      pullRequest,
      action,
      observationContext
    );
    return;
  }
  if (target.pullRequestDetailId) {
    await persistWebhookPullRequestAuthorityById(
      tx,
      {
        organizationId: target.organizationId,
        pullRequestDetailId: target.pullRequestDetailId,
      },
      pullRequest,
      observationContext
    );
  }
}

/**
 * Projects one provider pull-request payload onto its existing branch-owned row.
 * Repository authority is populated only when the caller supplies a validated
 * observation; legacy webhook callers preserve omission.
 */
export async function writeWebhookPullRequestProjection(
  tx: TransactionClient,
  target: WebhookPullRequestProjectionTarget,
  pullRequest: PullRequest,
  action: string,
  observationContext?: GitHubWebhookObservationContext
): Promise<void> {
  await writeExistingBranchPullRequestProjection(
    tx,
    {
      branchArtifactId: target.branchArtifactId,
      branchProjectionMode:
        action === "synchronize"
          ? BranchProjectionMode.PointerOnly
          : BranchProjectionMode.Full,
      currentHeadSha: target.currentHeadSha,
      pullRequestDetailId: target.pullRequestDetailId,
    },
    {
      organizationId: target.organizationId,
      repositoryId: target.repositoryId,
      githubId: String(pullRequest.id),
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? null,
      htmlUrl: pullRequest.html_url,
      headBranch: pullRequest.head.ref,
      baseBranch: pullRequest.base.ref,
      headSha: pullRequest.head.sha,
      prState: pullRequestState(pullRequest),
      isDraft: pullRequest.draft ?? false,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
      checksStatus: action === "synchronize" ? undefined : target.checksStatus,
      githubCreatedAt: pullRequest.created_at
        ? new Date(pullRequest.created_at)
        : null,
      closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
      mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
      mergeCommitSha: pullRequest.merge_commit_sha ?? null,
      headRepositoryObservation: buildWebhookHeadRepositoryObservation(
        pullRequest,
        observationContext
      ),
      fetchProvenance: githubAppWebhookFetchProvenance(),
    }
  );
}

/** Persist authority for a PR row created by the branch service. */
export async function persistCreatedWebhookPullRequestAuthority(
  tx: TransactionClient,
  organizationId: string,
  pullRequest: PullRequest,
  observationContext?: GitHubWebhookObservationContext
): Promise<void> {
  const createdPullRequest = await tx.pullRequestDetail.findFirst({
    where: {
      githubId: String(pullRequest.id),
      organizationId,
    },
    select: { id: true },
  });
  if (!createdPullRequest) {
    return;
  }
  await persistPullRequestHeadRepositoryAuthority(
    tx,
    { organizationId, pullRequestDetailId: createdPullRequest.id },
    buildWebhookHeadRepositoryObservation(pullRequest, observationContext),
    { name: pullRequest.head.ref, oid: pullRequest.head.sha }
  );
}

/** Persist authority for a reachable legacy PR that has no branch artifact. */
export async function persistWebhookPullRequestAuthorityById(
  tx: TransactionClient,
  scope: { organizationId: string; pullRequestDetailId: string },
  pullRequest: PullRequest,
  observationContext?: GitHubWebhookObservationContext
): Promise<void> {
  await persistPullRequestHeadRepositoryAuthority(
    tx,
    scope,
    buildWebhookHeadRepositoryObservation(pullRequest, observationContext),
    { name: pullRequest.head.ref, oid: pullRequest.head.sha }
  );
}

export function buildWebhookHeadRepositoryObservation(
  pullRequest: PullRequest,
  context: GitHubWebhookObservationContext | undefined
): PullRequestHeadRepositoryObservation | undefined {
  if (!context) {
    log.error("github_repository_default_authority_malformed", {
      outcome: "missing_delivery_id",
      providerPullRequestId: String(pullRequest.id),
      repositoryFullName: pullRequest.head.repo?.full_name ?? null,
      source: RepositoryDefaultSource.PullRequestWebhook,
    });
    return undefined;
  }
  const provenance: RepositoryDefaultProvenance = {
    source: RepositoryDefaultSource.PullRequestWebhook,
    mechanism: GitHubFetchMechanism.Webhook,
    trigger: GitHubFetchTrigger.Webhook,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey: context.deliveryId,
    observedAt: context.observedAt.toISOString(),
    ...(pullRequest.updated_at ? { eventAt: pullRequest.updated_at } : {}),
  };
  const repository = pullRequest.head.repo;
  if (!repository) {
    return {
      unavailable: {
        reason: RepositoryDefaultReason.NotReported,
        provenance,
      },
    };
  }

  const authority = mapGitHubWebhookRepositoryDefaultAuthority(
    repository,
    RepositoryDefaultSource.PullRequestWebhook,
    context,
    pullRequest.updated_at ? new Date(pullRequest.updated_at) : undefined
  );
  return authority ? { authority } : undefined;
}
