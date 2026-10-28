import type { User } from "@repo/api/src/types/user";
import { requireOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../service";
import { updateUserValidator } from "../validators";

export const GET = withAnyAuth<User, "/users/[id]">(
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
  async ({ clerkOrgId, clerkUserId, user }, request, params) => {
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

      // Closedloop roles are organization-managed. Do not let members change
      // their own role or another member's role through the general profile
      // update endpoint. Keep the check server-side and use the authenticated
      // Clerk organization, not a client supplied organization identifier.
      if (body.role !== undefined) {
        if (existing.id === user.id) {
          return forbiddenResponse();
        }

        const adminDenial = await requireOrgAdmin(clerkOrgId, clerkUserId);
        if (adminDenial) {
          return adminDenial;
        }
      }

      const updatedUser = await usersService.update(
        id,
        user.organizationId,
        body
      );

      return successResponse(updatedUser);
    } catch (error) {
      return errorResponse("Failed to update user", error);
    }
  }
);

// Note: DELETE intentionally not implemented - users should be deactivated, not deleted
// This preserves audit trail and referential integrity
