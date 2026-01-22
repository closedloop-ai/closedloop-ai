import { createId } from "@paralleldrive/cuid2";
import type { Artifact } from "@repo/api/src/types/artifact";
import { failure, success } from "@repo/api/src/types/common";
import { triggerWorkflowDispatch } from "@repo/github";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { notFoundResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

function isGitHubConfigured(): boolean {
  return Boolean(
    process.env.SYMPHONY_APP_ID &&
      process.env.SYMPHONY_APP_PRIVATE_KEY &&
      process.env.GITHUB_WEBHOOK_SECRET &&
      process.env.SYMPHONY_DISPATCH_REPO
  );
}

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

export const POST = withAuth<Artifact, "/artifacts/[id]/regenerate">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    try {
      const artifact = await artifactsService.findWithRegenerationContext(
        id,
        user.organizationId
      );

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
      const repository = workstream.project.repositories[0];
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

      // Fall back to placeholder content when GitHub is not configured
      if (!isGitHubConfigured()) {
        const updatedArtifact = await artifactsService.updateWithPlaceholder(
          id,
          artifact.version,
          getPlaceholderContent(artifact.title, artifact.version + 1)
        );
        return NextResponse.json(success(updatedArtifact as Artifact));
      }

      // Check for existing running job
      const existingRun = await artifactsService.findPendingWorkflowRun(
        workstream.id,
        "symphony-dispatch"
      );

      if (existingRun) {
        return NextResponse.json(
          failure("Plan generation already in progress"),
          { status: 409 }
        );
      }

      const correlationId = createId();

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

      const updatedArtifact =
        await artifactsService.createWorkflowTriggerRecords({
          workstreamId: workstream.id,
          repositoryId: repository.id,
          artifactId: artifact.id,
          correlationId,
          currentVersion: artifact.version,
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
