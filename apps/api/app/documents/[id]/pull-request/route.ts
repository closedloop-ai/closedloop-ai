import { success } from "@repo/api/src/types/common";
import type { PullRequestInfo } from "@repo/api/src/types/document";
import { NextResponse } from "next/server";
import { documentWorkstreamService } from "@/app/documents/workstream-service";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

export const GET = withAuth<
  PullRequestInfo | null,
  "/documents/[id]/pull-request"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const pullRequest = await documentWorkstreamService.getDocumentPullRequest(
      resolvedId,
      user.organizationId
    );

    return NextResponse.json(success(pullRequest));
  } catch (error) {
    return errorResponse("Failed to fetch PR", error);
  }
});
