import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import type { CreatePrdInput, Prd } from "@repo/api/src/types/prd";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse<ApiResult<Prd[]>>> {
  try {
    const prds = await database.prd.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json(success(prds));
  } catch (error) {
    console.error("Failed to fetch PRDs:", error);
    return NextResponse.json(failure("Failed to fetch PRDs"), { status: 500 });
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Prd>>> {
  try {
    const input: CreatePrdInput = await request.json();

    const prd = await database.prd.create({
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

    return NextResponse.json(success(prd), { status: 201 });
  } catch (error) {
    console.error("Failed to create PRD:", error);
    return NextResponse.json(failure("Failed to create PRD"), { status: 500 });
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
