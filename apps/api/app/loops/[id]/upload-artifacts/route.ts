import type { JsonObject } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { authenticateLoopRunner } from "@/lib/auth/loop-runner-jwt";
import {
  errorResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
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

    const auth = await authenticateLoopRunner(request, loopId);
    if (!auth.ok) {
      return auth.response;
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
      auth.claims.organizationId,
      body.artifacts as JsonObject
    );
    if (updatedCount === 0) {
      log.warn("[upload-artifacts] No rows updated — loop may be terminal", {
        loopId,
      });
    }

    // Merge metadata if provided
    if (body.metadata) {
      const loop = await loopsService.findById(
        loopId,
        auth.claims.organizationId
      );
      if (loop) {
        const mergedMetadata = {
          ...(loop.metadata ?? {}),
          ...body.metadata,
        } as JsonObject;
        await loopsService.updateMetadata(
          loopId,
          auth.claims.organizationId,
          mergedMetadata
        );
      }
    }

    scheduleLogFlush();
    return successResponse({ stored: true });
  } catch (error) {
    return errorResponse("Failed to upload artifacts", error);
  }
}
