import type { ApiResult, JsonObject } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import type { DesktopGithubPullRequestServiceFailure } from "./failure";

export function desktopGithubPullRequestFailureResponse(
  error: DesktopGithubPullRequestServiceFailure
): NextResponse<ApiResult<never>> {
  return NextResponse.json(
    failure(error.error, {
      code: error.code,
      details: pullRequestFailureDetails(error),
    }),
    {
      status: error.status,
      headers: retryAfterHeaders(error),
    }
  );
}

function pullRequestFailureDetails(
  error: DesktopGithubPullRequestServiceFailure
): JsonObject {
  return {
    reason: error.reason,
    ...(error.denial === undefined ? {} : { denial: error.denial }),
    stage: error.stage,
    retryable: error.retryable,
    burnRetryBudget: error.burnRetryBudget,
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
  };
}

function retryAfterHeaders(
  error: DesktopGithubPullRequestServiceFailure
): HeadersInit {
  return typeof error.retryAfterSeconds === "number"
    ? { "Retry-After": String(error.retryAfterSeconds) }
    : {};
}
