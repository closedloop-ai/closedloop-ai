import "server-only";

import { log } from "@repo/observability/log";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { launchBootstrapLoop } from "@/lib/loops/launch-bootstrap-loop";
import {
  errorResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";

const bodySchema = z
  .object({
    repos: z
      .array(z.object({ fullName: z.string().min(1) }))
      .min(1)
      .max(50),
    options: z
      .object({
        depth: z.enum(["quick", "medium", "deep"]),
      })
      .optional(),
    computeTargetId: z.string().uuid().optional(),
  })
  .strict();

export const POST = withAnyAuth(async ({ user }, request) => {
  const { body, errorResponse: parseError } = await parseBody(
    request,
    bodySchema
  );
  if (!body) {
    return parseError;
  }

  const result = await launchBootstrapLoop({
    organizationId: user.organizationId,
    userId: user.id,
    repos: body.repos,
    options: body.options,
    computeTargetId: body.computeTargetId,
  });

  if (!result.ok) {
    if (result.error === "compute_target_not_found") {
      return errorResponse("Compute target not found.", null, 404);
    }
    if (result.error === "compute_target_offline") {
      return errorResponse(
        "Compute target is offline. Ensure the desktop app is running.",
        null,
        400
      );
    }
    if (result.error === "no_online_targets") {
      return errorResponse(
        "No online compute targets found. Ensure the desktop app is running.",
        null,
        400
      );
    }
    if (result.error === "multiple_targets") {
      return errorResponse(
        "Multiple compute targets are online. Specify a computeTargetId to select one.",
        null,
        409
      );
    }
    if (result.error === "concurrent_limit_exceeded") {
      return errorResponse(
        "Too many concurrent loops. Wait for an existing loop to finish.",
        null,
        429
      );
    }
    if (result.error === "callback_unavailable") {
      return errorResponse(
        "Loop dispatch failed because the desktop app could not reach the cloud callback endpoint. Check cloud connection in the desktop app and retry.",
        null,
        502
      );
    }

    // launch_failed
    return errorResponse(
      "Loop dispatch failed. The desktop app may be disconnected.",
      null,
      502
    );
  }

  log.info("[catalog/bootstrap/start] Bootstrap loop launched", {
    loopId: result.loopId,
    repoCount: body.repos.length,
  });
  scheduleLogFlush();

  return successResponse({ loopId: result.loopId, status: result.status });
});
