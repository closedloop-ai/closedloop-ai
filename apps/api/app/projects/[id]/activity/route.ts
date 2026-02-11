import type { ActivityResponse } from "@repo/api/src/types/activity";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../../service";
import { activityService } from "./service";

/**
 * GET /projects/:id/activity - Get project activity feed
 * Query params:
 *   - page: Page number (default: 1)
 *   - pageSize: Items per page (default: 20, max: 100)
 */
export const GET = withAuth<ActivityResponse, "/projects/[id]/activity">(
  async ({ user }, request, params) => {
    try {
      const { id: projectId } = await params;
      const project = await projectsService.findById(
        projectId,
        user.organizationId
      );

      if (!project) {
        return notFoundResponse("Project");
      }

      // Parse pagination params
      const { searchParams } = new URL(request.url);
      const page = Math.max(
        1,
        Number.parseInt(searchParams.get("page") || "1", 10)
      );
      const pageSize = Math.min(
        100,
        Math.max(1, Number.parseInt(searchParams.get("pageSize") || "20", 10))
      );

      const response = await activityService.findByProject({
        organizationId: user.organizationId,
        projectId,
        page,
        pageSize,
      });

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch project activity", error);
    }
  }
);
