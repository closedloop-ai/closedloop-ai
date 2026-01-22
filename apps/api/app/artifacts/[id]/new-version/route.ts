import type { Artifact } from "@repo/api/src/types/artifact";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

const newVersionValidator = z.object({
  content: z.string(),
});

export const POST = withAuth<Artifact, "/artifacts/[id]/new-version">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        newVersionValidator
      );
      if (parseError) {
        return parseError;
      }

      const newVersion = await artifactsService.createNewVersion(
        id,
        user.organizationId,
        body.content
      );

      return successResponse(newVersion);
    } catch (error) {
      return errorResponse("Failed to create new version", error);
    }
  }
);
