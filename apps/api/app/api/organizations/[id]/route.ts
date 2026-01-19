import { updateOrganizationSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import type { Organization } from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  deleteResponse,
  errorResponse,
  isErrorResponse,
  notFoundResponse,
  parseBody,
  type RouteParams,
  successResponse,
} from "@/lib/route-utils";

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const { id } = await params;
    const organization = await database.organization.findUnique({
      where: { id },
    });

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
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const { id } = await params;
    const body = await parseBody(request, updateOrganizationSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    const data: Prisma.OrganizationUpdateInput = {
      name: body.name,
      slug: body.slug,
      anthropicApiKey: body.anthropicApiKey,
      settings: body.settings as Prisma.InputJsonValue,
    };

    const organization = await database.organization.update({
      where: { id },
      data,
    });

    return successResponse(organization as Organization);
  } catch (error) {
    return errorResponse("Failed to update organization", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.organization.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete organization", error);
  }
}
