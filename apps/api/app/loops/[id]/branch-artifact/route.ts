import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  createLoopBranchArtifact,
  loopBranchArtifactSchema,
} from "./branch-artifact-service";

/**
 * POST /api/loops/:id/branch-artifact
 *
 * Authenticated harness callback for branch materialization. The loop context,
 * not the request body, owns source-artifact and repository eligibility.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: loopId } = await params;

    const claims = await authenticateLoopRunnerRequest(
      request,
      loopId,
      "loops/[id]/branch-artifact"
    );
    if (claims instanceof Response) {
      return claims;
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      loopBranchArtifactSchema
    );
    if (parseError || !body) {
      return parseError;
    }

    const result = await createLoopBranchArtifact({
      loopId,
      organizationId: claims.organizationId,
      body,
    });
    if (!result.ok) {
      if (result.error === 400) {
        return badRequestResponse("Loop branch artifact input is invalid");
      }
      if (result.error === 403) {
        return errorResponse(
          "Loop is not authorized to materialize this branch",
          result.error,
          403
        );
      }
      return errorResponse("Loop source artifact not found", result.error, 404);
    }

    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to create loop branch artifact", error);
  }
}
