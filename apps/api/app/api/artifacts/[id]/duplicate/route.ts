import type { Artifact } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const { id } = await params;

    // Find the original artifact
    const original = await database.artifact.findUnique({
      where: { id },
    });

    if (!original) {
      return NextResponse.json(failure("Artifact not found"), { status: 404 });
    }

    // Get the next version number for this artifact type in the same context
    const latestArtifact = await database.artifact.findFirst({
      where: {
        ...(original.workstreamId
          ? { workstreamId: original.workstreamId }
          : {}),
        ...(original.projectId ? { projectId: original.projectId } : {}),
        type: original.type,
      },
      orderBy: { version: "desc" },
    });

    // Create a duplicate with a new title, marking previous versions as not latest
    const duplicate = await database.$transaction(async (tx) => {
      // Mark all existing versions as not latest
      await tx.artifact.updateMany({
        where: {
          ...(original.workstreamId
            ? { workstreamId: original.workstreamId }
            : {}),
          ...(original.projectId ? { projectId: original.projectId } : {}),
          type: original.type,
          isLatest: true,
        },
        data: { isLatest: false },
      });

      // Create the new duplicate
      return tx.artifact.create({
        data: {
          workstreamId: original.workstreamId,
          projectId: original.projectId,
          type: original.type,
          title: `${original.title} (Copy)`,
          fileName: original.fileName
            ? original.fileName.replace(".md", "-copy.md")
            : null,
          approver: original.approver,
          status: "DRAFT",
          content: original.content,
          externalUrl: original.externalUrl,
          generatedBy: original.generatedBy,
          version: (latestArtifact?.version ?? 0) + 1,
          isLatest: true,
        },
      });
    });

    return NextResponse.json(success(duplicate as Artifact));
  } catch (error) {
    console.error("Failed to duplicate artifact:", error);
    return NextResponse.json(failure("Failed to duplicate artifact"), {
      status: 500,
    });
  }
}
