import type { UserProfileStats } from "@repo/api/src/types/user";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../../service";
import { userProfileService } from "../../user-profile-service";

export const GET = withAnyAuth<UserProfileStats, "/users/[id]/stats">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      // FEA-4064: optional lower bound for the ranged headline metrics, set by
      // the profile-header range toggle. Absent → all-time totals as before.
      const startDateParam = request.nextUrl.searchParams.get("startDate");
      let startDate: Date | undefined;
      if (startDateParam) {
        startDate = new Date(startDateParam);
        if (Number.isNaN(startDate.getTime())) {
          return badRequestResponse("Invalid startDate format");
        }
      }

      // Verify user exists in same org
      const targetUser = await usersService.findById(id, user.organizationId);
      if (!targetUser) {
        return notFoundResponse("User");
      }

      const stats = await userProfileService.getUserStats(
        id,
        user.organizationId,
        startDate
      );
      return successResponse(stats);
    } catch (error) {
      return errorResponse("Failed to fetch user stats", error);
    }
  }
);
