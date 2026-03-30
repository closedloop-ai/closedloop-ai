import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../../service";
import { projectTreeService } from "./service";

/**
 * GET /projects/:id/tree - Get project entity tree
 * Returns all artifacts, features, and external links organized hierarchically
 * by entity link chains.
 */
export const GET = withAnyAuth<ProjectTreeResponse, "/projects/[id]/tree">(
  async ({ user }, _, params) => {
    try {
      const { id: projectId } = await params;
      const project = await projectsService.findById(
        projectId,
        user.organizationId
      );

      if (!project) {
        return notFoundResponse("Project");
      }

      const tree = await projectTreeService.getProjectTree(
        project.id,
        user.organizationId
      );

      return successResponse(tree);
    } catch (error) {
      return errorResponse("Failed to fetch project tree", error);
    }
  }
);
