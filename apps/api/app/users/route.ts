import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { auth } from "@repo/auth/server";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { usersService } from "./service";

export async function GET(
  _: Request
): Promise<NextResponse<ApiResult<User[]>>> {
  try {
    const { orgId } = await auth();
    if (!orgId) {
      return unauthorizedResponse();
    }

    const users = await usersService.findByOrganization(orgId);

    return successResponse(users as User[]);
  } catch (error) {
    return errorResponse("Failed to fetch users", error);
  }
}
