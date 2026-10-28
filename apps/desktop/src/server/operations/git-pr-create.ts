import {
  DesktopGithubPullRequestApiPath,
  DesktopGithubPullRequestContractVersion,
  type DesktopGithubPullRequestCreateRequest,
  DesktopGithubPullRequestErrorCode,
  type DesktopGithubPullRequestFailure,
  DesktopGithubPullRequestMode,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  type DesktopGithubPullRequestSuccess,
  DesktopGithubPullRequestSuccessMode,
  desktopGithubPullRequestCreateRequestSchema,
} from "@repo/api/src/types/desktop-github-pull-request";
import {
  type PullRequestLabelMapping,
  type PullRequestLabelSpec,
  parsePullRequestLabelSpecList,
} from "@repo/api/src/types/pull-request-label";
import {
  gatewayLog,
  isNetworkError,
} from "../../main/logging/gateway-logger.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import { DirectoryNotAllowedError } from "../security.js";
import { getResolvedGitPathAsync } from "./binary-path-overrides.js";
import { GIT_GATEWAY_EXEC_TIMEOUT_MS } from "./git-gateway-constants.js";
import {
  callGitPullRequestApi,
  type GitPullRequestApiFailure,
  type GitPullRequestApiOptions,
} from "./git-pr-api-client.js";
import { asString, getRemoteRepoSlugs, run, runRead } from "./git-pr-exec.js";
import { isProcessTimeout, isPushAuthFailure } from "./git-process-failure.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { assertRepoAllowed } from "./symphony-utils.js";

export function registerGitPrCreateRoute(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  apiOptions: GitPrCreateOptions = {}
): void {
  dispatcher.register(
    "POST",
    DesktopGithubPullRequestApiPath.LegacyGatewayPullRequest,
    async (context) => {
      const request = resolveCreateRequest(context, getAllowedDirectories);
      if (!request.ok) {
        json(context, request.status, { error: request.error });
        return;
      }

      const result = await createPullRequest(request.value, apiOptions);
      json(context, result.status, result.body);
    }
  );
}

type CreateRequestContext = {
  cwd: string;
  title: string;
  fullBody: string;
  labels: PullRequestLabelSpec[];
  droppedLabels: string[];
};

type CreatePullRequestResult = {
  status: number;
  body: LegacyGatewayPullRequestSuccess | DesktopGithubPullRequestFailure;
};

type LegacyGatewayPullRequestSuccess = {
  success: true;
  url: string;
  number: number;
  message: string;
  labelsApplied?: boolean;
  appliedLabels?: string[];
  droppedLabels?: string[];
  unappliedLabels?: string[];
};

type DesktopGithubPullRequestCreateSuccess = Extract<
  DesktopGithubPullRequestSuccess,
  { mode: typeof DesktopGithubPullRequestSuccessMode.Create }
>;

type ResolvedCreateRequest =
  | { ok: true; value: CreateRequestContext }
  | { ok: false; status: number; error: string };

type LocalCreateContext = {
  currentBranch: string;
  createRequest: DesktopGithubPullRequestCreateRequest;
};

type GitPrCreateOptions = GitPullRequestApiOptions & {
  gitPushTimeoutMs?: number;
};

type ResolvedLocalCreateContext =
  | { ok: true; value: LocalCreateContext }
  | { ok: false; error: GitPullRequestApiFailure };

function resolveCreateRequest(
  context: OperationRequestContext,
  getAllowedDirectories: () => string[]
): ResolvedCreateRequest {
  const body = parseBody(context);
  if (!body) {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }

  const repoPath = asString(body.repoPath);
  if (!repoPath) {
    return { ok: false, status: 400, error: "repoPath is required" };
  }
  const title = asString(body.title);
  if (!title) {
    return { ok: false, status: 400, error: "title is required" };
  }

  let cwd: string;
  try {
    cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      return { ok: false, status: 403, error: "directory not allowed" };
    }
    throw error;
  }

  const description = asString(body.body) ?? "";
  const ticketUrl = asString(body.ticketUrl);
  const requested = parseRequestedLabels(body.labels);
  return {
    ok: true,
    value: {
      cwd,
      title,
      fullBody: ticketUrl
        ? `${description}\n\n---\nLinear: ${ticketUrl}`.trim()
        : description,
      labels: requested.labels,
      droppedLabels: requested.droppedTagNames,
    },
  };
}

async function createPullRequest(
  request: CreateRequestContext,
  apiOptions: GitPrCreateOptions
): Promise<CreatePullRequestResult> {
  const local = await resolveLocalCreateContext(request);
  if (!local.ok) {
    return { status: local.error.status, body: omitStatus(local.error) };
  }

  const preflight = await callGitPullRequestApi(
    apiOptions,
    {
      contractVersion: DesktopGithubPullRequestContractVersion,
      mode: DesktopGithubPullRequestMode.Preflight,
      repoFullName: local.value.createRequest.repoFullName,
      ...headRepoField(local.value.createRequest),
    },
    DesktopGithubPullRequestStage.ApiPreflight
  );
  if (!preflight.ok) {
    return {
      status: preflight.error.status,
      body: omitStatus(preflight.error),
    };
  }

  try {
    await run(
      request.cwd,
      await getResolvedGitPathAsync(),
      ["push", "-u", "origin", local.value.currentBranch],
      {
        timeoutMs: apiOptions.gitPushTimeoutMs ?? GIT_GATEWAY_EXEC_TIMEOUT_MS,
      }
    );
  } catch (error) {
    const failure = gitPushFailure(error);
    return { status: failure.status, body: omitStatus(failure) };
  }

  const created = await callGitPullRequestApi(
    apiOptions,
    local.value.createRequest,
    DesktopGithubPullRequestStage.ApiCreate
  );
  if (!created.ok) {
    return { status: created.error.status, body: omitStatus(created.error) };
  }
  if (created.value.mode !== DesktopGithubPullRequestSuccessMode.Create) {
    const failure = buildLocalFailure({
      status: 503,
      code: DesktopGithubPullRequestErrorCode.ApiIncompatible,
      reason: DesktopGithubPullRequestReason.ApiIncompatible,
      stage: DesktopGithubPullRequestStage.ApiCreate,
      error: "Desktop pull request API returned a non-create success response.",
      retryable: false,
    });
    return { status: failure.status, body: omitStatus(failure) };
  }
  return {
    status: 200,
    body: legacyGatewaySuccess(created.value, request.droppedLabels),
  };
}

async function resolveLocalCreateContext(
  request: CreateRequestContext
): Promise<ResolvedLocalCreateContext> {
  let currentBranch: string;
  try {
    currentBranch = await runRead(
      request.cwd,
      await getResolvedGitPathAsync(),
      ["rev-parse", "--abbrev-ref", "HEAD"]
    );
  } catch {
    return {
      ok: false,
      error: buildLocalFailure({
        status: 400,
        code: DesktopGithubPullRequestErrorCode.RepositoryUnavailable,
        reason: DesktopGithubPullRequestReason.RepositoryUnavailable,
        stage: DesktopGithubPullRequestStage.LocalPreflight,
        error:
          "Unable to read the current git branch before pull request creation.",
        retryable: false,
      }),
    };
  }

  const repos = await getRemoteRepoSlugs(request.cwd);
  if (!(repos.fetchRepoFullName && repos.pushRepoFullName)) {
    return {
      ok: false,
      error: buildLocalFailure({
        status: 400,
        code: DesktopGithubPullRequestErrorCode.RepositoryUnavailable,
        reason: DesktopGithubPullRequestReason.RepositoryUnavailable,
        stage: DesktopGithubPullRequestStage.LocalPreflight,
        error: "GitHub origin remote is required for pull request creation.",
        retryable: false,
      }),
    };
  }

  const createRequest = desktopGithubPullRequestCreateRequestSchema.safeParse({
    contractVersion: DesktopGithubPullRequestContractVersion,
    mode: DesktopGithubPullRequestMode.Create,
    repoFullName: repos.fetchRepoFullName,
    ...headRepoField({
      repoFullName: repos.fetchRepoFullName,
      headRepoFullName: repos.pushRepoFullName,
    }),
    headBranch: currentBranch,
    title: request.title,
    body: request.fullBody,
    ...(request.labels.length > 0 ? { labels: request.labels } : {}),
  });
  if (!createRequest.success) {
    return {
      ok: false,
      error: buildLocalFailure({
        status: 400,
        code: DesktopGithubPullRequestErrorCode.ValidationFailed,
        reason: DesktopGithubPullRequestReason.ValidationFailed,
        stage: DesktopGithubPullRequestStage.LocalPreflight,
        error: "Invalid pull request create payload.",
        retryable: false,
      }),
    };
  }

  return {
    ok: true,
    value: {
      currentBranch: createRequest.data.headBranch,
      createRequest: createRequest.data,
    },
  };
}

export function parseRequestedLabels(value: unknown): PullRequestLabelMapping {
  if (value === undefined || value === null) {
    return { labels: [], droppedTagNames: [], rejectedCount: 0 };
  }
  const mapping = parsePullRequestLabelSpecList(value);
  if (mapping.rejectedCount > 0) {
    gatewayLog.warn(
      GATEWAY_LOG_TAG,
      `Skipped ${mapping.rejectedCount} malformed PR label(s); applying ${mapping.labels.length}`
    );
  }
  return mapping;
}

function gitPushFailure(error: unknown): GitPullRequestApiFailure {
  const stderr = errorStderr(error);
  const normalizedStderr = stderr.toLowerCase();
  const denied = isPushAuthFailure(stderr);
  const notRepository = normalizedStderr.includes("not a git repository");
  const timeout = isProcessTimeout(error);
  const network = timeout || isNetworkError(stderr);
  const failureMessage = pushFailureMessage({
    network,
    notRepository,
    timeout,
  });
  return buildLocalFailure({
    status: denied ? 403 : 500,
    code: denied
      ? DesktopGithubPullRequestErrorCode.AuthorizationDenied
      : pushFailureCode({ network, notRepository }),
    reason: denied
      ? DesktopGithubPullRequestReason.AuthorizationDenied
      : pushFailureReason({ network, notRepository }),
    stage: DesktopGithubPullRequestStage.GitPush,
    error: failureMessage,
    retryable: network,
  });
}

function errorStderr(error: unknown): string {
  if (!(error && typeof error === "object")) {
    return "";
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : "";
}

function pushFailureCode(input: {
  network: boolean;
  notRepository: boolean;
}): DesktopGithubPullRequestErrorCode {
  if (input.network) {
    return DesktopGithubPullRequestErrorCode.TransientUnavailable;
  }
  if (input.notRepository) {
    return DesktopGithubPullRequestErrorCode.RepositoryUnavailable;
  }
  return DesktopGithubPullRequestErrorCode.ProviderRejected;
}

function pushFailureReason(input: {
  network: boolean;
  notRepository: boolean;
}): DesktopGithubPullRequestReason {
  if (input.network) {
    return DesktopGithubPullRequestReason.TransientUnavailable;
  }
  if (input.notRepository) {
    return DesktopGithubPullRequestReason.RepositoryUnavailable;
  }
  return DesktopGithubPullRequestReason.ProviderRejected;
}

function pushFailureMessage(input: {
  network: boolean;
  notRepository: boolean;
  timeout: boolean;
}): string {
  if (input.notRepository) {
    return "Not a git repository.";
  }
  if (input.timeout) {
    return "Timed out while pushing the current branch.";
  }
  if (input.network) {
    return "Network error while pushing the current branch.";
  }
  return "Failed to push the current branch before pull request creation.";
}

function buildLocalFailure(input: {
  status: number;
  code: DesktopGithubPullRequestErrorCode;
  reason: DesktopGithubPullRequestReason;
  stage: DesktopGithubPullRequestStage;
  error: string;
  retryable: boolean;
}): GitPullRequestApiFailure {
  return {
    success: false,
    error: input.error,
    code: input.code,
    reason: input.reason,
    stage: input.stage,
    retryable: input.retryable,
    burnRetryBudget: false,
    status: input.status,
  };
}

function legacyGatewaySuccess(
  success: DesktopGithubPullRequestCreateSuccess,
  droppedLabels: readonly string[]
): LegacyGatewayPullRequestSuccess {
  const labels = success.labels;
  const dropped = [...(labels?.droppedLabels ?? []), ...droppedLabels];
  return {
    success: true,
    url: success.pullRequest.url,
    number: success.pullRequest.number,
    message:
      success.status === DesktopGithubPullRequestStatus.Existing
        ? `PR #${success.pullRequest.number} already exists`
        : `Created PR #${success.pullRequest.number}`,
    ...(labels?.labelsApplied === undefined
      ? {}
      : { labelsApplied: labels.labelsApplied }),
    ...(labels?.appliedLabels === undefined
      ? {}
      : { appliedLabels: labels.appliedLabels }),
    ...(dropped.length > 0 ? { droppedLabels: dropped } : {}),
    ...(labels?.unappliedLabels === undefined
      ? {}
      : { unappliedLabels: labels.unappliedLabels }),
  };
}

function omitStatus(
  failure: GitPullRequestApiFailure
): DesktopGithubPullRequestFailure {
  const { status: _status, ...body } = failure;
  return body;
}

function headRepoField(input: {
  repoFullName: string;
  headRepoFullName?: string;
}): Pick<DesktopGithubPullRequestCreateRequest, "headRepoFullName"> {
  return input.headRepoFullName && input.headRepoFullName !== input.repoFullName
    ? { headRepoFullName: input.headRepoFullName }
    : {};
}

const GATEWAY_LOG_TAG = "git-pr-create";
