import "server-only";

import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import { requireOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { recordOrganizationWrite } from "@/lib/organization-write-receipt";
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
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, _params, receipts) => {
      const denial = await requireOrgAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        confirmUploadBodySchema
      );
      if (parseError) {
        return parseError;
      }

      try {
        const result = await confirmAssetUpload(
          {
            organizationId: user.organizationId,
            catalogItemId: body.catalogItemId,
            fileType: body.fileType,
            s3Key: body.s3Key,
          },
          recordOrganizationWrite(receipts)
        );

        if (!result.ok) {
          if (result.error === 404) {
            return notFoundResponse("Catalog item");
          }
          if (result.error === 403) {
            return forbiddenResponse();
          }
          // The remaining member: CatalogAssetError.AssetNotFound.
          return badRequestResponse(
            "Asset not found in S3. Upload the file before confirming."
          );
        }

        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to confirm asset upload", error);
      }
    }
  )
);
