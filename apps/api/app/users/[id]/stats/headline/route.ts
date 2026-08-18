import type { UserProfileHeadline } from "@repo/api/src/types/user";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../../../service";
import { userProfileService } from "../../../user-profile-service";

// FEA-4064: range-scoped headline metrics. This is the ONLY profile read the
// range toggle re-fetches — it is split from the fixed-window contribution
// heatmap (GET /users/[id]/contributions) so a range click never re-issues the
// trailing-year heatmap SQL, and so a failing heatmap read can never fail this
// ranged response (widget independence).
export const GET = withAnyAuth<
  UserProfileHeadline,
  "/users/[id]/stats/headline"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

    // Optional inclusive lower bound driven by the profile-header range toggle.
    // Absent → all-time totals as before.
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

    const headline = await userProfileService.getUserProfileHeadline(
      id,
      user.organizationId,
      startDate
    );
    return successResponse(headline);
  } catch (error) {
    return errorResponse("Failed to fetch user profile headline", error);
  }
});
