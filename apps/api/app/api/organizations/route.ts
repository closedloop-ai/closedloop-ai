import { createOrganizationSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import type { Organization } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  getAuthContext,
  isErrorResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

// Note: GET all organizations intentionally not implemented for security
// Users should only access their own organization via /organizations/[id]

// Note: POST creates a new organization - typically used during onboarding
// In production, this would be restricted to admin users or signup flow
export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const body = await parseBody(request, createOrganizationSchema);
    if (isErrorResponse(body)) {
      return body;
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
