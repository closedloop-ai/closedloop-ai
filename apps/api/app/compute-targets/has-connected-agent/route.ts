import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { computeTargetsService } from "../service";

/**
 * GET /compute-targets/has-connected-agent
 *
 * PRD-536 §5: org-wide boolean signal for the Sessions onboarding empty state —
 * "has any real desktop compute target ever registered in this org?". This is an
 * org-wide check (not the viewer's own/org-shared listing from `GET
 * /compute-targets`), so a teammate's unshared desktop still counts as
 * connected and an empty filtered/date result for one user is never
 * misclassified as "never onboarded".
 */
export const GET = withAnyAuth<
  { hasConnectedAgent: boolean },
  "/compute-targets/has-connected-agent"
>(async ({ user }) => {
  try {
    const hasConnectedAgent = await computeTargetsService.hasAnyForOrg(
      user.organizationId
    );
    return successResponse({ hasConnectedAgent });
  } catch (error) {
    return errorResponse("Failed to check connected agents", error);
  }
});
