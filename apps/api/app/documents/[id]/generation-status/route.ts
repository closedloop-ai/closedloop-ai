import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type { GenerationStatus } from "@repo/api/src/types/document";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

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
      const result = await documentsService.getGenerationStatus(
        resolvedId,
        user.organizationId
      );

      if (!result) {
        return notFoundResponse("Artifact");
      }

      return NextResponse.json(success(result));
    } catch (error) {
      console.error("Failed to fetch generation status:", error);
      return NextResponse.json(failure("Failed to fetch generation status"), {
        status: 500,
      });
    }
  }
);
