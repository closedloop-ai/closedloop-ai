import {
  extractBearerToken,
  verifyLoopRunnerToken,
} from "@/lib/auth/loop-runner-jwt";
import { resolveGitHubToken } from "@/lib/loops/loop-orchestrator";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";

/**
 * POST /api/loops/:id/github-token - Issue a fresh GitHub installation token.
 *
 * Called by the container harness when its pre-generated token is about to
 * expire (GitHub App installation tokens last 1 hour). Authenticated via the
 * same loop-runner JWT used for event reporting.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: loopId } = await params;

    const token = extractBearerToken(request);
    if (token instanceof Response) {
      return token;
    }

    const claims = await verifyLoopRunnerToken(token);
    if (claims.loopId !== loopId) {
      return errorResponse(
        "Token does not match loop",
        new Error("Forbidden"),
        403
      );
    }

    const loop = await loopsService.findById(loopId, claims.organizationId);
    if (!loop) {
      return errorResponse("Loop not found", new Error("Not Found"), 404);
    }

    if (!loop.repo?.fullName) {
      return errorResponse(
        "Loop has no linked repository",
        new Error("Bad Request"),
        400
      );
    }

    const freshToken = await resolveGitHubToken(
      claims.organizationId,
      loop.repo.fullName
    );

    return successResponse({ token: freshToken });
  } catch (error) {
    return errorResponse("Failed to generate GitHub token", error);
  }
}
