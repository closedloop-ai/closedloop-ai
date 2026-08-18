import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  GitHubFetchCredentialType,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import type {
  CreatePrArtifactInput,
  CreatePrArtifactResponse,
} from "@repo/api/src/types/pull-request-artifact-link";
import {
  emptyPullRequestLabelSyncResult,
  type PullRequestLabelSyncResult,
  PullRequestLabelSyncStatus,
} from "@repo/api/src/types/pull-request-label-sync-status";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { GitHubProviderResultStatus, getSinglePullRequest } from "@repo/github";
import { log } from "@repo/observability/log";
import { branchService } from "@/app/branches/branch-service";
import {
  createPullRequestRestAuthorityProvenance,
  toPullRequestRestAuthorityObservation,
} from "@/app/branches/pull-request-authority-producer";
import { loadProjectPrLinkRepositories } from "@/app/projects/repository-resolver";
import { acquireInstallationClient } from "@/lib/github/installation-client";
import {
  type ArtifactPullRequestLabelSyncInput,
  syncPullRequestLabelsFromArtifactTags,
} from "@/lib/github/pull-request-label-sync";
import { parseGitHubPullRequestUrl } from "./pull-request-url";

type LivePullRequest = NonNullable<
  Awaited<ReturnType<typeof getSinglePullRequest>>
>;

export type CreatePullRequestArtifactError = {
  status: StatusCode;
  message: string;
  cause?: string;
  metadata?: {
    code?: string;
    details?: JsonObject;
  };
};

export const pullRequestArtifactLinkService = {
  /**
   * Validate a browser-selected GitHub PR against the project's allowed
   * repositories and live GitHub state, then materialize it as branch-owned PR
   * detail through the branch service.
   */
  async createPullRequestArtifact(input: {
    body: CreatePrArtifactInput;
    createdById: string;
    organizationId: string;
  }): Promise<
    Result<CreatePrArtifactResponse, CreatePullRequestArtifactError>
  > {
    const project = await withDb((db) =>
      db.project.findUnique({
        where: {
          id: input.body.projectId,
          organizationId: input.organizationId,
        },
        select: { id: true, settings: true },
      })
    );
    if (!project) {
      return serviceError(Status.NotFound, "Project not found");
    }

    const allowedRepositories = await loadProjectPrLinkRepositories({
      projectId: project.id,
      organizationId: input.organizationId,
      projectSettings: (project.settings ?? {}) as JsonObject,
    });
    if (allowedRepositories.length === 0) {
      return serviceError(
        Status.BadRequest,
        "Project has no primary repository configured"
      );
    }

    const validated = await validateSelectedPullRequest({
      allowedRepositories,
      body: input.body,
      organizationId: input.organizationId,
    });
    if (!validated.ok) {
      return validated;
    }

    const { livePullRequest, repository } = validated.value;
    const headAuthority = livePullRequest.headRepository;
    if (!headAuthority) {
      return serviceError(
        Status.BadRequest,
        "Pull request head repository authority is unavailable",
        { code: "pull_request_head_repository_unavailable" }
      );
    }
    const headMatchesBase =
      headAuthority.repository.providerRepositoryId ===
        repository.githubRepoId &&
      normalizeRepoFullName(headAuthority.repository.fullName) ===
        normalizeRepoFullName(repository.fullName);
    const result = await branchService.upsertBranchArtifact({
      organizationId: input.organizationId,
      repositoryId: headMatchesBase ? repository.id : null,
      repositoryFullName: headAuthority.repository.fullName,
      branchName: livePullRequest.headBranch,
      repositoryDefaultObservation: { authority: headAuthority },
      pullRequestRepositoryId: repository.id,
      pullRequestBaseRepositoryFullName: repository.fullName,
      baseBranch: livePullRequest.baseBranch,
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      headSha: livePullRequest.headSha,
      headShaSource: BranchHeadShaSource.PullRequestWebhook,
      projectId: input.body.projectId,
      createdById: input.createdById,
      // ISS-4759: the PRODUCES link is written INSIDE this transaction, by the
      // path that already validates the owner (org + project + DOCUMENT +
      // allowed subtype + repo-snapshot scope). Previously the branch upsert
      // ran without it and the client wrote the link in a SECOND request, so a
      // failure there left GitHub labelled against no committed relationship.
      sourceArtifactId: input.body.linkSourceArtifactId ?? null,
      pullRequest: {
        githubId: livePullRequest.githubId,
        number: livePullRequest.number,
        title: livePullRequest.title,
        htmlUrl: livePullRequest.htmlUrl,
        state: livePullRequest.state,
        isDraft: livePullRequest.isDraft,
        // FEA-3552: GitHub PR createdAt — anchors the rail's "PR opened" dot.
        githubCreatedAt: dateOrNull(livePullRequest.createdAt),
        closedAt: dateOrNull(livePullRequest.closedAt),
        mergedAt: dateOrNull(livePullRequest.mergedAt),
        mergeCommitSha: livePullRequest.mergeCommitSha,
        headRepositoryObservation: { authority: headAuthority },
      },
    });

    if (!result.ok) {
      return branchArtifactServiceError(result.error);
    }

    // ISS-4664: the PR now implements `sourceArtifactId`, so carry that
    // artifact's tags onto the PR as GitHub labels AT LINK TIME — the same
    // reconciliation the `pull_request` webhook runs, invoked here so a link
    // does not have to wait for a later edit/reopen to pick the tags up.
    //
    // ISS-4759: strictly AFTER the branch transaction committed above. The
    // early return on `!result.ok` is what guarantees a rolled-back link never
    // reaches GitHub, and the tag source itself is validated inside the sync.
    //
    // Awaited (never fire-and-forget in a serverless route) but non-fatal:
    // the branch artifact is already committed above, so a GitHub or tag-read
    // failure must not turn a successful link into a 5xx. The helper swallows
    // its own failures; this guard is the structural one, so the contract holds
    // even if that internal handling ever regresses.
    const labelSync = input.body.sourceArtifactId
      ? await syncLabelsBestEffort({
          organizationId: input.organizationId,
          projectId: input.body.projectId,
          artifactId: input.body.sourceArtifactId,
          installationId: repository.installationId,
          owner: repository.owner,
          repo: repository.name,
          repositoryFullName: repository.fullName,
          pullNumber: input.body.number,
        })
      : undefined;

    return Result.ok({
      id: result.value.id,
      // ISS-4764: report what actually happened to the labels. Omitted (never
      // `null`) when propagation was not requested, so an older client sees the
      // exact previous response shape.
      ...(labelSync ? { labelSync } : {}),
      // ISS-4759: echo the link owner ONLY when this request wrote the link, so
      // a newer client can tell whether it still has to write one itself.
      ...(input.body.linkSourceArtifactId
        ? { linkedSourceArtifactId: input.body.linkSourceArtifactId }
        : {}),
    });
  },
};

async function validateSelectedPullRequest(input: {
  allowedRepositories: Array<{
    installationRepositoryId: string;
    fullName: string;
  }>;
  body: CreatePrArtifactInput;
  organizationId: string;
}): Promise<
  Result<
    {
      repository: {
        id: string;
        githubRepoId: string;
        fullName: string;
        owner: string;
        name: string;
        installationId: string;
      };
      livePullRequest: LivePullRequest;
    },
    CreatePullRequestArtifactError
  >
> {
  const parsedUrl = parseGitHubPullRequestUrl(input.body.externalUrl);
  if (!parsedUrl) {
    return serviceError(Status.BadRequest, "Pull request URL is invalid");
  }
  if (parsedUrl.number !== input.body.number) {
    return serviceError(
      Status.BadRequest,
      "Pull request URL number does not match"
    );
  }

  const allowed = input.allowedRepositories.find(
    (repo) =>
      normalizeRepoFullName(repo.fullName) ===
      normalizeRepoFullName(parsedUrl.fullName)
  );
  if (!allowed) {
    return serviceError(Status.NotFound, "Pull request repository not found");
  }

  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        id: allowed.installationRepositoryId,
        fullName: allowed.fullName,
        removedAt: null,
        installation: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        owner: true,
        name: true,
        installation: { select: { installationId: true } },
      },
    })
  );
  if (!repository?.installation.installationId) {
    return serviceError(Status.NotFound, "Pull request repository not found");
  }

  // The read itself resolves null on failure; a failed client acquisition
  // folds into the same null so the service returns its typed BadRequest
  // instead of rejecting.
  const acquired = await acquireInstallationClient(
    repository.installation.installationId
  );
  const authorityProvenance = createPullRequestRestAuthorityProvenance({
    trigger: GitHubFetchTrigger.UserAction,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observedAt: new Date(),
  });
  const livePullRequest =
    acquired.status === GitHubProviderResultStatus.Success
      ? await getSinglePullRequest(
          acquired.value,
          repository.owner,
          repository.name,
          input.body.number,
          toPullRequestRestAuthorityObservation(authorityProvenance)
        )
      : null;
  if (!livePullRequest) {
    return serviceError(
      Status.BadRequest,
      "Pull request head SHA could not be resolved",
      { code: "pull_request_head_unavailable" }
    );
  }

  const mismatch = findAssertionMismatch(input.body, livePullRequest);
  if (mismatch) {
    return serviceError(
      Status.BadRequest,
      "Pull request assertions did not match",
      {
        code: "pull_request_assertion_mismatch",
        details: { field: mismatch },
      }
    );
  }

  return Result.ok({
    repository: {
      id: repository.id,
      githubRepoId: repository.githubRepoId,
      fullName: repository.fullName,
      owner: repository.owner,
      name: repository.name,
      installationId: repository.installation.installationId,
    },
    livePullRequest,
  });
}

function branchArtifactServiceError(
  status: StatusCode
): Result<CreatePrArtifactResponse, CreatePullRequestArtifactError> {
  switch (status) {
    case Status.BadRequest:
      return serviceError(status, "Pull request artifact input is invalid");
    case Status.Forbidden:
      return serviceError(status, "Forbidden", {
        code: "branch_artifact_forbidden",
      });
    case Status.Conflict:
      return serviceError(
        status,
        "Pull request artifact conflicts with current branch state"
      );
    case Status.NotFound:
      return serviceError(status, "Branch artifact not found");
    default:
      return serviceError(
        Status.Error,
        "Failed to create pull request artifact",
        undefined,
        `Branch artifact service returned ${status}`
      );
  }
}

export function findAssertionMismatch(
  body: CreatePrArtifactInput,
  livePullRequest: LivePullRequest
): string | null {
  const requiredAssertions: [string, unknown, unknown][] = [
    ["githubId", body.githubId, livePullRequest.githubId],
    ["number", body.number, livePullRequest.number],
    ["state", body.state, livePullRequest.state],
  ];
  for (const [field, expected, actual] of requiredAssertions) {
    if (expected !== actual) {
      return field;
    }
  }

  const optionalAssertions: [string, unknown, unknown][] = [
    ["headSha", body.headSha, livePullRequest.headSha],
    ["isDraft", body.isDraft, livePullRequest.isDraft],
    [
      "closedAt",
      normalizeIsoOrNull(body.closedAt),
      normalizeIsoOrNull(livePullRequest.closedAt),
    ],
    [
      "mergedAt",
      normalizeIsoOrNull(body.mergedAt),
      normalizeIsoOrNull(livePullRequest.mergedAt),
    ],
    ["mergeCommitSha", body.mergeCommitSha, livePullRequest.mergeCommitSha],
  ];
  for (const [field, expected, actual] of optionalAssertions) {
    if (expected !== undefined && expected !== actual) {
      return field;
    }
  }
  return null;
}

function normalizeIsoOrNull(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : value;
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function serviceError<T>(
  status: StatusCode,
  message: string,
  metadata?: CreatePullRequestArtifactError["metadata"],
  cause?: string
): Result<T, CreatePullRequestArtifactError> {
  return Result.err({ status, message, metadata, cause });
}

/**
 * Run the label sync without ever letting it fail an already-committed link.
 * Returns a `Failed` result instead of throwing, so the response can always say
 * something truthful about the labels rather than omitting the field and
 * letting the dialog guess.
 */
async function syncLabelsBestEffort(
  input: ArtifactPullRequestLabelSyncInput & { repositoryFullName: string }
): Promise<PullRequestLabelSyncResult> {
  try {
    return await syncPullRequestLabelsFromArtifactTags(input);
  } catch (error) {
    log.warn(
      "[pullRequestArtifactLink] Label propagation failed for linked PR",
      {
        artifactId: input.artifactId,
        repositoryFullName: input.repositoryFullName,
        pullNumber: input.pullNumber,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.Failed);
  }
}
