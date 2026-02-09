import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../../artifacts/service";

export const POST = withAuth<{ message: string }, "/templates/seed">(
  async ({ user }) => {
    try {
      await artifactsService.ensureDefaultTemplates(user.organizationId);
      return successResponse({
        message: "Default templates ensured successfully",
      });
    } catch (error) {
      return errorResponse("Failed to ensure default templates", error);
    }
  }
);
