import type { User } from "@repo/api/src/types/user";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { usersService } from "./service";

/**
 * GET /users - List all users in the organization
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<User[]>(async ({ user }) => {
  try {
    const users = await usersService.findByOrganization(user.organizationId);
    return successResponse(users);
  } catch (error) {
    return errorResponse("Failed to fetch users", error);
  }
});
