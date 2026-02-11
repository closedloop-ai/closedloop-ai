import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
import { resumeLoopValidator } from "../../validators";

export const POST = withAuth<CreateLoopResponse, "/loops/[id]/resume">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        resumeLoopValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await loopsService.resume(
        id,
        user.organizationId,
        user.id,
        body
      );

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to resume loop", error);
    }
  }
);
