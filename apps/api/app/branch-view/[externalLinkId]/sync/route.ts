import {
  BranchViewSyncErrorCode,
  type BranchViewSyncRequest,
  type BranchViewSyncResponse,
  BranchViewSyncScope,
} from "@repo/api/src/types/branch-view";
import { type ApiResult, failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  resolveBranchViewSyncPreflightContext,
  syncBranchViewDataWithRequest,
} from "../service";

const branchViewSyncRequestSchema = z
  .object({
    scope: z
      .enum([BranchViewSyncScope.Branch, BranchViewSyncScope.Comments])
      .optional(),
  })
  .passthrough();

export const POST = withAnyAuth<
  BranchViewSyncResponse,
  "/branch-view/[externalLinkId]/sync"
>(async ({ user }, request, params) => {
  try {
    const { externalLinkId } = await params;
    const parsedRequest = await parseBranchViewSyncRequest(request);
    if (parsedRequest.errorResponse) {
      return parsedRequest.errorResponse;
    }

    const preflight = await resolveBranchViewSyncPreflightContext(
      externalLinkId,
      user.organizationId
    );
    if (preflight.status === "not_found") {
      return notFoundResponse("Branch view");
    }
    if (preflight.status === "failed") {
      return branchViewSyncPreflightFailureResponse(preflight);
    }

    const result = await syncBranchViewDataWithRequest(
      preflight.ctx,
      parsedRequest.body
    );
    if (!result.synced && result.error === null) {
      return NextResponse.json(
        failure("Branch view sync is throttled", {
          code: BranchViewSyncErrorCode.SyncThrottled,
          details: {
            retryAfterSeconds: result.retryAfterSeconds,
            throttleReason: result.throttleReason,
          },
        }),
        {
          status: 429,
          headers: { "Retry-After": String(result.retryAfterSeconds) },
        }
      );
    }
    if (result.error) {
      return errorResponse(result.error, result.error, result.httpStatus, {
        code: result.code,
        details: result.details,
      });
    }

    return successResponse({ synced: true, scope: result.scope });
  } catch (error) {
    return errorResponse("Failed to sync branch view", error);
  }
});

function branchViewSyncPreflightFailureResponse(
  input: Extract<
    Awaited<ReturnType<typeof resolveBranchViewSyncPreflightContext>>,
    { status: "failed" }
  >
) {
  return errorResponse(input.error, input.error, input.httpStatus, {
    code: input.code,
    details: {
      reason: input.reason,
    },
  });
}

async function parseBranchViewSyncRequest(
  request: Request
): Promise<
  | { body: BranchViewSyncRequest; errorResponse: null }
  | { body: null; errorResponse: NextResponse<ApiResult<never>> }
> {
  const rawText = await request.text();
  if (rawText.trim().length === 0) {
    return {
      body: { scope: BranchViewSyncScope.Branch },
      errorResponse: null,
    };
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(rawText);
  } catch {
    return {
      body: null,
      errorResponse: badRequestResponse("Invalid JSON body"),
    };
  }

  const parsed = branchViewSyncRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      body: null,
      errorResponse: badRequestResponse("Invalid Branch View sync scope"),
    };
  }

  return {
    body: { scope: parsed.data.scope ?? BranchViewSyncScope.Branch },
    errorResponse: null,
  };
}
