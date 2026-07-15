import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { getSinglePullRequest } from "@repo/github";
import { branchService } from "@/app/branches/branch-service";
import { loadProjectPrLinkRepositories } from "@/app/projects/repository-resolver";
import { parseGitHubPullRequestUrl } from "./pull-request-url";
import type {
  CreatePrArtifactInput,
  CreatePrArtifactResponse,
} from "./route-contract";

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
    const result = await branchService.upsertBranchArtifact({
      organizationId: input.organizationId,
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      branchName: livePullRequest.headBranch,
      baseBranch: livePullRequest.baseBranch,
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
      headSha: livePullRequest.headSha,
      headShaSource: BranchHeadShaSource.PullRequestWebhook,
      projectId: input.body.projectId,
      createdById: input.createdById,
      pullRequest: {
        githubId: livePullRequest.githubId,
        number: livePullRequest.number,
        title: livePullRequest.title,
        htmlUrl: livePullRequest.htmlUrl,
        state: livePullRequest.state,
        isDraft: livePullRequest.isDraft,
        closedAt: dateOrNull(livePullRequest.closedAt),
        mergedAt: dateOrNull(livePullRequest.mergedAt),
        mergeCommitSha: livePullRequest.mergeCommitSha,
      },
    });

    if (!result.ok) {
      return branchArtifactServiceError(result.error);
    }

    return Result.ok({ id: result.value.id });
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
      normalizeFullName(repo.fullName) === normalizeFullName(parsedUrl.fullName)
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

  const livePullRequest = await getSinglePullRequest(
    repository.installation.installationId,
    repository.owner,
    repository.name,
    input.body.number
  );
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

function normalizeFullName(value: string): string {
  return value.trim().toLowerCase();
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
