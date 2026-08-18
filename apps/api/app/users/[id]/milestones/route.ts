import type { UserProfileMilestones } from "@repo/api/src/types/user";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../../service";
import { userProfileService } from "../../user-profile-service";

// FEA-4108: Lifetime milestones/achievements for the profile. Served on its own
// route so it loads independently of the headline, heatmap, and standing reads:
// a slow or failing milestones read degrades to a hidden/error Milestones
// section without blocking the rest of the profile (widget independence). Only
// earned milestones are returned, so the section renders nothing rather than a
// fake empty state when the user has crossed no threshold.
export const GET = withAnyAuth<UserProfileMilestones, "/users/[id]/milestones">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      // Verify user exists in same org (org-scoped).
      const targetUser = await usersService.findById(id, user.organizationId);
      if (!targetUser) {
        return notFoundResponse("User");
      }

      const milestones = await userProfileService.getUserProfileMilestones(
        id,
        user.organizationId
      );
      return successResponse(milestones);
    } catch (error) {
      return errorResponse("Failed to fetch user profile milestones", error);
    }
  }
);
