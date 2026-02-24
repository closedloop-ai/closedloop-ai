import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { notFoundResponse } from "@/lib/route-utils";

const NONE_STATUS: GenerationStatus = {
  status: "NONE",
  command: null,
  htmlUrl: null,
  startedAt: null,
  completedAt: null,
  correlationId: null,
};

/** Map LoopStatus (Prisma enum) to GenerationStatus status field. */
function mapLoopStatus(loopStatus: string): GenerationStatus["status"] | null {
  switch (loopStatus) {
    case "PENDING":
      return "PENDING";
    case "CLAIMED":
      return "QUEUED";
    case "RUNNING":
      return "RUNNING";
    case "COMPLETED":
      return "SUCCESS";
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
      return "FAILURE";
    default:
      return null;
  }
}

/** Map LoopCommand (Prisma enum, UPPER_CASE) to GenerationStatus command (lowercase). */
function mapLoopCommand(command: string): GenerationStatus["command"] {
  switch (command) {
    case "PLAN":
      return "plan";
    case "EXECUTE":
      return "execute";
    case "CHAT":
      return "chat";
    case "EXPLORE":
      return "explore";
    case "REQUEST_CHANGES":
      return "request_changes";
    default:
      return null;
  }
}

/** Fetch the latest GitHub Actions generation status for an artifact. */
async function fetchGitHubActionsStatus(
  workstreamId: string,
  artifactId: string
): Promise<GenerationStatus | null> {
  const actionRun = await withDb((db) =>
    db.gitHubActionRun.findFirst({
      where: { workstreamId, workflowName: "symphony-dispatch" },
      orderBy: { createdAt: "desc" },
    })
  );

  if (!actionRun) {
    return null;
  }

  const triggerData = actionRun.triggerData as {
    correlationId?: string;
    artifactId?: string;
    command?: "plan" | "execute" | "chat";
  } | null;

  if (triggerData?.artifactId !== artifactId) {
    return null;
  }

  return {
    status: actionRun.status as GenerationStatus["status"],
    command: triggerData?.command ?? null,
    htmlUrl: actionRun.htmlUrl || null,
    startedAt: actionRun.startedAt,
    completedAt: actionRun.completedAt,
    correlationId: triggerData?.correlationId ?? null,
    source: "github_actions",
  };
}

/** Fetch the latest Loop generation status for an artifact. */
async function fetchLoopStatus(
  artifactId: string
): Promise<GenerationStatus | null> {
  const loop = await withDb((db) =>
    db.loop.findFirst({
      where: { artifactId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        command: true,
        startedAt: true,
        completedAt: true,
        user: {
          select: { firstName: true, lastName: true, avatarUrl: true },
        },
      },
    })
  );

  if (!loop) {
    return null;
  }

  const mappedStatus = mapLoopStatus(loop.status);
  if (!mappedStatus) {
    return null;
  }

  return {
    status: mappedStatus,
    command: mapLoopCommand(loop.command),
    htmlUrl: null,
    startedAt: loop.startedAt,
    completedAt: loop.completedAt,
    correlationId: null,
    source: "loop",
    loopId: loop.id,
    initiatedBy: loop.user,
  };
}

/** Pick the best status: prefer active, then most recent terminal. */
function pickBestStatus(
  a: GenerationStatus | null,
  b: GenerationStatus | null
): GenerationStatus {
  if (a && b) {
    const aActive = isActiveGenerationStatus(a.status);
    const bActive = isActiveGenerationStatus(b.status);

    if (aActive && !bActive) {
      return a;
    }
    if (bActive && !aActive) {
      return b;
    }
    // Both active or both terminal — pick most recent by startedAt
    const aTime = a.startedAt?.getTime() ?? 0;
    const bTime = b.startedAt?.getTime() ?? 0;
    return bTime >= aTime ? b : a;
  }

  return a ?? b ?? NONE_STATUS;
}

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
      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id, organizationId: user.organizationId },
          select: { id: true, workstreamId: true, generatedBy: true },
        })
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      const ghStatus = artifact.workstreamId
        ? await fetchGitHubActionsStatus(artifact.workstreamId, artifact.id)
        : null;
      const loopStatus = await fetchLoopStatus(artifact.id);
      const result = pickBestStatus(ghStatus, loopStatus);

      return NextResponse.json(success(result));
    } catch (error) {
      console.error("Failed to fetch generation status:", error);
      return NextResponse.json(failure("Failed to fetch generation status"), {
        status: 500,
      });
    }
  }
);
