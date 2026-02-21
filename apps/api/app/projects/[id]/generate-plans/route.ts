import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../../../artifacts/service";
import { projectsService } from "../../../projects/service";

/**
 * POST /projects/:id/generate-plans
 * Batch-regenerates implementation plans for all approved PRDs in a project.
 * Accepts both session (Clerk) and API key authentication.
 */
export const POST = withAnyAuth<
  { triggered: number; artifactIds: string[] },
  "/projects/[id]/generate-plans"
>(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const project = await projectsService.findById(id, user.organizationId);
      if (!project) {
        return notFoundResponse("Project");
      }

      const result = await artifactsService.batchRegenerateImplementationPlans(
        id,
        user.organizationId,
        user.id
      );
      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to generate plans", error);
    }
  },
  { requiredScopes: ["write"] }
);
