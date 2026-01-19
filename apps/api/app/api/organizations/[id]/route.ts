import type { ApiResult } from "@repo/api/src/types/common";
import type { Organization } from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  deleteResponse,
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateOrganizationSchema } from "../schemas";

// TODO: Add org access verification once auth middleware provides organizationId
export async function GET(
  _request: Request,
  { params }: IdRouteParams
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
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const { id } = await params;

    const existing = await database.organization.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Organization");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateOrganizationSchema
    );
    if (parseError) {
      return parseError;
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
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;

    const existing = await database.organization.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Organization");
    }

    await database.organization.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete organization", error);
  }
}
