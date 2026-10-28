import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { ImportGoogleDocsResponse } from "@repo/api/src/types/google";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { importedDocumentReceipt } from "../import-receipt";
import { googleService } from "../service";
import { importGoogleDocsValidator } from "../validators";

/**
 * This route fetches and creates an artifact for every doc in the selected
 * Drive folder before it responds, so it runs well past the platform default.
 * The client pairs it with `LONG_RUNNING_API_TIMEOUT_MS` (5 minutes); declaring
 * the same ceiling here is what makes that deadline meaningful — without it the
 * platform terminates the function first and the client surfaces a 504 long
 * before its own deadline fires (PR #4321 review).
 */
export const maxDuration = 300;

/**
 * POST /integrations/google/import
 *
 * Import all Google Docs from a folder as PRD artifacts.
 * Requires folderId and projectId in request body.
 * Returns list of successfully imported artifacts and any failures.
 */
export const POST = withAnyAuth<
  ImportGoogleDocsResponse,
  "/integrations/google/import"
>(
  withOperationReceipts(
    OperationKind.Create,
    async ({ user }, request, _params, receipts) => {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        importGoogleDocsValidator
      );

      if (parseError) {
        return parseError;
      }

      // Call service to import docs
      const result = await googleService.importDocsFromFolder(
        body.folderId,
        body.projectId,
        user.organizationId,
        user.id,
        importedDocumentReceipt(receipts)
      );

      if (!result.success) {
        return errorResponse(result.error, null, 400);
      }

      return successResponse({
        importedCount: result.importedCount,
        totalDocsInFolder: result.totalDocsInFolder,
        artifacts: result.artifacts,
        failures: result.failures,
      });
    }
  )
);
