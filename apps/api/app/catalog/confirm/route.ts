import "server-only";

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { confirmAssetUpload } from "../service";
import { confirmUploadBodySchema } from "../validators";

/**
 * POST /catalog/confirm
 *
 * Admin-only. Verifies that a previously-PUT S3 catalog asset exists
 * (HeadObject) and records its key in the CatalogItem row in DB.
 *
 * Returns the updated CatalogItemDto with the asset key populated.
 * Returns 400 if the asset is not found in S3 (HeadObject 404).
 */
export const POST = withAnyAuth<CatalogItemDto, "/catalog/confirm">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!adminCheck) {
      return forbiddenResponse();
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      confirmUploadBodySchema
    );
    if (parseError) {
      return parseError;
    }

    try {
      const result = await confirmAssetUpload({
        organizationId: user.organizationId,
        catalogItemId: body.catalogItemId,
        fileType: body.fileType,
        s3Key: body.s3Key,
      });

      if (!result.ok) {
        if (result.error === 404) {
          return notFoundResponse("Catalog item");
        }
        if (result.error === 403) {
          return forbiddenResponse();
        }
        // asset_not_found
        return badRequestResponse(
          "Asset not found in S3. Upload the file before confirming."
        );
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to confirm asset upload", error);
    }
  }
);
