import type { ExportToLinearResult } from "@repo/api/src/types/linear";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { linearService } from "../service";
import { exportToLinearValidator } from "../validators";

/**
 * POST /integrations/linear/export
 *
 * Export an approved implementation plan to Linear as individual issues.
 */
export const POST = withAuth<
  ExportToLinearResult,
  "/integrations/linear/export"
>(async ({ user }, request) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      exportToLinearValidator
    );
    if (parseError) {
      return parseError;
    }

    const { documentId, teamId } = body;

    const result = await linearService.exportImplementationPlan(
      documentId,
      teamId,
      user.organizationId,
      user.id
    );

    if (!result.success) {
      switch (result.status) {
        case 404:
          return notFoundResponse("Artifact");
        case 502:
          return errorResponse("Linear API error", new Error(result.error));
        default:
          return badRequestResponse(result.error);
      }
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to export to Linear", error);
  }
});
