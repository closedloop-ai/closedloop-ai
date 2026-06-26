import { z } from "zod";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  generateUploadUrl,
  validateKeyBelongsToLoop,
} from "@/lib/loops/loop-state";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";

const uploadUrlsValidator = z.object({
  keys: z.array(z.string().min(1).max(1024)).min(1).max(500),
});

/**
 * POST /api/loops/:id/upload-urls - Generate pre-signed PUT URLs for S3 uploads.
 *
 * The container harness calls this to get upload URLs for state files,
 * metadata, logs, etc. Each URL is scoped to a single S3 key and time-limited.
 * This eliminates the need for direct S3 write credentials in the container,
 * preventing cross-tenant data writes.
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
      "loops/[id]/upload-urls"
    );
    if (claims instanceof Response) {
      return claims;
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      uploadUrlsValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    // Validate all keys belong to this loop's S3 prefix.
    // Scoped to {orgId}/loops/{loopId}/ to prevent cross-loop state corruption.
    for (const key of body.keys) {
      if (!validateKeyBelongsToLoop(key, claims.organizationId, loopId)) {
        return errorResponse(
          `Key "${key}" is outside loop scope`,
          new Error("Forbidden"),
          403
        );
      }
    }

    // Verify the loop exists and belongs to this org
    const loop = await loopsService.findById(loopId, claims.organizationId);
    if (!loop) {
      return errorResponse("Loop not found", new Error("Not Found"), 404);
    }

    // Generate pre-signed PUT URLs for each key
    const urls = await Promise.all(
      body.keys.map(async (key) => ({
        key,
        url: await generateUploadUrl(key),
      }))
    );

    return successResponse({ urls });
  } catch (error) {
    return errorResponse("Failed to generate upload URLs", error);
  }
}
