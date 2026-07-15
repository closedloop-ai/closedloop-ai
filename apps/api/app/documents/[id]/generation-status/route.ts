import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type { GenerationStatus } from "@repo/api/src/types/document";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { documentGenerationStatusService } from "../../generation-status-service";

export const GET = withAuth<
  GenerationStatus,
  "/documents/[id]/generation-status"
>(
  async (
    { user },
    _request,
    params
  ): Promise<NextResponse<ApiResult<GenerationStatus>>> => {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    try {
      const result = await documentGenerationStatusService.getGenerationStatus(
        resolvedId,
        user.organizationId
      );

      if (!result) {
        return notFoundResponse("Artifact");
      }

      return NextResponse.json(success(result));
    } catch (error) {
      log.error("documents.generation_status_failed", { error, resolvedId });
      return NextResponse.json(failure("Failed to fetch generation status"), {
        status: 500,
      });
    }
  }
);
