import "server-only";

import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { ImportPackZipResponse } from "@repo/api/src/types/distribution";
import { requireOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
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
  payloadTooLargeResponse,
  successResponse,
} from "@/lib/route-utils";
import { importPackZipComponents } from "../../service";

/**
 * This route downloads and parses a Pack zip and creates every child component
 * before it responds, so it runs well past the platform default. The client
 * pairs it with `LONG_RUNNING_API_TIMEOUT_MS` (5 minutes); declaring the same
 * ceiling here is what makes that deadline meaningful — without it the platform
 * terminates the function first and the client surfaces a 504 long before its
 * own deadline fires (PR #4321 review).
 */
export const maxDuration = 300;

/**
 * POST /catalog/{id}/import-zip
 *
 * Admin-only. Parse the Pack's uploaded zip (canonical Claude Code layout) and
 * create a child component for each recognized file, skipping ones already
 * present and rejecting ones that fail create-path validation.
 * Returns { created, skipped, invalid }.
 */
export const POST = withAnyAuth<
  ImportPackZipResponse,
  "/catalog/[id]/import-zip"
>(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, _request, params, receipts) => {
      const denial = await requireOrgAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { id } = await params;
      // `CatalogItem.id` is `@db.Uuid`; refusing a malformed segment here also
      // avoids burning one of this route's 300s `maxDuration` slots on it.
      if (!isUuid(id)) {
        return notFoundResponse("Catalog item");
      }

      try {
        const result = await importPackZipComponents(
          { id, organizationId: user.organizationId, userId: user.id },
          recordOrganizationWrite(receipts)
        );

        if (!result.ok) {
          if (result.error === 404) {
            return notFoundResponse("Pack");
          }
          if (result.error === 400) {
            return badRequestResponse("No zip uploaded for this Pack");
          }
          if (result.error === 413) {
            return payloadTooLargeResponse(
              "Pack zip exceeds the decompressed-size or entry-count limit"
            );
          }
          return forbiddenResponse();
        }

        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to import Pack zip", error);
      }
    }
  )
);
