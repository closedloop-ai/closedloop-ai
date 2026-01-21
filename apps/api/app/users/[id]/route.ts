import type { User } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../service";
import { updateUserValidator } from "../validators";

export const GET = withAuth<User, "/users/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      // Users can only fetch users in their organization
      const targetUser = await usersService.findById(id, user.organizationId);

      if (!targetUser) {
        return notFoundResponse("User");
      }

      return successResponse(targetUser);
    } catch (error) {
      return errorResponse("Failed to fetch user", error);
    }
  }
);

export const PUT = withAuth<User, "/users/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const existing = await usersService.findById(id, user.organizationId);

      if (!existing) {
        return notFoundResponse("User");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateUserValidator
      );
      if (parseError) {
        return parseError;
      }

      const updatedUser = await usersService.update(id, body);

      return successResponse(updatedUser as User);
    } catch (error) {
      return errorResponse("Failed to update user", error);
    }
  }
);

// Note: DELETE intentionally not implemented - users should be deactivated, not deleted
// This preserves audit trail and referential integrity
