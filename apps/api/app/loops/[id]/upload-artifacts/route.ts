import type { JsonObject } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { authenticateLoopRunner } from "@/lib/auth/loop-runner-jwt";
import { shortContentHash } from "@/lib/content-hash";
import { parseJsonObject } from "@/lib/json-schema";
import {
  errorResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../../service";
import { uploadArtifactsSchema } from "./validators";

function getPlanUploadDiagnostics(artifacts: JsonObject): {
  planArtifactPresent: boolean;
  planRawRecordPresent: boolean;
  planRawContentPresent: boolean;
  planRawContentMatchesArtifact: boolean | null;
  planRawReusableByDesktop: boolean | null;
  planContentLength: number | null;
  planRawContentLength: number | null;
  planContentHash: string | null;
  planRawContentHash: string | null;
} {
  const planArtifact = parseJsonObject(artifacts.plan);
  const planContent =
    typeof planArtifact?.content === "string"
      ? planArtifact.content
      : undefined;
  const rawPlan = parseJsonObject(planArtifact?.raw);
  const rawPlanContent =
    typeof rawPlan?.content === "string" ? rawPlan.content : undefined;
  let planRawReusableByDesktop: boolean | null = null;
  if (planContent !== undefined && rawPlanContent !== undefined) {
    planRawReusableByDesktop = rawPlanContent === planContent;
  } else if (planContent !== undefined) {
    planRawReusableByDesktop = false;
  }

  return {
    planArtifactPresent: planArtifact !== null,
    planRawRecordPresent: rawPlan !== null,
    planRawContentPresent: rawPlanContent !== undefined,
    planRawContentMatchesArtifact:
      planContent !== undefined && rawPlanContent !== undefined
        ? rawPlanContent === planContent
        : null,
    planRawReusableByDesktop,
    planContentLength: planContent?.length ?? null,
    planRawContentLength: rawPlanContent?.length ?? null,
    planContentHash: shortContentHash(planContent),
    planRawContentHash: shortContentHash(rawPlanContent),
  };
}

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
      body.artifacts
    );
    if (updatedCount === 0) {
      log.warn("[upload-artifacts] No rows updated — loop may be terminal", {
        loopId,
      });
    }

    const loop = await loopsService.findById(
      loopId,
      auth.claims.organizationId
    );
    log.info("[upload-artifacts] Desktop artifacts stored", {
      loopId,
      organizationId: auth.claims.organizationId,
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
        auth.claims.organizationId,
        mergedMetadata
      );
    }

    scheduleLogFlush();
    return successResponse({ stored: true });
  } catch (error) {
    return errorResponse("Failed to upload artifacts", error);
  }
}
