import { listDocsInFolder } from "@repo/google";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { ensureValidAccessToken, googleService } from "../service";

const FOLDER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * GET /integrations/google/files
 *
 * List Google Docs in a specific folder.
 * Requires folderId as a query parameter.
 * Returns list of files with id and name.
 */
export const GET = withAnyAuth<
  Array<{ id: string; name: string }>,
  "/integrations/google/files"
>(async ({ user }, request) => {
  const folderId = request.nextUrl.searchParams.get("folderId");

  if (!folderId) {
    return badRequestResponse("folderId is required");
  }

  if (!FOLDER_ID_REGEX.test(folderId)) {
    return badRequestResponse("Invalid folderId format");
  }

  const integration = await googleService.getIntegration(user.organizationId);

  if (!integration) {
    return badRequestResponse("Google Drive is not connected");
  }

  const tokenResult = await ensureValidAccessToken(
    integration,
    user.organizationId,
    "[google/files]"
  );

  if (!tokenResult.success) {
    return errorResponse(tokenResult.error, null, 401);
  }

  try {
    const docs = await listDocsInFolder(folderId, tokenResult.accessToken);
    return successResponse(docs.map((d) => ({ id: d.id, name: d.name })));
  } catch (error) {
    const errorMsg = String(error);

    if (errorMsg.includes("404") || errorMsg.includes("not found")) {
      return errorResponse("Folder not found", null, 404);
    }

    if (errorMsg.includes("403") || errorMsg.includes("Permission denied")) {
      return errorResponse("Folder not accessible", null, 403);
    }

    return errorResponse("Failed to list files in folder", error);
  }
});
