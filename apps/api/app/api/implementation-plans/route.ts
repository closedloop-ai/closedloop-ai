import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import type {
  CreateImplementationPlanInput,
  ImplementationPlan,
  ImplementationPlanWithPrd,
} from "@repo/api/src/types/implementation-plan";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

export async function GET(): Promise<
  NextResponse<ApiResult<ImplementationPlanWithPrd[]>>
> {
  try {
    const plans = await database.implementationPlan.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        sourcePrd: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });
    return NextResponse.json(success(plans));
  } catch (error) {
    console.error("Failed to fetch implementation plans:", error);
    return NextResponse.json(failure("Failed to fetch implementation plans"), {
      status: 500,
    });
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<ImplementationPlan>>> {
  try {
    const input: CreateImplementationPlanInput = await request.json();

    // Get the source PRD to generate the title and inherit approver
    const sourcePrd = await database.prd.findUnique({
      where: { id: input.sourcePrdId },
    });

    if (!sourcePrd) {
      return NextResponse.json(failure("Source PRD not found"), {
        status: 404,
      });
    }

    // Count existing plans for this PRD to determine version
    const existingPlansCount = await database.implementationPlan.count({
      where: { sourcePrdId: input.sourcePrdId },
    });

    const version = existingPlansCount + 1;
    const title = `${sourcePrd.title} - Impl Plan`;

    // Use provided approver or inherit from PRD
    const approver = input.approver || sourcePrd.approver;

    const plan = await database.implementationPlan.create({
      data: {
        title,
        sourcePrdId: input.sourcePrdId,
        version,
        planType: input.planType,
        targetRelease: input.targetRelease,
        engineeringTeam: input.engineeringTeam,
        createdBy: input.createdBy,
        approver,
        status: "Draft",
        content: getDefaultContent(sourcePrd.title, version),
      },
    });

    return NextResponse.json(success(plan), { status: 201 });
  } catch (error) {
    console.error("Failed to create implementation plan:", error);
    return NextResponse.json(failure("Failed to create implementation plan"), {
      status: 500,
    });
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
