import type { JsonObject } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  errorResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../../service";
import { getPlanUploadDiagnostics } from "./diagnostics";
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

    const claims = await authenticateLoopRunnerRequest(
      request,
      loopId,
      "loops/[id]/upload-artifacts"
    );
    if (claims instanceof Response) {
      return claims;
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
      body.artifacts
    );
    if (updatedCount === 0) {
      log.warn("[upload-artifacts] No rows updated — loop may be terminal", {
        loopId,
      });
    }

    const loop = await loopsService.findById(loopId, claims.organizationId);
    log.info("[upload-artifacts] Desktop artifacts stored", {
      loopId,
      organizationId: claims.organizationId,
      computeTargetId: loop?.computeTargetId ?? null,
      updatedCount,
      artifactKeys: Object.keys(body.artifacts),
      executionResultPresent: body.artifacts.executionResult !== undefined,
      ...getPlanUploadDiagnostics(body.artifacts),
    });

    // Merge metadata if provided
    if (body.metadata && loop) {
      const mergedMetadata = {
        ...(loop.metadata ?? {}),
        ...body.metadata,
      } satisfies JsonObject;
      await loopsService.updateMetadata(
        loopId,
        claims.organizationId,
        mergedMetadata
      );
    }

    scheduleLogFlush();
    return successResponse({ stored: true });
  } catch (error) {
    return errorResponse("Failed to upload artifacts", error);
  }
}
