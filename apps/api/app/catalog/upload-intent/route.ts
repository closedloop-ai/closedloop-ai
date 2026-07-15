import "server-only";

import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { getUploadIntent } from "../service";
import { uploadIntentBodySchema } from "../validators";

/**
 * POST /catalog/upload-intent
 *
 * Admin-only. Generates a presigned S3 PUT URL for a catalog asset.
 * The client PUTs the asset bytes directly to S3 (no bytes through the API),
 * then calls POST /catalog/confirm to record the key in DB.
 *
 * Size caps enforced server-side:
 *   - zip: max 50 MB
 *   - logo: max 2 MB
 *
 * Returns { presignedUrl, s3Key }.
 */
type UploadIntentResponse = { presignedUrl: string; s3Key: string };

export const POST = withAnyAuth<UploadIntentResponse, "/catalog/upload-intent">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!adminCheck) {
      return forbiddenResponse();
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      uploadIntentBodySchema
    );
    if (parseError) {
      return parseError;
    }

    try {
      const result = await getUploadIntent({
        organizationId: user.organizationId,
        catalogItemId: body.catalogItemId,
        fileType: body.fileType,
        contentType: body.contentType,
        fileSizeBytes: body.fileSizeBytes,
      });

      if (!result.ok) {
        if (result.error === 404) {
          return notFoundResponse("Catalog item");
        }
        if (result.error === 403) {
          return forbiddenResponse();
        }
        if (result.error === 415) {
          return errorResponse(
            "Unsupported content type for this file type",
            null,
            415
          );
        }
        // 413 — payload too large
        return errorResponse("File size exceeds the allowed limit", null, 413);
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to generate upload URL", error);
    }
  }
);
