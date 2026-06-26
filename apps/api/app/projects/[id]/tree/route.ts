import {
  PROJECT_TREE_INCLUDE_PARAM,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../../service";

/**
 * GET /projects/:id/tree - Get project entity tree
 * Returns all artifacts, features, and external links organized hierarchically
 * by entity link chains.
 *
 * With `?include=details`, every artifact node is enriched in place with
 * artifact-level view details (tags, generation status), so the documents
 * table renders from one request (FEA-1763, PLN-874).
 */
export const GET = withAnyAuth<
  ProjectTreeResponse | ProjectTreeDetailsResponse,
  "/projects/[id]/tree"
>(async ({ user }, request, params) => {
  try {
    const { id: projectId } = await params;
    const project = await projectsService.findById(
      projectId,
      user.organizationId
    );

    if (!project) {
      return notFoundResponse("Project");
    }

    const includeDetails =
      request.nextUrl.searchParams.get(PROJECT_TREE_INCLUDE_PARAM) ===
      ProjectTreeInclude.Details;

    const tree = includeDetails
      ? await projectTreeService.getProjectTreeWithDetails(
          project.id,
          user.organizationId
        )
      : await projectTreeService.getProjectTree(
          project.id,
          user.organizationId
        );

    return successResponse(tree);
  } catch (error) {
    return errorResponse("Failed to fetch project tree", error);
  }
});
