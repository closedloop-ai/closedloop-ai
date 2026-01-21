import type { Artifact } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const POST = withAuth<Artifact, "/artifacts/[id]/duplicate">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const duplicate = await artifactsService.duplicate(
        id,
        user.organizationId
      );

      return successResponse(duplicate);
    } catch (error) {
      return errorResponse("Failed to duplicate artifact", error);
    }
  }
);
