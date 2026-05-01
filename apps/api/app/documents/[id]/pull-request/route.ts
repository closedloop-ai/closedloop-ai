import { success } from "@repo/api/src/types/common";
import type { PullRequestInfo } from "@repo/api/src/types/document";
import { NextResponse } from "next/server";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

export const GET = withAnyAuth<
  PullRequestInfo[],
  "/documents/[id]/pull-request"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const pullRequests =
      await documentPullRequestService.getDocumentPullRequests(
        resolvedId,
        user.organizationId
      );

    return NextResponse.json(success(pullRequests));
  } catch (error) {
    return errorResponse("Failed to fetch PRs", error);
  }
});
