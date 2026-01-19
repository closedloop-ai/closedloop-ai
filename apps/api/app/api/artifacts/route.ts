import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
  CreateArtifactInput,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

const DEFAULT_ORG_SLUG = "default";
const DEFAULT_PROJECT_NAME = "Default Project";

/**
 * Get or create a default project for standalone artifacts
 */
async function getOrCreateDefaultProject(
  tx: Parameters<Parameters<typeof database.$transaction>[0]>[0]
): Promise<string> {
  // Try to find existing default organization
  let org = await tx.organization.findFirst({
    where: { slug: DEFAULT_ORG_SLUG },
  });

  // Create default org if it doesn't exist
  if (!org) {
    org = await tx.organization.create({
      data: {
        name: "Default Organization",
        slug: DEFAULT_ORG_SLUG,
      },
    });
  }

  // Try to find existing default project
  let project = await tx.project.findFirst({
    where: {
      organizationId: org.id,
      name: DEFAULT_PROJECT_NAME,
    },
  });

  // Create default project if it doesn't exist
  if (!project) {
    project = await tx.project.create({
      data: {
        organizationId: org.id,
        name: DEFAULT_PROJECT_NAME,
        description: "Default project for standalone PRDs and artifacts",
      },
    });
  }

  return project.id;
}

export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<ArtifactWithWorkstream[]>>> {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const latestOnly = searchParams.get("latestOnly") !== "false";
    const workstreamId = searchParams.get("workstreamId");
    const projectId = searchParams.get("projectId");

    const artifacts = await database.artifact.findMany({
      where: {
        ...(type ? { type: type as ArtifactType } : {}),
        ...(latestOnly ? { isLatest: true } : {}),
        ...(workstreamId ? { workstreamId } : {}),
        ...(projectId ? { projectId } : {}),
      },
      include: {
        workstream: {
          select: {
            id: true,
            title: true,
            state: true,
            project: {
              select: { name: true },
            },
          },
        },
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(success(artifacts as ArtifactWithWorkstream[]));
  } catch (error) {
    console.error("Failed to fetch artifacts:", error);
    return NextResponse.json(failure("Failed to fetch artifacts"), {
      status: 500,
    });
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const body = (await request.json()) as CreateArtifactInput;

    // Use transaction to ensure atomic operations
    const artifact = await database.$transaction(async (tx) => {
      // Auto-create default project if no projectId or workstreamId provided
      const projectId =
        body.projectId ||
        (body.workstreamId ? undefined : await getOrCreateDefaultProject(tx));

      // Build the scope condition for this artifact context
      const scopeCondition = {
        ...(body.workstreamId ? { workstreamId: body.workstreamId } : {}),
        ...(projectId ? { projectId } : {}),
        type: body.type,
      };

      // Mark existing artifacts of same type in this scope as not latest
      await tx.artifact.updateMany({
        where: { ...scopeCondition, isLatest: true },
        data: { isLatest: false },
      });

      // Get latest version number for this scope and type
      const latestArtifact = await tx.artifact.findFirst({
        where: scopeCondition,
        orderBy: { version: "desc" },
      });

      return tx.artifact.create({
        data: {
          workstreamId: body.workstreamId,
          projectId,
          type: body.type,
          title: body.title,
          fileName: body.fileName,
          approver: body.approver,
          status: body.status ?? "DRAFT",
          content: body.content,
          externalUrl: body.externalUrl,
          generatedBy: body.generatedBy,
          version: (latestArtifact?.version ?? 0) + 1,
          isLatest: true,
        },
      });
    });

    return NextResponse.json(success(artifact as Artifact));
  } catch (error) {
    console.error("Failed to create artifact:", error);
    return NextResponse.json(failure("Failed to create artifact"), {
      status: 500,
    });
  }
}
