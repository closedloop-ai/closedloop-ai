import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { desktopFeatureFlagsService } from "./service";

/**
 * GET /desktop/feature-flags — the authenticated caller's per-user PostHog flag
 * assignment (ISS-8024). Reachable by the first-party desktop session token via
 * {@link withAnyAuth}; the desktop main process fetches it and forwards it to
 * the renderer, which gates on it instead of on a local Labs registry.
 *
 * Org-scoping is implicit and total: the assignment is evaluated for the
 * AUTHENTICATED principal's own distinct ids only, so a token can never read
 * another user's rollout.
 */
export const GET = withAnyAuth<DesktopFeatureFlagAssignment>(
  async ({ user, clerkUserId }) => {
    try {
      return successResponse(
        await desktopFeatureFlagsService.get({
          userId: user.id,
          clerkUserId,
          organizationId: user.organizationId,
        })
      );
    } catch (error) {
      return errorResponse("Failed to resolve desktop feature flags", error);
    }
  }
);
