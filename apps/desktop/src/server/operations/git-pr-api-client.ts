import {
  DesktopGithubPullRequestApiPath,
  DesktopGithubPullRequestApiTimeoutMs,
  DesktopGithubPullRequestErrorCode,
  type DesktopGithubPullRequestFailure,
  DesktopGithubPullRequestReason,
  type DesktopGithubPullRequestRequest,
  DesktopGithubPullRequestStage,
  type DesktopGithubPullRequestSuccess,
  DesktopGithubPullRequestSuccessMode,
  desktopGithubPullRequestResponseSchema,
} from "@repo/api/src/types/desktop-github-pull-request";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import {
  asRecord,
  postSessionJson,
  type SessionFetchOptions,
  type SessionPostOutcome,
  unwrapApiEnvelope,
} from "../../main/util/api-response-utils.js";

export type GitPullRequestApiOptions = {
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
  invalidateAccessToken?: (rejectedToken: string) => void;
  getApiOrigin?: () => string | undefined;
};

export type DesktopGatewayGitPullRequestSessionAccess = {
  getAccessToken: () => Promise<string | null>;
  invalidateAccessToken: (rejectedToken?: string) => void;
};

export type GitPullRequestApiFailure = DesktopGithubPullRequestFailure & {
  status: number;
};

export type GitPullRequestApiResult =
  | { ok: true; value: DesktopGithubPullRequestSuccess }
  | { ok: false; error: GitPullRequestApiFailure };

const GATEWAY_LOG_TAG = "git-pr-create";
const API_INCOMPATIBLE_STATUSES = new Set([404, 405, 410, 501]);
const SERVER_ERROR_STATUS_MIN = 500;
const STATUS_TOO_MANY_REQUESTS = 429;

export function callGitPullRequestApi(
  options: GitPullRequestApiOptions,
  request: DesktopGithubPullRequestRequest,
  stage: DesktopGithubPullRequestStage
): Promise<GitPullRequestApiResult> {
  return sendGitPullRequestApi(
    options,
    (sessionOptions) =>
      postSessionJson(
        sessionOptions,
        DesktopGithubPullRequestApiPath.PullRequest,
        request,
        { timeoutMs: DesktopGithubPullRequestApiTimeoutMs }
      ),
    stage
  );
}

type ClassifiedApiResponse =
  | {
      ok: true;
      value: DesktopGithubPullRequestSuccess;
      firstPartyFailure: false;
    }
  | {
      ok: false;
      error: GitPullRequestApiFailure;
      firstPartyFailure: boolean;
    };

async function classifyApiResponse(
  response: Response,
  stage: DesktopGithubPullRequestStage
): Promise<ClassifiedApiResponse> {
  const body = await readJsonBody(response);
  if (!body.ok && body.reason === "read_error") {
    return {
      ok: false,
      error: transientUnavailableFailure(stage),
      firstPartyFailure: false,
    };
  }
  if (!body.ok) {
    if (API_INCOMPATIBLE_STATUSES.has(response.status)) {
      return {
        ok: false,
        error: apiIncompatibleFailure(stage),
        firstPartyFailure: false,
      };
    }
    return response.status >= SERVER_ERROR_STATUS_MIN
      ? {
          ok: false,
          error: transientUnavailableFailure(stage),
          firstPartyFailure: false,
        }
      : {
          ok: false,
          error: apiIncompatibleFailure(stage),
          firstPartyFailure: false,
        };
  }

  if (response.ok) {
    const parsed = parseSuccessfulApiBody(body.value, stage);
    return { ...parsed, firstPartyFailure: false };
  }

  const firstPartyResponse = isFirstPartyFailureBody(body.value);
  const firstParty = firstPartyFailure(body.value, response.status, stage);
  if (firstParty) {
    return { ok: false, error: firstParty, firstPartyFailure: true };
  }
  if (API_INCOMPATIBLE_STATUSES.has(response.status)) {
    return {
      ok: false,
      error: apiIncompatibleFailure(stage),
      firstPartyFailure: firstPartyResponse,
    };
  }
  return {
    ok: false,
    error: statusFailure(response.status, stage),
    firstPartyFailure: firstPartyResponse,
  };
}

function parseSuccessfulApiBody(
  body: unknown,
  stage: DesktopGithubPullRequestStage
): GitPullRequestApiResult {
  const parsed = desktopGithubPullRequestResponseSchema.safeParse(
    unwrapApiEnvelope(body)
  );
  if (!parsed.success) {
    return { ok: false, error: apiIncompatibleFailure(stage) };
  }
  if (!parsed.data.success) {
    return { ok: false, error: { ...parsed.data, status: 500 } };
  }
  if (
    stage === DesktopGithubPullRequestStage.ApiPreflight &&
    parsed.data.mode !== DesktopGithubPullRequestSuccessMode.Preflight
  ) {
    return { ok: false, error: apiIncompatibleFailure(stage) };
  }
  if (
    stage === DesktopGithubPullRequestStage.ApiCreate &&
    parsed.data.mode !== DesktopGithubPullRequestSuccessMode.Create
  ) {
    return { ok: false, error: apiIncompatibleFailure(stage) };
  }
  if (
    stage === DesktopGithubPullRequestStage.ApiCreate &&
    !(
      "pullRequest" in parsed.data &&
      parsed.data.pullRequest.number &&
      parsed.data.pullRequest.url
    )
  ) {
    return { ok: false, error: apiIncompatibleFailure(stage) };
  }
  return { ok: true, value: parsed.data };
}

function firstPartyFailure(
  body: unknown,
  status: number,
  stage: DesktopGithubPullRequestStage
): GitPullRequestApiFailure | null {
  const record = asRecord(body);
  if (record.success !== false) {
    return null;
  }
  const details = asRecord(record.details);
  const code = knownErrorCode(record.code);
  const reason = knownReason(details.reason);
  const responseStage = knownStage(details.stage) ?? stage;
  const denial = knownDenial(details.denial);
  const retryable = booleanField(details.retryable);
  const burnRetryBudget = booleanField(details.burnRetryBudget) ?? false;
  if (!(code && reason && retryable !== null)) {
    return null;
  }
  return {
    success: false,
    error: typeof record.error === "string" ? record.error : "Request failed",
    code,
    reason,
    ...(denial === null ? {} : { denial }),
    stage: responseStage,
    retryable,
    burnRetryBudget,
    status,
  };
}

function isFirstPartyFailureBody(body: unknown): boolean {
  const record = asRecord(body);
  return record.success === false && knownErrorCode(record.code) !== null;
}

function statusFailure(
  status: number,
  stage: DesktopGithubPullRequestStage
): GitPullRequestApiFailure {
  if (status === 401) {
    return buildFailure({
      status,
      code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
      reason: DesktopGithubPullRequestReason.AuthenticationRequired,
      stage,
      error: "Desktop session authentication is required.",
      retryable: false,
    });
  }
  if (status === 403) {
    return buildFailure({
      status,
      code: DesktopGithubPullRequestErrorCode.AuthorizationDenied,
      reason: DesktopGithubPullRequestReason.AuthorizationDenied,
      stage,
      error: "Desktop GitHub pull request operation is not authorized.",
      retryable: false,
    });
  }
  if (status === STATUS_TOO_MANY_REQUESTS) {
    return buildFailure({
      status,
      code: DesktopGithubPullRequestErrorCode.ProviderRateLimited,
      reason: DesktopGithubPullRequestReason.ProviderRateLimited,
      stage,
      error: "GitHub rate limited pull request creation.",
      retryable: true,
    });
  }
  if (status >= SERVER_ERROR_STATUS_MIN) {
    return transientUnavailableFailure(stage);
  }
  return buildFailure({
    status,
    code: DesktopGithubPullRequestErrorCode.OperationUnavailable,
    reason: DesktopGithubPullRequestReason.OperationUnavailable,
    stage,
    error: "Desktop GitHub pull request operation is unavailable.",
    retryable: false,
  });
}

function apiIncompatibleFailure(
  stage: DesktopGithubPullRequestStage
): GitPullRequestApiFailure {
  return buildFailure({
    status: 503,
    code: DesktopGithubPullRequestErrorCode.ApiIncompatible,
    reason: DesktopGithubPullRequestReason.ApiIncompatible,
    stage,
    error:
      "Desktop pull request API is incompatible or missing on the configured server.",
    retryable: false,
  });
}

function operationUnavailableFailure(
  stage: DesktopGithubPullRequestStage,
  error: string
): GitPullRequestApiFailure {
  return buildFailure({
    status: 503,
    code: DesktopGithubPullRequestErrorCode.OperationUnavailable,
    reason: DesktopGithubPullRequestReason.OperationUnavailable,
    stage,
    error,
    retryable: false,
  });
}

function transientUnavailableFailure(
  stage: DesktopGithubPullRequestStage
): GitPullRequestApiFailure {
  return buildFailure({
    status: 503,
    code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
    reason: DesktopGithubPullRequestReason.TransientUnavailable,
    stage,
    error: "Desktop pull request API is temporarily unavailable.",
    retryable: true,
  });
}

function buildFailure(input: {
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

function failAndLog(error: GitPullRequestApiFailure): GitPullRequestApiResult {
  gatewayLog.warn(
    GATEWAY_LOG_TAG,
    `PR API unavailable code=${error.code} reason=${error.reason} stage=${error.stage} retryable=${String(error.retryable)} burnRetryBudget=${String(error.burnRetryBudget)}`
  );
  return { ok: false, error };
}

async function readJsonBody(
  response: Response
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; reason: "empty" | "invalid_json" | "read_error" }
> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: "read_error" };
  }
  if (!text.trim()) {
    return { ok: false, reason: "empty" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function knownErrorCode(
  value: unknown
): DesktopGithubPullRequestErrorCode | null {
  return typeof value === "string" &&
    Object.values(DesktopGithubPullRequestErrorCode).includes(
      value as DesktopGithubPullRequestErrorCode
    )
    ? (value as DesktopGithubPullRequestErrorCode)
    : null;
}

function knownReason(value: unknown): DesktopGithubPullRequestReason | null {
  return typeof value === "string" &&
    Object.values(DesktopGithubPullRequestReason).includes(
      value as DesktopGithubPullRequestReason
    )
    ? (value as DesktopGithubPullRequestReason)
    : null;
}

function knownStage(value: unknown): DesktopGithubPullRequestStage | null {
  return typeof value === "string" &&
    Object.values(DesktopGithubPullRequestStage).includes(
      value as DesktopGithubPullRequestStage
    )
    ? (value as DesktopGithubPullRequestStage)
    : null;
}

function knownDenial(value: unknown): GitHubAccessDenialReason | null {
  return typeof value === "string" &&
    Object.values(GitHubAccessDenialReason).includes(
      value as GitHubAccessDenialReason
    )
    ? (value as GitHubAccessDenialReason)
    : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

async function sendGitPullRequestApi(
  options: GitPullRequestApiOptions,
  send: (sessionOptions: SessionFetchOptions) => Promise<SessionPostOutcome>,
  stage: DesktopGithubPullRequestStage
): Promise<GitPullRequestApiResult> {
  if (!options.getAccessToken) {
    return failAndLog(
      operationUnavailableFailure(
        stage,
        "Desktop session token provider is unavailable."
      )
    );
  }
  if (!options.getApiOrigin) {
    return failAndLog(
      operationUnavailableFailure(stage, "Desktop API origin is unavailable.")
    );
  }

  const sessionOptions: SessionFetchOptions = {
    getAccessToken: options.getAccessToken,
    getApiOrigin: options.getApiOrigin,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const outcome = await send(sessionOptions);

  if (outcome.kind === "no_session") {
    return failAndLog(
      buildFailure({
        status: 401,
        code: DesktopGithubPullRequestErrorCode.AuthenticationRequired,
        reason: DesktopGithubPullRequestReason.AuthenticationRequired,
        stage,
        error: "Desktop session authentication is unavailable.",
        retryable: false,
      })
    );
  }
  if (outcome.kind === "no_origin") {
    return failAndLog(
      operationUnavailableFailure(stage, "Desktop API origin is unavailable.")
    );
  }
  if (outcome.kind === "timeout" || outcome.kind === "network_error") {
    return failAndLog(transientUnavailableFailure(stage));
  }

  const classified = await classifyApiResponse(outcome.response, stage);
  if (
    !classified.ok &&
    outcome.response.status === 401 &&
    !classified.firstPartyFailure
  ) {
    options.invalidateAccessToken?.(outcome.accessToken);
  }
  if (!classified.ok) {
    return failAndLog(classified.error);
  }
  return { ok: true, value: classified.value };
}

export function buildGitPullRequestApiOptions(
  sessionAccess: DesktopGatewayGitPullRequestSessionAccess | undefined,
  getApiOrigin: (() => string) | undefined
): GitPullRequestApiOptions | undefined {
  if (!(sessionAccess || getApiOrigin)) {
    return undefined;
  }
  return {
    ...(sessionAccess
      ? {
          getAccessToken: () => sessionAccess.getAccessToken(),
          invalidateAccessToken: (rejectedToken: string) =>
            sessionAccess.invalidateAccessToken(rejectedToken),
        }
      : {}),
    ...(getApiOrigin ? { getApiOrigin } : {}),
  };
}
