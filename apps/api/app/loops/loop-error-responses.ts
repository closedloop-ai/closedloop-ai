import type { ApiResult } from "@repo/api/src/types/common";
import type {
  LoopAlreadyActiveBody,
  LoopCommand,
  LoopStatus,
} from "@repo/api/src/types/loop";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/route-utils";
import {
  isBranchNotFoundError,
  isConcurrentLoopLimitError,
  isLoopAlreadyActiveError,
  isNestedManualLoopError,
  isUnauthorizedRepoError,
} from "./loop-errors";

/**
 * Build the 409 "loop already active" response. The body extends ApiResult
 * with an extra `data` field (consumed by the frontend via ApiError.data.data).
 * Cast satisfies the ApiResult<never> return contract.
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
  return NextResponse.json(
    { success: false, error: args.message ?? body.error, data: body },
    { status: 409 }
  ) as NextResponse<ApiResult<never>>;
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
    return errorResponse(error.message, error, 403);
  }
  if (isBranchNotFoundError(error)) {
    return errorResponse(error.message, error, 400);
  }
  return errorResponse(fallbackMessage, error);
}
