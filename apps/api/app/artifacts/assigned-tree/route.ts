import {
  ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { assignedArtifactTreeService } from "../assigned-artifact-tree-service";

/**
 * Query contract for the assignee-scoped tree. `.strict()` is deliberate: the
 * route implements exactly one filter, so an unsupported param (a project,
 * status, or recency filter this route cannot honor) is rejected with a 400
 * rather than silently accepted and dropped.
 */
const assignedTreeQuerySchema = z
  .object({
    [ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM]: z.string().trim().uuid(),
  })
  .strict();

/**
 * GET /artifacts/assigned-tree?assigneeId=<userId> — the merged, org-scoped
 * artifact tree for one assignee (FEA-1651, parent FEA-908; flagged by wongk in
 * the PR #1077 review).
 *
 * Answers with the same `ProjectTreeResponse` shape as `GET /projects/:id/tree`
 * so tree consumers work against one contract, and collapses the My Tasks
 * client fan-out — previously one request per project the user is assigned in —
 * into a single request. The organization always comes from the authenticated
 * caller, never from the query string.
 */
export const GET = withAnyAuth<ProjectTreeResponse, "/artifacts/assigned-tree">(
  async ({ user }, request) => {
    const { params, errorResponse: invalidParams } = parseQueryParams(
      request,
      assignedTreeQuerySchema
    );
    if (invalidParams) {
      return invalidParams;
    }

    try {
      const tree = await assignedArtifactTreeService.getAssignedArtifactTree(
        params[ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM],
        user.organizationId
      );
      return successResponse(tree);
    } catch (error) {
      return errorResponse("Failed to fetch assigned artifact tree", error);
    }
  }
);
