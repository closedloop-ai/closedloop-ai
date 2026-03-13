import type { JsonObject } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import {
  extractBearerToken,
  verifyLoopRunnerToken,
} from "@/lib/auth/loop-runner-jwt";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
import { uploadArtifactsSchema } from "./validators";

/**
 * POST /api/loops/:id/upload-artifacts
 *
 * Receives artifacts directly from the electron desktop harness.
 * Authenticated via loop runner JWT (same as events endpoint).
 * Stores artifacts on the loop record for later ingestion by command handlers.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: loopId } = await params;

    const token = extractBearerToken(request);
    if (token instanceof Response) {
      return token;
    }

    let claims: Awaited<ReturnType<typeof verifyLoopRunnerToken>>;
    try {
      claims = await verifyLoopRunnerToken(token);
    } catch (jwtError) {
      return errorResponse("Invalid or expired runner token", jwtError, 401);
    }
    if (claims.loopId !== loopId) {
      return errorResponse(
        "Token does not match loop",
        new Error("Forbidden"),
        403
      );
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      uploadArtifactsSchema
    );
    if (parseError || !body) {
      return parseError;
    }

    // Store artifacts on the loop record
    const updatedCount = await loopsService.updateUploadedArtifacts(
      loopId,
      claims.organizationId,
      body.artifacts as JsonObject
    );
    if (updatedCount === 0) {
      log.warn("[upload-artifacts] No rows updated — loop may be terminal", {
        loopId,
      });
    }

    // Merge metadata if provided
    if (body.metadata) {
      const loop = await loopsService.findById(loopId, claims.organizationId);
      if (loop) {
        const mergedMetadata = {
          ...(loop.metadata ?? {}),
          ...body.metadata,
        } as JsonObject;
        await loopsService.updateMetadata(
          loopId,
          claims.organizationId,
          mergedMetadata
        );
      }
    }

    return successResponse({ stored: true });
  } catch (error) {
    return errorResponse("Failed to upload artifacts", error);
  }
}
