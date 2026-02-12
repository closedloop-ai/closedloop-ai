import type { ImportGoogleDocsResponse } from "@repo/api/src/types/google";
import { ZodError } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
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
  try {
    // Parse and validate request body
    const body = await request.json();

    let validatedInput: { folderId: string; projectId: string };
    try {
      validatedInput = importGoogleDocsValidator.parse(body);
    } catch (error) {
      if (error instanceof ZodError) {
        const firstError = error.issues[0];
        return errorResponse(
          firstError?.message || "Invalid input",
          error,
          400
        );
      }
      throw error;
    }

    // Call service to import docs
    const result = await googleService.importDocsFromFolder(
      validatedInput.folderId,
      validatedInput.projectId,
      user.organizationId,
      user.id
    );

    if (!result.success) {
      return errorResponse(result.error, new Error(result.error), 400);
    }

    return successResponse({
      importedCount: result.importedCount,
      artifacts: result.artifacts,
      failures: result.failures,
    });
  } catch (error) {
    return errorResponse("Failed to import Google Docs", error);
  }
});
