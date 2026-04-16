import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { documentsService } from "../../documents/service";

export const POST = withAuth<{ message: string }, "/templates/seed">(
  async ({ user }) => {
    try {
      await documentsService.ensureDefaultTemplates(
        user.organizationId,
        user.id
      );
      return successResponse({
        message: "Default templates ensured successfully",
      });
    } catch (error) {
      return errorResponse("Failed to ensure default templates", error);
    }
  }
);
