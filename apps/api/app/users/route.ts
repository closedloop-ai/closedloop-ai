import type { User } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { usersService } from "./service";

export const GET = withAuth<User[]>(async ({ user }) => {
  try {
    const users = await usersService.findByOrganization(user.organizationId);
    return successResponse(users);
  } catch (error) {
    return errorResponse("Failed to fetch users", error);
  }
});
