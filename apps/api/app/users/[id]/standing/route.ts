import type { UserProfileStanding } from "@repo/api/src/types/user";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../../service";
import { userProfileService } from "../../user-profile-service";

// FEA-4108: Standing widget for the profile — the consecutive-active-days
// streak. Served on its own route so it loads independently of the headline and
// heatmap: a slow or failing streak read degrades to a hidden/error Standing
// section without blocking the headline (widget independence). Rank is NOT part
// of this payload — a global cross-org ranking service is unbuilt (FEA-4122).
export const GET = withAnyAuth<UserProfileStanding, "/users/[id]/standing">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      // Verify user exists in same org (org-scoped).
      const targetUser = await usersService.findById(id, user.organizationId);
      if (!targetUser) {
        return notFoundResponse("User");
      }

      const standing = await userProfileService.getUserProfileStanding(
        id,
        user.organizationId
      );
      return successResponse(standing);
    } catch (error) {
      return errorResponse("Failed to fetch user profile standing", error);
    }
  }
);
