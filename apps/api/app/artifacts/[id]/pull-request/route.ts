import { success } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

type PullRequestInfo = {
  id: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headBranch: string;
  baseBranch: string;
  createdAt: Date;
};

export const GET = withAuth<
  PullRequestInfo | null,
  "/artifacts/[id]/pull-request"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;

    // First, get the artifact to find its workstreamId
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId: user.organizationId },
        select: { workstreamId: true },
      })
    );

    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    if (!artifact.workstreamId) {
      // No workstream means no PR - return null (not an error)
      return NextResponse.json(success(null));
    }

    // Find the most recent PR for this workstream
    const pr = await withDb((db) =>
      db.gitHubPullRequest.findFirst({
        where: { workstreamId: artifact.workstreamId as string },
        orderBy: { createdAt: "desc" },
      })
    );

    if (!pr) {
      // No PR yet - return null (not an error)
      return NextResponse.json(success(null));
    }

    const response: PullRequestInfo = {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.htmlUrl,
      state: pr.state,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      createdAt: pr.createdAt,
    };

    return NextResponse.json(success(response));
  } catch (error) {
    return errorResponse("Failed to fetch PR", error);
  }
});
