import {
  DesktopGithubPullRequestContractVersion,
  type DesktopGithubPullRequestCreateRequest,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestMode,
  DesktopGithubPullRequestReason,
  type DesktopGithubPullRequestRequest,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  type DesktopGithubPullRequestSuccess,
  DesktopGithubPullRequestSuccessMode,
  type DesktopGithubPullRequestUpdateRequest,
} from "@repo/api/src/types/desktop-github-pull-request";
import {
  createPullRequest,
  findOpenPullRequestForHeadBranch,
  getPullRequest,
  getRepositoryDefaultBranch,
  updatePullRequest,
  verifyRepositoryBranchExists,
} from "@repo/github/pull-request-write";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { log } from "@repo/observability/log";
import { extractGitHubHttpStatus } from "@/lib/github/github-access";
import { resolveGitHubUserCredential } from "@/lib/github/github-user-credential";
import {
  credentialFailure,
  type DesktopGithubPullRequestServiceFailure,
  providerFailure,
  serviceFailure,
} from "./failure";
import { resolveLabelFields } from "./labels";

type DesktopGithubPullRequestServiceInput = {
  organizationId: string;
  userId: string;
  request: DesktopGithubPullRequestRequest;
  now: Date;
  fetch?: typeof fetch;
};

type DesktopGithubPullRequestUpdateInput = {
  organizationId: string;
  userId: string;
  pullNumber: number;
  request: DesktopGithubPullRequestUpdateRequest;
  now: Date;
  fetch?: typeof fetch;
};

type DesktopGithubPullRequestServiceResult =
  | { ok: true; value: DesktopGithubPullRequestSuccess }
  | { ok: false; error: DesktopGithubPullRequestServiceFailure };

type GithubRepository = {
  owner: string;
  repo: string;
};

const LOG_PREFIX = "[desktop/github/pull-request]";

export const desktopGithubPullRequestService = {
  async handle(
    input: DesktopGithubPullRequestServiceInput
  ): Promise<DesktopGithubPullRequestServiceResult> {
    const repository = splitRepositoryFullName(input.request.repoFullName);
    const credential = await resolveGitHubUserCredential({
      organizationId: input.organizationId,
      userId: input.userId,
      now: input.now,
      capabilityScope: {
        normalizedTargetOwner: repository.owner.toLowerCase(),
        normalizedTargetRepo: repository.repo.toLowerCase(),
      },
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    if (!credential.ok) {
      return {
        ok: false,
        error: credentialFailure(credential.denial),
      };
    }

    const octokit = getUserTokenOctokit(credential.credential.token, {
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    if (input.request.mode === DesktopGithubPullRequestMode.Preflight) {
      const headRepository = resolveHeadRepository(input.request, repository);
      return preflightPullRequest(
        octokit,
        input.request.repoFullName,
        repository,
        headRepository,
        credential.credential.login,
        input.now
      );
    }
    return createPullRequestForDesktop(
      octokit,
      repository,
      input.request,
      input.now
    );
  },

  async update(
    input: DesktopGithubPullRequestUpdateInput
  ): Promise<DesktopGithubPullRequestServiceResult> {
    const repository = splitRepositoryFullName(input.request.repoFullName);
    const credential = await resolveGitHubUserCredential({
      organizationId: input.organizationId,
      userId: input.userId,
      now: input.now,
      capabilityScope: {
        normalizedTargetOwner: repository.owner.toLowerCase(),
        normalizedTargetRepo: repository.repo.toLowerCase(),
      },
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    if (!credential.ok) {
      return {
        ok: false,
        error: credentialFailure(
          credential.denial,
          DesktopGithubPullRequestStage.ApiUpdate
        ),
      };
    }

    const octokit = getUserTokenOctokit(credential.credential.token, {
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    try {
      const pullRequest = await resolvePullRequestForUpdate(
        octokit,
        repository,
        input.pullNumber,
        input.request
      );
      const labelFields = await resolveLabelFields(
        octokit,
        repository,
        pullRequest.number,
        input.request.labels ?? []
      );
      return {
        ok: true,
        value: {
          success: true,
          contractVersion: DesktopGithubPullRequestContractVersion,
          mode: DesktopGithubPullRequestSuccessMode.Update,
          status: DesktopGithubPullRequestStatus.Updated,
          pullRequest: {
            number: pullRequest.number,
            url: pullRequest.url,
            ...(pullRequest.headBranch
              ? { headBranch: pullRequest.headBranch }
              : {}),
            ...(pullRequest.baseBranch
              ? { baseBranch: pullRequest.baseBranch }
              : {}),
          },
          ...(labelFields ? { labels: labelFields } : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: providerFailure(
          error,
          DesktopGithubPullRequestStage.ApiUpdate,
          input.now
        ),
      };
    }
  },
} as const;

function resolvePullRequestForUpdate(
  octokit: ReturnType<typeof getUserTokenOctokit>,
  repository: GithubRepository,
  pullNumber: number,
  request: DesktopGithubPullRequestUpdateRequest
) {
  if (request.title === undefined && request.body === undefined) {
    return getPullRequest(octokit, {
      ...repository,
      pullNumber,
    });
  }
  return updatePullRequest(octokit, {
    ...repository,
    pullNumber,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
}

async function preflightPullRequest(
  octokit: ReturnType<typeof getUserTokenOctokit>,
  repoFullName: string,
  repository: GithubRepository,
  headRepository: GithubRepository,
  login: string,
  now: Date
): Promise<DesktopGithubPullRequestServiceResult> {
  const defaultBranch = await resolveDefaultBranch(
    octokit,
    repository,
    undefined,
    now,
    DesktopGithubPullRequestStage.ApiPreflight
  );
  if (!defaultBranch.ok) {
    return defaultBranch;
  }
  if (!sameRepository(repository, headRepository)) {
    const headDefaultBranch = await resolveDefaultBranch(
      octokit,
      headRepository,
      undefined,
      now,
      DesktopGithubPullRequestStage.ApiPreflight
    );
    if (!headDefaultBranch.ok) {
      return headDefaultBranch;
    }
  }

  return {
    ok: true,
    value: {
      success: true,
      contractVersion: DesktopGithubPullRequestContractVersion,
      mode: DesktopGithubPullRequestSuccessMode.Preflight,
      status: DesktopGithubPullRequestStatus.Available,
      repository: {
        fullName: repoFullName,
        defaultBranch: defaultBranch.value,
      },
      identity: { login },
    },
  };
}

async function createPullRequestForDesktop(
  octokit: ReturnType<typeof getUserTokenOctokit>,
  repository: GithubRepository,
  request: DesktopGithubPullRequestCreateRequest,
  now: Date
): Promise<DesktopGithubPullRequestServiceResult> {
  const headRepository = resolveHeadRepository(request, repository);
  const defaultBranch = await resolveDefaultBranch(
    octokit,
    repository,
    request.baseBranch,
    now,
    DesktopGithubPullRequestStage.ApiCreate
  );
  if (!defaultBranch.ok) {
    return defaultBranch;
  }

  const branchExists = await verifyHeadBranch(
    octokit,
    headRepository,
    request.headBranch,
    now
  );
  if (!branchExists.ok) {
    return branchExists;
  }

  try {
    const pullRequest = await createPullRequest(octokit, {
      ...repository,
      head: pullRequestHeadRef(repository, headRepository, request.headBranch),
      base: defaultBranch.value,
      title: request.title,
      body: request.body,
    });
    const labelFields = await resolveLabelFields(
      octokit,
      repository,
      pullRequest.number,
      request.labels ?? []
    );
    return {
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Create,
        status: DesktopGithubPullRequestStatus.Created,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch ?? request.headBranch,
          baseBranch: pullRequest.baseBranch ?? defaultBranch.value,
        },
        ...(labelFields ? { labels: labelFields } : {}),
      },
    };
  } catch (error) {
    const existing = await existingPullRequestAfterCreateFailure(
      octokit,
      repository,
      headRepository,
      request,
      defaultBranch.value,
      error,
      now
    );
    if (existing) {
      return existing;
    }
    return {
      ok: false,
      error: providerFailure(
        error,
        DesktopGithubPullRequestStage.ApiCreate,
        now
      ),
    };
  }
}

async function resolveDefaultBranch(
  octokit: ReturnType<typeof getUserTokenOctokit>,
  repository: GithubRepository,
  baseBranch: string | undefined,
  now: Date,
  stage: DesktopGithubPullRequestStage
): Promise<
  | { ok: true; value: string }
  | { ok: false; error: DesktopGithubPullRequestServiceFailure }
> {
  if (baseBranch) {
    return { ok: true, value: baseBranch };
  }
  try {
    return {
      ok: true,
      value: await getRepositoryDefaultBranch(octokit, repository),
    };
  } catch (error) {
    return { ok: false, error: providerFailure(error, stage, now) };
  }
}

async function verifyHeadBranch(
  octokit: ReturnType<typeof getUserTokenOctokit>,
  repository: GithubRepository,
  headBranch: string,
  now: Date
): Promise<
  { ok: true } | { ok: false; error: DesktopGithubPullRequestServiceFailure }
> {
  try {
    const exists = await verifyRepositoryBranchExists(octokit, {
      ...repository,
      branch: headBranch,
    });
    if (exists) {
      return { ok: true };
    }
    return {
      ok: false,
      error: serviceFailure({
        status: 404,
        code: DesktopGithubPullRequestErrorCode.BranchUnavailable,
        reason: DesktopGithubPullRequestReason.BranchUnavailable,
        stage: DesktopGithubPullRequestStage.ApiCreate,
        message:
          "GitHub could not find the pushed branch for pull request creation.",
        retryable: false,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: providerFailure(
        error,
        DesktopGithubPullRequestStage.ApiCreate,
        now
      ),
    };
  }
}

async function existingPullRequestAfterCreateFailure(
  octokit: ReturnType<typeof getUserTokenOctokit>,
  repository: GithubRepository,
  headRepository: GithubRepository,
  request: DesktopGithubPullRequestCreateRequest,
  baseBranch: string,
  createError: unknown,
  now: Date
): Promise<DesktopGithubPullRequestServiceResult | null> {
  if (extractGitHubHttpStatus(createError) !== 422) {
    return null;
  }
  try {
    const existing = await findOpenPullRequestForHeadBranch(octokit, {
      ...repository,
      headOwner: headRepository.owner,
      headBranch: request.headBranch,
      ...(request.baseBranch === undefined
        ? {}
        : { baseBranch: request.baseBranch }),
    });
    if (!existing) {
      return null;
    }
    const labelFields = await resolveLabelFields(
      octokit,
      repository,
      existing.number,
      request.labels ?? []
    );
    return {
      ok: true,
      value: {
        success: true,
        contractVersion: DesktopGithubPullRequestContractVersion,
        mode: DesktopGithubPullRequestSuccessMode.Create,
        status: DesktopGithubPullRequestStatus.Existing,
        pullRequest: {
          number: existing.number,
          url: existing.url,
          headBranch: existing.headBranch ?? request.headBranch,
          baseBranch: existing.baseBranch ?? request.baseBranch ?? baseBranch,
        },
        ...(labelFields ? { labels: labelFields } : {}),
      },
    };
  } catch (lookupError) {
    log.warn(`${LOG_PREFIX} Existing PR lookup failed after create failure`, {
      owner: repository.owner,
      repo: repository.repo,
      headOwner: headRepository.owner,
      headRepo: headRepository.repo,
      status: extractGitHubHttpStatus(lookupError),
    });
    const failure = providerFailure(
      lookupError,
      DesktopGithubPullRequestStage.ApiCreate,
      now
    );
    if (failure.retryable) {
      return { ok: false, error: failure };
    }
    return null;
  }
}

function splitRepositoryFullName(fullName: string): GithubRepository {
  const [owner, repo] = fullName.split("/");
  return { owner: owner ?? "", repo: repo ?? "" };
}

function resolveHeadRepository(
  request: Pick<DesktopGithubPullRequestCreateRequest, "headRepoFullName">,
  repository: GithubRepository
): GithubRepository {
  return request.headRepoFullName
    ? splitRepositoryFullName(request.headRepoFullName)
    : repository;
}

function sameRepository(
  left: GithubRepository,
  right: GithubRepository
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function pullRequestHeadRef(
  repository: GithubRepository,
  headRepository: GithubRepository,
  headBranch: string
): string {
  return sameRepository(repository, headRepository)
    ? headBranch
    : `${headRepository.owner}:${headBranch}`;
}
