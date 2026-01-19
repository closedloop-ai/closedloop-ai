import type { ApiResult } from "@repo/api/src/types/common";
import type { Organization } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { createOrganizationSchema } from "./schemas";

// Note: GET all organizations intentionally not implemented for security
// Users should only access their own organization via /organizations/[id]

// Note: POST creates a new organization - typically used during onboarding
// TODO: Add auth check once auth middleware is implemented
export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      createOrganizationSchema
    );
    if (parseError) {
      return parseError;
    }

    const organization = await database.organization.create({
      data: {
        name: body.name,
        slug: body.slug,
        anthropicApiKey: body.anthropicApiKey,
      },
    });

    return successResponse(organization as Organization);
  } catch (error) {
    return errorResponse("Failed to create organization", error);
  }
}
