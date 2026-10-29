import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { guidedOnboardingSnapshotQuerySchema } from "@repo/api/src/types/onboarding-guided";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { guidedOnboardingSnapshotService } from "../snapshot-service";

/**
 * GET /onboarding/guided/snapshot - the caller's guided onboarding run.
 *
 * Read-only: a caller with no run gets a first-run snapshot, not a row. The
 * first accepted transition is what materializes one.
 */
export const GET = withAnyAuth<
  GuidedOnboardingSnapshot,
  "/onboarding/guided/snapshot"
>(async ({ user }, request) => {
  const query = parseQueryParams(request, guidedOnboardingSnapshotQuerySchema);
  if (query.errorResponse) {
    return query.errorResponse;
  }

  try {
    const snapshot = await guidedOnboardingSnapshotService.getSnapshot({
      organizationId: user.organizationId,
      userId: user.id,
      clerkUserId: user.clerkId,
      host: query.params.host,
    });
    return successResponse(snapshot);
  } catch (error) {
    return errorResponse("Failed to load guided onboarding snapshot", error);
  }
});
