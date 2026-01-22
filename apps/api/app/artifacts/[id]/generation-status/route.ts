import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { notFoundResponse } from "@/lib/route-utils";

export type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
};

export const GET = withAuth<
  GenerationStatus,
  "/artifacts/[id]/generation-status"
>(
  async (
    { user },
    _request,
    params
  ): Promise<NextResponse<ApiResult<GenerationStatus>>> => {
    const { id } = await params;

    try {
      // Find the artifact with its workstream
      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id, project: { organizationId: user.organizationId } },
          select: {
            id: true,
            workstreamId: true,
            generatedBy: true,
          },
        })
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      // If no workstream, can't have generation status
      if (!artifact.workstreamId) {
        return NextResponse.json(
          success({
            status: "NONE",
            htmlUrl: null,
            startedAt: null,
            completedAt: null,
            correlationId: null,
          })
        );
      }

      // Find the latest GitHubActionRun for this workstream's symphony-dispatch workflow
      const actionRun = await withDb((db) =>
        db.gitHubActionRun.findFirst({
          where: {
            workstreamId: artifact.workstreamId as string,
            workflowName: "symphony-dispatch",
          },
          orderBy: { createdAt: "desc" },
        })
      );

      if (!actionRun) {
        return NextResponse.json(
          success({
            status: "NONE",
            htmlUrl: null,
            startedAt: null,
            completedAt: null,
            correlationId: null,
          })
        );
      }

      // Extract correlation ID from triggerData
      const triggerData = actionRun.triggerData as {
        correlationId?: string;
        artifactId?: string;
      } | null;

      // Only return status if this run is for the requested artifact
      if (triggerData?.artifactId !== artifact.id) {
        return NextResponse.json(
          success({
            status: "NONE",
            htmlUrl: null,
            startedAt: null,
            completedAt: null,
            correlationId: null,
          })
        );
      }

      return NextResponse.json(
        success({
          status: actionRun.status as GenerationStatus["status"],
          htmlUrl: actionRun.htmlUrl || null,
          startedAt: actionRun.startedAt,
          completedAt: actionRun.completedAt,
          correlationId: triggerData?.correlationId ?? null,
        })
      );
    } catch (error) {
      console.error("Failed to fetch generation status:", error);
      return NextResponse.json(failure("Failed to fetch generation status"), {
        status: 500,
      });
    }
  }
);
