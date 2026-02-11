import type { User } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../users/service";

export const GET = withAuth<User>(async ({ user }) => {
  try {
    const found = await usersService.findById(user.id, user.organizationId);
    if (!found) {
      return notFoundResponse("User");
    }

    return successResponse(found);
  } catch (error) {
    return errorResponse("Failed to fetch user", error);
  }
});
