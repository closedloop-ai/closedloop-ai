import type { GenerationStatus } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { notFoundResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAuth<
  GenerationStatus,
  "/artifacts/[id]/generation-status"
>(
  async (
    { user },
    _request,
    params
  ): Promise<NextResponse<ApiResult<GenerationStatus>>> => {
    const { id } = await params;

    try {
      const result = await artifactsService.getGenerationStatus(
        id,
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
