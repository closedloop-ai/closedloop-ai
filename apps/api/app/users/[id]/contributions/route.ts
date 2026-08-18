import type { UserContributionHeatmap } from "@repo/api/src/types/user";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../../service";
import { userProfileService } from "../../user-profile-service";

// FEA-4064: fixed-window contribution heatmap widget. A heatmap is a
// trailing-year grid by definition, so this read takes no startDate and is NOT
// re-fetched by the profile range toggle. It is served on its own route so the
// heatmap loads independently of the headline query — a range click never
// re-issues this SQL, and a failure here degrades to an error/empty heatmap
// widget without failing the headline response (widget independence).
export const GET = withAnyAuth<
  UserContributionHeatmap,
  "/users/[id]/contributions"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;

    // Verify user exists in same org
    const targetUser = await usersService.findById(id, user.organizationId);
    if (!targetUser) {
      return notFoundResponse("User");
    }

    const heatmap = await userProfileService.getUserContributionHeatmap(
      id,
      user.organizationId
    );
    return successResponse(heatmap);
  } catch (error) {
    return errorResponse("Failed to fetch user contribution heatmap", error);
  }
});
