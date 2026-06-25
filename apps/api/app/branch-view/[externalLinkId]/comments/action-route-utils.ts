import {
  BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS,
  BranchViewCommentActionRecovery,
  type BranchViewCommentActionResult,
  BranchViewCommentActionResultCode,
} from "@repo/api/src/types/branch-view";
import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { BRANCH_VIEW_COMMENT_REQUEST_MAX_BYTES } from "../schemas";

/**
 * Parse a bounded branch-view comment action body with the action result
 * contract instead of the generic route-utils parse shape.
 */
export async function parseCommentActionBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  makeInvalid: (message: string) => BranchViewCommentActionResult
): Promise<
  | { body: z.infer<T>; response: null }
  | {
      body: null;
      response: NextResponse<ApiResult<BranchViewCommentActionResult>>;
    }
> {
  const text = await request.text();
  if (
    new TextEncoder().encode(text).length >
    BRANCH_VIEW_COMMENT_REQUEST_MAX_BYTES
  ) {
    return {
      body: null,
      response: actionResultResponse(
        makeInvalid("Request body exceeds 128 KiB")
      ),
    };
  }

  let raw: unknown;
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return {
      body: null,
      response: actionResultResponse(makeInvalid("Invalid JSON body")),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      body: null,
      response: actionResultResponse(
        makeInvalid(
          parsed.error.issues.map((issue) => issue.message).join(", ")
        )
      ),
    };
  }

  return { body: parsed.data, response: null };
}

/**
 * Preserve the branch-view action result discriminant while keeping 2xx
 * recovery outcomes as data so app mutation handlers can inspect them.
 */
export function actionResultResponse(
  result: BranchViewCommentActionResult
): NextResponse<ApiResult<BranchViewCommentActionResult>> {
  const status = result.success
    ? BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS[
        BranchViewCommentActionResultCode.Success
      ]
    : BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS[result.code];
  if (result.success || status < 300) {
    return NextResponse.json(success(result), { status });
  }
  return actionFailureResponse(result) as NextResponse<
    ApiResult<BranchViewCommentActionResult>
  >;
}

export function actionFailureResponse(
  result: Extract<BranchViewCommentActionResult, { success: false }>
): NextResponse<ApiResult<never>> {
  const status = BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS[result.code];
  return NextResponse.json(
    failure(result.message, {
      code: result.code,
      details: actionFailureDetails(result),
    }),
    { status }
  );
}

export function invalidCommentActionResult(input: {
  action: BranchViewCommentActionResult["action"];
  message: string;
}): BranchViewCommentActionResult {
  return {
    success: false,
    action: input.action,
    code: BranchViewCommentActionResultCode.InvalidRequest,
    message: input.message,
  };
}

export function actionFailureDetails(
  result: Extract<BranchViewCommentActionResult, { success: false }>
) {
  return {
    action: result.action,
    ...(result.recovery === BranchViewCommentActionRecovery.BranchViewSync
      ? { recovery: result.recovery }
      : {}),
    ...(result.github ? { github: result.github } : {}),
    ...(result.identityBlocker
      ? { identityBlocker: result.identityBlocker }
      : {}),
  };
}
