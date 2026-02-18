import { z } from "zod";
import {
  extractBearerToken,
  verifyLoopRunnerToken,
} from "@/lib/auth/loop-runner-jwt";
import {
  listAndGenerateDownloadUrls,
  validateKeyBelongsToLoop,
} from "@/lib/loop-state";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";

const downloadUrlsValidator = z.object({
  prefix: z.string().min(1).max(1024),
});

/**
 * POST /api/loops/:id/download-urls - Generate pre-signed GET URLs for S3 downloads.
 *
 * The container harness calls this to download parent loop state during resume.
 * Lists all objects under the given prefix and returns pre-signed GET URLs.
 * This eliminates the need for direct S3 read/list credentials in the container,
 * preventing cross-tenant data access.
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

    const { body, errorResponse: parseError } = await parseBody(
      request,
      downloadUrlsValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    // Verify the loop exists and belongs to this org
    const loop = await loopsService.findById(loopId, claims.organizationId);
    if (!loop) {
      return errorResponse("Loop not found", new Error("Not Found"), 404);
    }

    // Validate the prefix belongs to this loop or its parent (for resume).
    // Scoped to {orgId}/loops/{loopId}/ to prevent cross-loop data exposure.
    const allowedLoopIds = [loopId];
    if (loop.parentLoopId) {
      allowedLoopIds.push(loop.parentLoopId);
    }
    const prefixAllowed = allowedLoopIds.some((id) =>
      validateKeyBelongsToLoop(body.prefix, claims.organizationId, id)
    );
    if (!prefixAllowed) {
      return errorResponse(
        "Prefix is outside loop scope",
        new Error("Forbidden"),
        403
      );
    }

    // List objects under the prefix and generate pre-signed GET URLs
    const urls = await listAndGenerateDownloadUrls(body.prefix);

    return successResponse({ urls });
  } catch (error) {
    return errorResponse("Failed to generate download URLs", error);
  }
}
