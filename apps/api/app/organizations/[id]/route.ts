import type { ApiResult } from "@repo/api/src/types/common";
import type { Organization } from "@repo/api/src/types/organization";
import { auth } from "@repo/auth/server";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  forbiddenResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateOrganizationSchema } from "../schemas";
import { organizationsService } from "../service";

export async function GET(
  _: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const { orgId } = await auth();
    const { id } = await params;

    if (orgId !== id) {
      return forbiddenResponse();
    }

    const organization = await organizationsService.findById(id);

    if (!organization) {
      return notFoundResponse("Organization");
    }

    return successResponse(organization as Organization);
  } catch (error) {
    return errorResponse("Failed to fetch organization", error);
  }
}

export async function PUT(
  request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const { id } = await params;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateOrganizationSchema
    );
    if (parseError) {
      return parseError;
    }

    const organization = await organizationsService.update(id, body);

    // Prisma uses JsonValue for JSON, and we need a JsonObject.
    return successResponse(organization as Organization);
  } catch (error) {
    return errorResponse("Failed to update organization", error);
  }
}
