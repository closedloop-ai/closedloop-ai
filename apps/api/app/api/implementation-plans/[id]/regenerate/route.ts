import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import type { ImplementationPlan } from "@repo/api/src/types/implementation-plan";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

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

    // For now, just increment version and update timestamp
    // TODO: Actually regenerate content based on PRD
    const updatedPlan = await database.implementationPlan.update({
      where: { id },
      data: {
        version: plan.version + 1,
        content: getDefaultContent(plan.sourcePrd.title, plan.version + 1),
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
