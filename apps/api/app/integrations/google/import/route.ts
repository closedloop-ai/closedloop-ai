import type { ImportGoogleDocsResponse } from "@repo/api/src/types/google";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { googleService } from "../service";
import { importGoogleDocsValidator } from "../validators";

/**
 * POST /integrations/google/import
 *
 * Import all Google Docs from a folder as PRD artifacts.
 * Requires folderId and projectId in request body.
 * Returns list of successfully imported artifacts and any failures.
 */
export const POST = withAuth<
  ImportGoogleDocsResponse,
  "/integrations/google/import"
>(async ({ user }, request) => {
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
    user.id
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
});
