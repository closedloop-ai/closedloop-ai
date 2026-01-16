import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type {
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

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
      return NextResponse.json(failure("Organization not found"), {
        status: 404,
      });
    }

    return NextResponse.json(success(organization));
  } catch (error) {
    console.error("Failed to fetch organization:", error);
    return NextResponse.json(failure("Failed to fetch organization"));
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Organization>>> {
  try {
    const { id } = await params;
    const body = (await request.json()) as Omit<UpdateOrganizationInput, "id">;

    const data: Prisma.OrganizationUpdateInput = {
      name: body.name,
      slug: body.slug,
      anthropicApiKey: body.anthropicApiKey,
      settings: body.settings,
    };

    const organization = await database.organization.update({
      where: { id },
      data,
    });

    return NextResponse.json(success(organization));
  } catch (error) {
    console.error("Failed to update organization:", error);
    return NextResponse.json(failure("Failed to update organization"));
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.organization.delete({ where: { id } });
    return NextResponse.json(success({ deleted: true }));
  } catch (error) {
    console.error("Failed to delete organization:", error);
    return NextResponse.json(failure("Failed to delete organization"));
  }
}
