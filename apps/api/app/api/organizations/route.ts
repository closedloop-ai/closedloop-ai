import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type {
  CreateOrganizationInput,
  Organization,
} from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse<ApiResult<Organization[]>>> {
  try {
    const organizations = await database.organization.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(success(organizations));
  } catch (error) {
    console.error("Failed to fetch organizations:", error);
    return NextResponse.json(failure("Failed to fetch organizations"));
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const body = (await request.json()) as CreateOrganizationInput;

    const organization = await database.organization.create({
      data: {
        name: body.name,
        slug: body.slug,
        anthropicApiKey: body.anthropicApiKey,
      },
    });

    return NextResponse.json(success(organization));
  } catch (error) {
    console.error("Failed to create organization:", error);
    return NextResponse.json(failure("Failed to create organization"));
  }
}
