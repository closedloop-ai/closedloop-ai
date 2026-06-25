import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import type {
  LoopAlreadyActiveBody,
  LoopCommand,
  LoopErrorCode as LoopErrorCodeType,
  LoopStatus,
} from "@repo/api/src/types/loop";
import { LoopErrorCode } from "@repo/api/src/types/loop";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/route-utils";
import {
  isBranchNotFoundError,
  isConcurrentLoopLimitError,
  isLoopAlreadyActiveError,
  isNestedManualLoopError,
  isRepoNotInProjectPoolError,
  isUnauthorizedRepoError,
} from "./loop-errors";

/**
 * Build the 409 "loop already active" response. Body is typed via
 * `ApiConflictBody<LoopAlreadyActiveBody>` so the wire contract is shared
 * with the frontend; the outer NextResponse is cast to `ApiResult<never>` to
 * satisfy the standard auth-wrapper response contract (NextResponse is
 * invariant in its body type).
 */
export function loopAlreadyActiveResponse(args: {
  loopId: string;
  command: LoopCommand;
  status: LoopStatus;
  message?: string;
}): NextResponse<ApiResult<never>> {
  const body: LoopAlreadyActiveBody = {
    error: "loop_already_active",
    loopId: args.loopId,
    command: args.command,
    status: args.status,
  };
  return NextResponse.json(conflictBody(args.message ?? body.error, body), {
    status: 409,
  }) as NextResponse<ApiResult<never>>;
}

/**
 * Map common loop-service errors to HTTP responses.
 * Handles ConcurrentLoopLimitError (429), LoopAlreadyActiveError (409),
 * NestedManualLoopError (409), UnauthorizedRepoError (403), and
 * BranchNotFoundError (400).
 * Falls through to a generic 500 for unrecognized errors.
 */
export function handleLoopServiceError(
  error: unknown,
  fallbackMessage: string
): NextResponse<ApiResult<never>> {
  if (isConcurrentLoopLimitError(error)) {
    return errorResponse(error.message, error, 429);
  }
  if (isLoopAlreadyActiveError(error)) {
    return loopAlreadyActiveResponse({
      loopId: error.existingLoopId,
      command: error.existingCommand,
      status: error.existingStatus,
      message: error.message,
    });
  }
  if (isNestedManualLoopError(error)) {
    return errorResponse(error.message, error, 409);
  }
  if (isUnauthorizedRepoError(error)) {
    return errorResponse(error.message, error, 403, {
      code: LoopErrorCode.RepoNotAllowed,
      details: { repoFullName: error.unauthorizedRepos.join(", ") },
    });
  }
  if (isBranchNotFoundError(error)) {
    return errorResponse(error.message, error, 400, {
      code: LoopErrorCode.PreRunValidationFailed satisfies LoopErrorCodeType,
      details: {
        branch: error.branch,
        repoFullName: error.repoFullName,
      },
    });
  }
  if (isRepoNotInProjectPoolError(error)) {
    // 422 indicates the request was syntactically valid but violated the
    // project pool-membership invariant. Distinct from 403 (unauthorized
    // installation access) and 400 (request shape errors).
    return errorResponse(error.message, error, 422, {
      code: LoopErrorCode.RepoNotInProjectPool,
      details: {
        outsidePool: error.outsidePool.join(", "),
        projectId: error.projectId,
      },
    });
  }
  return errorResponse(fallbackMessage, error);
}
