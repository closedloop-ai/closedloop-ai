"use server";

import { database } from "@repo/database";
import type { ImplementationPlan, PRD } from "@repo/database/generated/client";
import { revalidatePath } from "next/cache";
import {
  type ActionResult,
  failure,
  type ImplPlanStatus,
  type ImplPlanType,
  success,
} from "@/lib/types";

type ImplementationPlanWithPRD = ImplementationPlan & {
  sourcePrd: Pick<PRD, "id" | "title">;
};

export type CreateImplementationPlanInput = {
  sourcePrdId: string;
  planType: ImplPlanType;
  targetRelease?: string;
  engineeringTeam?: string;
  createdBy: string;
  approver?: string;
};

export type UpdateImplementationPlanInput = {
  id: string;
  title?: string;
  status?: ImplPlanStatus;
  content?: string;
  approver?: string;
  planType?: ImplPlanType;
  targetRelease?: string;
  engineeringTeam?: string;
};

export async function getImplementationPlans(): Promise<
  ActionResult<ImplementationPlanWithPRD[]>
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
    return success(plans);
  } catch (error) {
    console.error("Failed to fetch implementation plans:", error);
    return failure("Failed to fetch implementation plans");
  }
}

export async function getImplementationPlanById(
  id: string
): Promise<ActionResult<ImplementationPlanWithPRD>> {
  try {
    const plan = await database.implementationPlan.findUnique({
      where: { id },
      include: {
        sourcePrd: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });
    if (!plan) {
      return failure("Implementation plan not found");
    }
    return success(plan);
  } catch (error) {
    console.error("Failed to fetch implementation plan:", error);
    return failure("Failed to fetch implementation plan");
  }
}

export async function createImplementationPlan(
  input: CreateImplementationPlanInput
): Promise<ActionResult<ImplementationPlan>> {
  try {
    // Get the source PRD to generate the title and inherit approver
    const sourcePrd = await database.pRD.findUnique({
      where: { id: input.sourcePrdId },
    });

    if (!sourcePrd) {
      return failure("Source PRD not found");
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

    revalidatePath("/implementation-plans");
    return success(plan);
  } catch (error) {
    console.error("Failed to create implementation plan:", error);
    return failure("Failed to create implementation plan");
  }
}

export async function updateImplementationPlan(
  input: UpdateImplementationPlanInput
): Promise<ActionResult<ImplementationPlan>> {
  try {
    const { id, ...data } = input;
    const plan = await database.implementationPlan.update({
      where: { id },
      data,
    });
    revalidatePath("/implementation-plans");
    revalidatePath(`/implementation-plans/${id}`);
    return success(plan);
  } catch (error) {
    console.error("Failed to update implementation plan:", error);
    return failure("Failed to update implementation plan");
  }
}

export async function deleteImplementationPlan(
  id: string
): Promise<ActionResult<{ deleted: true }>> {
  try {
    await database.implementationPlan.delete({
      where: { id },
    });
    revalidatePath("/implementation-plans");
    return success({ deleted: true });
  } catch (error) {
    console.error("Failed to delete implementation plan:", error);
    return failure("Failed to delete implementation plan");
  }
}

export async function regenerateImplementationPlan(
  id: string
): Promise<ActionResult<ImplementationPlan>> {
  try {
    const plan = await database.implementationPlan.findUnique({
      where: { id },
      include: { sourcePrd: true },
    });

    if (!plan) {
      return failure("Implementation plan not found");
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

    revalidatePath("/implementation-plans");
    revalidatePath(`/implementation-plans/${id}`);
    return success(updatedPlan);
  } catch (error) {
    console.error("Failed to regenerate implementation plan:", error);
    return failure("Failed to regenerate implementation plan");
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
