import type { ConfirmDifferentAccountResetResponse } from "@repo/api/src/types/github";
import { Status } from "@repo/api/src/types/result";
import { organizationsService } from "@/app/organizations/service";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { githubService } from "../../service";

/**
 * POST /integrations/github/connect/confirm-reset
 *
 * Confirm the admin's decision to clear team repositories and project repo
 * settings before claiming a GitHub installation from a different account
 * (PLN-634). The installation to claim is read from `pendingNewInstallationId`
 * on the prior UNINSTALLED row (pinned by the OAuth callback), so an
 * attacker cannot swap installation IDs by phishing the admin with a
 * crafted query string. Returns 400 if there's no prior UNINSTALLED row,
 * no pending pin, the pinned install cannot be found, the pinned install
 * is actually the same account, or 403 if it's already claimed elsewhere.
 */
export const POST = withAuth<
  ConfirmDifferentAccountResetResponse,
  "/integrations/github/connect/confirm-reset"
>(async ({ clerkOrgId, user }) => {
  const organization = await organizationsService.findByClerkId(clerkOrgId);

  if (!organization) {
    return errorResponse("Organization not found", null, 404);
  }

  const result = await githubService.confirmDifferentAccountReset({
    organizationId: organization.id,
    userId: user.id,
  });

  if (!result.ok) {
    const message =
      result.error === Status.Forbidden
        ? "GitHub installation is already connected to another organization"
        : "Cannot complete different-account reset";
    return errorResponse(message, null, result.error);
  }

  return successResponse({ confirmed: true });
});
