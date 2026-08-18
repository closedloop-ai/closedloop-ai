import {
  type BranchSelectedPullRequestDiffResponse,
  type BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { successResponse } from "@/lib/route-utils";

type SelectedPullRequestReadResponse =
  | BranchSelectedPullRequestDiffResponse
  | BranchSelectedPullRequestFilesResponse;

const CLIENT_CLOSED_REQUEST_STATUS = 499;

/** Preserve the typed success envelope and advertise local acquisition retry delay. */
export function selectedPullRequestReadResponse<
  Result extends SelectedPullRequestReadResponse,
>(result: Result): NextResponse<ApiResult<Result>> {
  const response = successResponse(result);
  if (
    result.status === BranchSelectedPullRequestReadAvailability.Unavailable &&
    result.source === BranchSelectedPullRequestUnavailableSource.Acquisition
  ) {
    response.headers.set("Retry-After", String(result.retryAfterSeconds));
  }
  return response;
}

/** Settle a caller-aborted route without misclassifying it as auth or API failure. */
export function selectedPullRequestCancelledResponse(): NextResponse<
  ApiResult<never>
> {
  return NextResponse.json(failure("Request cancelled"), {
    status: CLIENT_CLOSED_REQUEST_STATUS,
  });
}
