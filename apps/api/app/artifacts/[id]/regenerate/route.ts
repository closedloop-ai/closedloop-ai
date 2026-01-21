import { createId } from "@paralleldrive/cuid2";
import type { Artifact } from "@repo/api/src/types/artifact";
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

export const POST = withAuth<Artifact, "/artifacts/[id]/regenerate">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    try {
      // Find the artifact with its workstream and project
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

      if (!artifact.workstream) {
        return NextResponse.json(
          failure("Artifact must be linked to a workstream to regenerate"),
          { status: 400 }
        );
      }

      const { workstream } = artifact;
      const project = workstream.project;
      const repository = project.repositories[0];
      const prdArtifact = workstream.artifacts[0];

      if (!repository) {
        return NextResponse.json(
          failure("No repository configured for this project"),
          { status: 400 }
        );
      }

      if (!prdArtifact?.content) {
        return NextResponse.json(
          failure("No PRD found in this workstream to generate plan from"),
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
          status: { in: ["PENDING", "RUNNING"] },
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

      // Trigger the workflow
      const result = await triggerWorkflowDispatch({
        targetRepo: repository.fullName,
        ref: repository.defaultBranch,
        command: "plan",
        context: prdArtifact.content,
        correlationId,
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
          repositoryId: repository.id,
          runId: BigInt(0), // Will be updated when we get the actual run ID
          workflowName: "symphony-dispatch",
          status: "PENDING",
          htmlUrl: "",
          triggerEvent: "workflow_dispatch",
          triggerData: {
            correlationId,
            artifactId: artifact.id,
            command: "plan",
          },
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
