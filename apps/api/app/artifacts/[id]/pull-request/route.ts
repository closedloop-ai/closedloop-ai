import type { PullRequestInfo } from "@repo/api/src/types/artifact";
import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAuth<
  PullRequestInfo | null,
  "/artifacts/[id]/pull-request"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;

    const pullRequest = await artifactsService.getArtifactPullRequest(
      id,
      user.organizationId
    );

    return NextResponse.json(success(pullRequest));
  } catch (error) {
    return errorResponse("Failed to fetch PR", error);
  }
});
