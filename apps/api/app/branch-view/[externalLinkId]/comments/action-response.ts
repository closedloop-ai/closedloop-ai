import {
  type BranchViewCommentActionResult,
  BranchViewCommentActionResultCode,
} from "@repo/api/src/types/branch-view";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { actionFailureDetails } from "./action-route-utils";

/**
 * Convert branch-view comment action results into the route envelope contract:
 * 2xx responses carry the action result as data, while non-2xx responses use
 * the standard failure envelope and preserve the service result code.
 */
export function branchViewCommentActionResponse(
  result: BranchViewCommentActionResult,
  status: number
): NextResponse<ApiResult<BranchViewCommentActionResult>> {
  if (status < 300) {
    return NextResponse.json(success(result), { status });
  }
  const code = result.success
    ? BranchViewCommentActionResultCode.Success
    : result.code;
  const message = result.success
    ? "Branch-view comment action failed"
    : result.message;
  return NextResponse.json(
    failure(message, {
      code,
      details: result.success ? undefined : actionFailureDetails(result),
    }),
    { status }
  );
}
