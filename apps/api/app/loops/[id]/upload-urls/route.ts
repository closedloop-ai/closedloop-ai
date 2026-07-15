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
  // Optional subset of `keys` whose objects the client will PUT
  // gzip-compressed. Their presigned URLs are signed with
  // `Content-Encoding: gzip` so the stored object carries that metadata and
  // every reader transparently decompresses. Backward compatible: callers that
  // omit it (the ECS harness) get uncompressed URLs unchanged. Keys listed here
  // that are absent from `keys` are inert.
  gzipKeys: z.array(z.string().min(1).max(1024)).max(500).optional(),
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

    // Generate pre-signed PUT URLs for each key. Keys the client flagged as
    // gzip get a URL signed with Content-Encoding: gzip so their compressed
    // bodies are stored with that metadata for transparent read-time decode.
    // The applied encoding is echoed back per URL (additive, optional) so a
    // version-skewed client compresses a body only when the backend confirms it
    // signed for gzip — an older backend omits the field and the client falls
    // back to an uncompressed upload.
    const gzipKeys = new Set(body.gzipKeys ?? []);
    const urls = await Promise.all(
      body.keys.map(async (key) => {
        const gzip = gzipKeys.has(key);
        return {
          key,
          url: await generateUploadUrl(
            key,
            undefined,
            gzip ? { contentEncoding: "gzip" } : {}
          ),
          ...(gzip ? { contentEncoding: "gzip" } : {}),
        };
      })
    );

    return successResponse({ urls });
  } catch (error) {
    return errorResponse("Failed to generate upload URLs", error);
  }
}
