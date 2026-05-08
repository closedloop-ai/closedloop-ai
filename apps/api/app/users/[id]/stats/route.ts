import type { UserProfileStats } from "@repo/api/src/types/user";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../../service";

export const GET = withAnyAuth<UserProfileStats, "/users/[id]/stats">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      // Verify user exists in same org
      const targetUser = await usersService.findById(id, user.organizationId);
      if (!targetUser) {
        return notFoundResponse("User");
      }

      const stats = await usersService.getUserStats(id, user.organizationId);
      return successResponse(stats);
    } catch (error) {
      return errorResponse("Failed to fetch user stats", error);
    }
  }
);
