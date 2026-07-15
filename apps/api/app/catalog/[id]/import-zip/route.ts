import "server-only";

import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  payloadTooLargeResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  type ImportPackZipResult,
  importPackZipComponents,
} from "../../service";

/**
 * POST /catalog/{id}/import-zip
 *
 * Admin-only. Parse the Pack's uploaded zip (canonical Claude Code layout) and
 * create a child component for each recognized file, skipping ones already
 * present and rejecting ones that fail create-path validation.
 * Returns { created, skipped, invalid }.
 */
export const POST = withAnyAuth<
  ImportPackZipResult,
  "/catalog/[id]/import-zip"
>(async ({ user, clerkOrgId, clerkUserId }, _request, params) => {
  const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
  if (!adminCheck) {
    return forbiddenResponse();
  }

  const { id } = await params;

  try {
    const result = await importPackZipComponents({
      id,
      organizationId: user.organizationId,
      userId: user.id,
    });

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

    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to import Pack zip", error);
  }
});
