"use server";

import { database } from "@repo/database";
import type { PRD } from "@repo/database/generated/client";
import { revalidatePath } from "next/cache";
import {
  type ActionResult,
  failure,
  type PRDStatus,
  type PRDTemplate,
  success,
} from "@/lib/types";

export type CreatePRDInput = {
  title: string;
  fileName: string;
  approver: string;
  status: PRDStatus;
  tags: string[];
  template: PRDTemplate;
  content?: string;
};

export type UpdatePRDInput = {
  id: string;
  title?: string;
  fileName?: string;
  approver?: string;
  status?: PRDStatus;
  tags?: string[];
  template?: PRDTemplate;
  content?: string;
};

export async function getPRDs(): Promise<ActionResult<PRD[]>> {
  try {
    const prds = await database.pRD.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return success(prds);
  } catch (error) {
    console.error("Failed to fetch PRDs:", error);
    return failure("Failed to fetch PRDs");
  }
}

export async function getPRDById(id: string): Promise<ActionResult<PRD>> {
  try {
    const prd = await database.pRD.findUnique({
      where: { id },
    });
    if (!prd) {
      return failure("PRD not found");
    }
    return success(prd);
  } catch (error) {
    console.error("Failed to fetch PRD:", error);
    return failure("Failed to fetch PRD");
  }
}

export async function createPRD(
  input: CreatePRDInput
): Promise<ActionResult<PRD>> {
  try {
    const prd = await database.pRD.create({
      data: {
        title: input.title,
        fileName: input.fileName,
        approver: input.approver,
        status: input.status,
        tags: input.tags,
        template: input.template,
        content:
          input.content ?? getDefaultContent(input.title, input.template),
      },
    });
    revalidatePath("/prds");
    return success(prd);
  } catch (error) {
    console.error("Failed to create PRD:", error);
    return failure("Failed to create PRD");
  }
}

export async function updatePRD(
  input: UpdatePRDInput
): Promise<ActionResult<PRD>> {
  try {
    const { id, ...data } = input;
    const prd = await database.pRD.update({
      where: { id },
      data,
    });
    revalidatePath("/prds");
    revalidatePath(`/prds/${id}`);
    return success(prd);
  } catch (error) {
    console.error("Failed to update PRD:", error);
    return failure("Failed to update PRD");
  }
}

export async function deletePRD(
  id: string
): Promise<ActionResult<{ deleted: true }>> {
  try {
    await database.pRD.delete({
      where: { id },
    });
    revalidatePath("/prds");
    return success({ deleted: true });
  } catch (error) {
    console.error("Failed to delete PRD:", error);
    return failure("Failed to delete PRD");
  }
}

export async function duplicatePRD(id: string): Promise<ActionResult<PRD>> {
  try {
    const original = await database.pRD.findUnique({
      where: { id },
    });

    if (!original) {
      return failure("PRD not found");
    }

    const prd = await database.pRD.create({
      data: {
        title: `${original.title} (Copy)`,
        fileName: `${original.fileName.replace(".md", "")}-copy.md`,
        approver: original.approver,
        status: "Draft",
        tags: original.tags,
        template: original.template,
        content: original.content,
      },
    });

    revalidatePath("/prds");
    return success(prd);
  } catch (error) {
    console.error("Failed to duplicate PRD:", error);
    return failure("Failed to duplicate PRD");
  }
}

export async function renamePRD(
  id: string,
  title: string,
  fileName: string
): Promise<ActionResult<PRD>> {
  try {
    const prd = await database.pRD.update({
      where: { id },
      data: { title, fileName },
    });
    revalidatePath("/prds");
    revalidatePath(`/prds/${id}`);
    return success(prd);
  } catch (error) {
    console.error("Failed to rename PRD:", error);
    return failure("Failed to rename PRD");
  }
}

function getDefaultContent(title: string, template: string): string {
  if (template === "Standard PRD") {
    return `# ${title}

## Problem

- Define the problem you're trying to solve
- Why is this important?

## Requirements

### Functional Requirements

- Requirement 1
- Requirement 2

### Non-Functional Requirements

- Performance requirements
- Security requirements

## User Stories

- As a user, I want to...
- As an admin, I want to...

## Success Metrics

- Metric 1
- Metric 2

## Timeline

- Phase 1: ...
- Phase 2: ...
`;
  }

  return `# ${title}

## Overview

Add your content here...
`;
}
