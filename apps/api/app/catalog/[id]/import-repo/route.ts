import "server-only";

import type { ImportPackZipResponse } from "@repo/api/src/types/distribution";
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
import {
  RepoComponentsTruncatedError,
  RepoTreeTruncatedError,
} from "../../pack-repo-import";
import { importPackRepoComponents } from "../../service";
import { importPackRepoBodySchema } from "../../validators";

/**
 * POST /catalog/{id}/import-repo
 *
 * Admin-only. Import components from a GitHub repo the org has App visibility to
 * (canonical Claude Code layout), optionally under a subpath. Returns
 * { created, skipped }.
 */
export const POST = withAnyAuth<
  ImportPackZipResponse,
  "/catalog/[id]/import-repo"
>(async ({ user, clerkOrgId, clerkUserId }, request, params) => {
  const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
  if (!adminCheck) {
    return forbiddenResponse();
  }

  const { id } = await params;

  const { body, errorResponse: parseError } = await parseBody(
    request,
    importPackRepoBodySchema
  );
  if (parseError) {
    return parseError;
  }

  try {
    const result = await importPackRepoComponents({
      id,
      organizationId: user.organizationId,
      userId: user.id,
      repoFullName: body.repoFullName,
      ref: body.ref,
      subPath: body.subPath,
    });

    if (!result.ok) {
      if (result.error === 404) {
        return notFoundResponse("Pack");
      }
      if (result.error === 400) {
        return badRequestResponse(
          "Repository not found in your org's GitHub App installation"
        );
      }
      return forbiddenResponse();
    }

    return successResponse(result.value);
  } catch (error) {
    // A truncated GitHub tree — or a candidate set that exceeds the import cap —
    // is an actionable, client-fixable condition (the repo is too large to
    // import in full — narrow it with a subPath). Surface that guidance as a 422
    // instead of collapsing it into a generic 500 that leaves the admin with no
    // next step (and, for the candidate cap, no silent partial import).
    if (
      error instanceof RepoTreeTruncatedError ||
      error instanceof RepoComponentsTruncatedError
    ) {
      return errorResponse(error.message, error, 422);
    }
    return errorResponse("Failed to import from repo", error);
  }
});
