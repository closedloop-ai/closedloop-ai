import {
  type BranchViewData,
  BranchViewLoadErrorCode,
} from "@repo/api/src/types/branch-view";
import { failure, type JsonObject } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  BranchViewContextCredentialMode,
  resolvePrContext,
} from "@/lib/resolve-pr-context";
import {
  errorResponse,
  notFoundResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import {
  getBranchViewData,
  resolveBranchViewMissingContextFailure,
} from "./service";

export const GET = withAnyAuth<BranchViewData, "/branch-view/[externalLinkId]">(
  async ({ apiKeyScopes, authMethod, user }, _, params) => {
    try {
      const { externalLinkId } = await params;

      const ctx = await resolvePrContext(externalLinkId, user.organizationId, {
        credentialMode: BranchViewContextCredentialMode.RenderRead,
      });
      if (!ctx) {
        const resolvedFailure = await resolveBranchViewMissingContextFailure(
          externalLinkId,
          user.organizationId
        );
        if (resolvedFailure.code !== BranchViewLoadErrorCode.LinkNotFound) {
          return branchViewFailureResponse(resolvedFailure);
        }
        return notFoundResponse("Branch view", {
          code: resolvedFailure.code,
          ...(resolvedFailure.details
            ? { details: resolvedFailure.details }
            : {}),
        });
      }

      const result = await getBranchViewData(ctx, user, {
        authMethod,
        organizationId: user.organizationId,
        apiKeyScopes,
      });
      if (!result.ok) {
        const { error: serviceFailure } = result;
        return branchViewFailureResponse(serviceFailure);
      }

      scheduleLogFlush();
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to fetch branch view data", error, 500, {
        code: BranchViewLoadErrorCode.TransientLoadError,
      });
    }
  }
);

function branchViewFailureResponse(input: {
  code: BranchViewLoadErrorCode;
  details?: JsonObject;
  message: string;
  status: number;
}) {
  if (input.status >= 500) {
    log.error("[branch-view] Failed to load branch view", {
      code: input.code,
      ...(input.details ? { details: input.details } : {}),
    });
    scheduleLogFlush();
  }

  return NextResponse.json(
    failure(input.message, {
      code: input.code,
      ...(input.details ? { details: input.details } : {}),
    }),
    { status: input.status }
  );
}
