import type { PreviewDeployment } from "@repo/api/src/types/artifact";
import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { artifactsService } from "@/app/artifacts/service";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse } from "@/lib/route-utils";

export const GET = withAuth<PreviewDeployment | null, "/artifacts/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const result = await artifactsService.getArtifactPreviewDeployment(
        id,
        user.organizationId
      );
      return NextResponse.json(success(result));
    } catch (error) {
      return errorResponse("Failed to fetch preview deployment", error);
    }
  }
);

export const POST = withAuth<PreviewDeployment | null, "/artifacts/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const result = await artifactsService.refreshPreviewDeployment(
        id,
        user.organizationId
      );
      return NextResponse.json(success(result));
    } catch (error) {
      return errorResponse("Failed to refresh preview deployment", error);
    }
  }
);
