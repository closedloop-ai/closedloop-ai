import { createId } from "@paralleldrive/cuid2";
import type { Artifact } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import { triggerWorkflowDispatch } from "@repo/github";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { notFoundResponse } from "@/lib/route-utils";

function isGitHubConfigured(): boolean {
  // Check env vars directly to avoid build-time validation errors
  return Boolean(
    process.env.SYMPHONY_APP_ID &&
      process.env.SYMPHONY_APP_PRIVATE_KEY &&
      process.env.GITHUB_WEBHOOK_SECRET &&
      process.env.SYMPHONY_DISPATCH_REPO
  );
}

/**
 * Build context for plan generation from PRD content and optional initial instructions.
 * Appends "assume defaults" instruction to skip Q&A flow.
 */
/**
 * Build context for plan generation from PRD content and optional initial instructions.
 * Appends "assume defaults" instruction to skip Q&A flow.
 */
function buildPlanContext(
  prdContent: string,
  initialInstructions: string | null
): string {
  let context = prdContent;

  // Add initial instructions if provided and not a failure message
  if (
    initialInstructions?.trim() &&
    !initialInstructions.startsWith("# Plan Generation Failed")
  ) {
    context += `

---

## Additional Instructions

${initialInstructions.trim()}`;
  }

  // Always append "assume defaults" instruction
  context += `

---

**Important:** For the implementation plan, please assume reasonable defaults for any questions that arise. You may document those as open questions in the plan for further iteration, but do not ask for clarification - proceed with your best judgment.`;

  return context;
}

/**
 * Find or create a workstream for the artifact.
 * If artifact has no workstream, finds PRD by title match and auto-creates one.
 */
async function findOrCreateWorkstream(
  artifact: {
    id: string;
    title: string;
    projectId: string | null;
    parentId: string | null;
    workstream: Awaited<
      ReturnType<typeof database.workstream.findUnique>
    > | null;
  },
  userId: string
) {
  // If workstream exists, return it with PRD
  if (artifact.workstream) {
    const prdArtifact = await database.artifact.findFirst({
      where: {
        workstreamId: artifact.workstream.id,
        type: "PRD",
        isLatest: true,
      },
    });
    return { workstream: artifact.workstream, prdArtifact };
  }

  // Find PRD by parentId or matching title
  const prdTitle = artifact.title.replace("Implementation Plan: ", "");
  const foundPrd = await database.artifact.findFirst({
    where: {
      projectId: artifact.projectId,
      type: "PRD",
      isLatest: true,
      OR: [{ id: artifact.parentId ?? undefined }, { title: prdTitle }],
    },
  });

  if (!(foundPrd?.content && artifact.projectId)) {
    return { workstream: null, prdArtifact: foundPrd };
  }

  // Auto-create workstream
  const newWorkstream = await database.workstream.create({
    data: {
      projectId: artifact.projectId,
      title: foundPrd.title,
      description: `Auto-created for: ${foundPrd.title}`,
      type: "FEATURE_DELIVERY",
      createdById: userId,
    },
  });

  // Link artifacts to workstream
  await database.artifact.updateMany({
    where: { id: { in: [foundPrd.id, artifact.id] } },
    data: { workstreamId: newWorkstream.id },
  });

  // Fetch workstream with relations
  const workstream = await database.workstream.findUnique({
    where: { id: newWorkstream.id },
    include: {
      project: {
        include: {
          repositories: { where: { isPrimary: true }, take: 1 },
        },
      },
      artifacts: { where: { type: "PRD", isLatest: true }, take: 1 },
    },
  });

  return { workstream, prdArtifact: foundPrd };
}

export const POST = withAuth<Artifact, "/artifacts/[id]/regenerate">(
  async (
    { user },
    _request,
    params
  ): Promise<NextResponse<ApiResult<Artifact>>> => {
    const { id } = await params;

    try {
      // Find the artifact with its workstream and project
      // Include PRD's targetRepo/targetBranch for plan generation
      const artifact = await database.artifact.findUnique({
        where: { id, project: { organizationId: user.organizationId } },
        include: {
          workstream: {
            include: {
              project: {
                include: {
                  repositories: {
                    where: { isPrimary: true },
                    take: 1,
                  },
                },
              },
              artifacts: {
                where: { type: "PRD", isLatest: true },
                take: 1,
              },
            },
          },
        },
      });

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      if (artifact.type !== "IMPLEMENTATION_PLAN") {
        return NextResponse.json(
          failure("Only implementation plans can be regenerated"),
          { status: 400 }
        );
      }

      // Find or create workstream with PRD
      const { workstream, prdArtifact } = await findOrCreateWorkstream(
        artifact,
        user.id
      );

      if (!prdArtifact?.content) {
        return NextResponse.json(
          failure("No PRD found to generate plan from. Create a PRD first."),
          { status: 400 }
        );
      }

      if (!workstream) {
        return NextResponse.json(
          failure("Artifact must have a project to regenerate"),
          { status: 400 }
        );
      }

      const project = workstream.project;
      const repository = project.repositories[0];

      // Use PRD's target repo (fallback to project's primary)
      const targetRepo = prdArtifact.targetRepo ?? repository?.fullName;
      const targetBranch =
        prdArtifact.targetBranch ?? repository?.defaultBranch ?? "main";

      if (!targetRepo) {
        return NextResponse.json(
          failure("No repository configured for this project or PRD"),
          { status: 400 }
        );
      }

      // Check if GitHub is configured
      if (!isGitHubConfigured()) {
        // Fall back to placeholder content
        const updatedArtifact = await database.artifact.update({
          where: { id },
          data: {
            version: artifact.version + 1,
            status: "DRAFT",
            content: getPlaceholderContent(
              artifact.title,
              artifact.version + 1
            ),
          },
        });
        return NextResponse.json(success(updatedArtifact as Artifact));
      }

      // Check for existing running job
      const existingRun = await database.gitHubActionRun.findFirst({
        where: {
          workstreamId: workstream.id,
          workflowName: "symphony-dispatch",
          status: { in: ["PENDING", "QUEUED", "RUNNING"] },
        },
      });

      if (existingRun) {
        return NextResponse.json(
          failure("Plan generation already in progress"),
          {
            status: 409,
          }
        );
      }

      // Generate correlation ID
      const correlationId = createId();

      // Build context: PRD content + initial instructions (artifact.content) + "assume defaults"
      const context = buildPlanContext(prdArtifact.content, artifact.content);

      // Trigger the workflow
      const result = await triggerWorkflowDispatch({
        targetRepo,
        ref: targetBranch,
        command: "plan",
        context,
        correlationId,
        sessionId: prdArtifact.id, // PRD ID for artifact naming
      });

      if (!result.success) {
        return NextResponse.json(
          failure(`Failed to trigger plan generation: ${result.error}`),
          { status: 500 }
        );
      }

      // Create GitHubActionRun record to track the job
      await database.gitHubActionRun.create({
        data: {
          workstreamId: workstream.id,
          repositoryId: repository?.id ?? "",
          runId: BigInt(0), // Will be updated when we get the actual run ID
          workflowName: "symphony-dispatch",
          status: "PENDING",
          htmlUrl: "",
          triggerEvent: "workflow_dispatch",
          triggerData: {
            correlationId: `${process.env.WEBAPP_ENV}-${correlationId}`,
            artifactId: artifact.id,
            prdId: prdArtifact.id,
            command: "plan",
          },
          sessionId: prdArtifact.id,
          jobType: "generate",
          startedAt: new Date(),
        },
      });

      // Update artifact to show it's being regenerated
      const updatedArtifact = await database.artifact.update({
        where: { id },
        data: {
          version: artifact.version + 1,
          status: "DRAFT",
          generatedBy: `symphony-dispatch:${correlationId}`,
        },
      });

      // Create workstream event
      await database.workstreamEvent.create({
        data: {
          workstreamId: workstream.id,
          type: "GITHUB_ACTION_TRIGGERED",
          actorType: "system",
          data: {
            workflowName: "symphony-dispatch",
            command: "plan",
            correlationId,
            artifactId: artifact.id,
            prdId: prdArtifact.id,
            targetRepo,
            targetBranch,
          },
        },
      });

      return NextResponse.json(success(updatedArtifact as Artifact));
    } catch (error) {
      console.error("Failed to regenerate artifact:", error);
      return NextResponse.json(failure("Failed to regenerate artifact"), {
        status: 500,
      });
    }
  }
);

function getPlaceholderContent(title: string, version: number): string {
  return `# Implementation Plan: ${title}

## Overview

This implementation plan outlines the technical approach for ${title}.

**Version:** v${version}
**Status:** Generating...

## Note

GitHub Actions integration is not configured. This is placeholder content.
Configure the following environment variables to enable plan generation:
- SYMPHONY_APP_ID
- SYMPHONY_APP_PRIVATE_KEY
- GITHUB_WEBHOOK_SECRET
- SYMPHONY_DISPATCH_REPO
- WEBAPP_ENV
`;
}
