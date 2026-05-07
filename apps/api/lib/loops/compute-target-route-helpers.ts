import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import {
  fetchUserComputePreferences,
  type ResolveComputeTargetResult,
  resolveComputeTarget,
} from "@/lib/loops/compute-target-resolver";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";

export type ComputeTargetRouteResult =
  | { computeTargetId: string | undefined }
  | { errorResponse: NextResponse<ApiResult<never>> };

/**
 * Resolve the compute target for a run-loop request, returning either the
 * resolved target ID (possibly undefined for ECS fallback) or an error response.
 *
 * When no computeTargetIdHint is provided, reads user.preferredComputeMode
 * and passes it to resolveComputeTarget so CLOUD-preferring users bypass
 * local target resolution and get the cloud_resolved path immediately.
 */
export async function resolveComputeTargetForRoute(
  organizationId: string,
  userId: string,
  computeTargetIdHint?: string
): Promise<ComputeTargetRouteResult> {
  let preferredComputeMode: string | undefined;
  let preferredComputeTargetId: string | undefined;

  if (!computeTargetIdHint) {
    const prefs = await fetchUserComputePreferences(userId);
    preferredComputeMode = prefs.preferredComputeMode;
    preferredComputeTargetId = prefs.preferredComputeTargetId;
  }

  const ctResult = await resolveComputeTarget(
    organizationId,
    userId,
    computeTargetIdHint,
    preferredComputeMode,
    undefined,
    preferredComputeTargetId
  );

  const routeResult = mapComputeTargetResult(ctResult);
  log.info("[run-loop] Compute target resolution", {
    reason: ctResult.reason,
    resolvedTargetId:
      "computeTargetId" in routeResult
        ? (routeResult.computeTargetId ?? "cloud/ecs")
        : "error",
    hasError: "errorResponse" in routeResult,
  });

  return routeResult;
}

function mapComputeTargetResult(
  ctResult: ResolveComputeTargetResult
): ComputeTargetRouteResult {
  switch (ctResult.reason) {
    case "resolved":
      return { computeTargetId: ctResult.target.id };
    case "no_targets":
      return { computeTargetId: undefined };
    case "hint_not_found":
      return { errorResponse: notFoundResponse("Compute target") };
    case "hint_offline":
      return {
        errorResponse: badRequestResponse(
          "Compute target is offline. Ensure the desktop app is running."
        ),
      };
    case "no_online_targets":
      return {
        errorResponse: badRequestResponse(
          "No compute targets are online. Ensure the desktop app is running."
        ),
      };
    case "multiple_targets": {
      const body: ComputeTargetConflictBody = {
        error: "multiple_targets",
        message:
          "Multiple compute targets are online. Specify a compute target ID.",
        availableTargets: ctResult.targets.map((t) => ({
          id: t.id,
          machineName: t.machineName,
          status: t.isOnline ? "online" : "offline",
        })),
      };
      return {
        errorResponse: NextResponse.json(conflictBody(body.message, body), {
          status: 409,
        }) as NextResponse<ApiResult<never>>,
      };
    }
    case "cloud_resolved":
      return { computeTargetId: undefined };
    default: {
      const _exhaustive: never = ctResult;
      return {
        errorResponse: errorResponse(
          "Unhandled compute target resolution result",
          _exhaustive
        ),
      };
    }
  }
}
