import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import type { ImplementationPlan } from "@repo/api/src/types/implementation-plan";
import { database } from "@repo/database";
import { triggerWorkflowDispatch, keys as githubKeys } from "@repo/github";
import { NextResponse } from "next/server";
import { createId } from "@paralleldrive/cuid2";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<ImplementationPlan>>> {
  const { id } = await params;

  try {
    const plan = await database.implementationPlan.findUnique({
      where: { id },
      include: { sourcePrd: true },
    });

    if (!plan) {
      return NextResponse.json(failure("Implementation plan not found"), {
        status: 404,
      });
    }

    // Check if GitHub integration is configured
    let githubConfigured = true;
    try {
      githubKeys();
    } catch {
      githubConfigured = false;
    }

    if (!githubConfigured) {
      // Fall back to placeholder content if GitHub not configured
      const updatedPlan = await database.implementationPlan.update({
        where: { id },
        data: {
          version: plan.version + 1,
          status: "Draft",
          content: getDefaultContent(plan.sourcePrd.title, plan.version + 1),
        },
      });
      return NextResponse.json(success(updatedPlan));
    }

    // Check if there's already a job running
    if (plan.jobStatus === "running") {
      return NextResponse.json(
        failure("Plan generation already in progress"),
        { status: 409 }
      );
    }

    // Generate correlation ID for tracking
    const correlationId = createId();

    // Require target repo to be set
    if (!plan.targetRepo) {
      return NextResponse.json(
        failure("Target repository must be set before generating a plan"),
        { status: 400 }
      );
    }

    // Trigger the workflow
    const result = await triggerWorkflowDispatch({
      targetRepo: plan.targetRepo,
      ref: plan.targetRef || "main",
      command: "plan",
      context: plan.sourcePrd.content,
      correlationId,
    });

    if (!result.success) {
      return NextResponse.json(
        failure(`Failed to trigger plan generation: ${result.error}`),
        { status: 500 }
      );
    }

    // Update the plan with job tracking info
    const updatedPlan = await database.implementationPlan.update({
      where: { id },
      data: {
        version: plan.version + 1,
        status: "Generating",
        jobStatus: "running",
        correlationId,
        jobStartedAt: new Date(),
        jobCompletedAt: null,
        // Clear previous artifacts
        artifactUrl: null,
        artifactKeys: [],
      },
    });

    return NextResponse.json(success(updatedPlan));
  } catch (error) {
    console.error("Failed to regenerate implementation plan:", error);
    return NextResponse.json(
      failure("Failed to regenerate implementation plan"),
      { status: 500 }
    );
  }
}

function getDefaultContent(prdTitle: string, version: number): string {
  return `# Implementation Plan: ${prdTitle}

## Overview

This implementation plan outlines the technical approach for ${prdTitle}.

**Version:** v${version}

## Milestones

- [ ] Milestone 1: Initial setup and scaffolding
- [ ] Milestone 2: Core implementation

## Work Breakdown

### Task 1: Setup

- Subtask 1.1
- Subtask 1.2

### Task 2: Implementation

- Subtask 2.1
- Subtask 2.2

## Dependencies

- Dependency 1
- Dependency 2

## Risks

- Risk 1: Mitigation strategy
- Risk 2: Mitigation strategy

## Testing Plan

- Unit tests
- Integration tests
- E2E tests

## Rollout Plan

- Phase 1: Internal testing
- Phase 2: Beta release
- Phase 3: General availability
`;
}
