import { SettingsDomainFailureReason } from "@repo/api/src/types/settings-domain";
import type { SettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { SettingsViewModelStatus } from "@repo/api/src/types/settings-view-model";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  serviceUnavailableResponse,
  successResponse,
} from "@/lib/route-utils";
import { buildSettingsViewModel } from "./settings-view-model-service";

/**
 * GET /settings/view-model
 *
 * The actor's role and their capability over each Settings domain, from one
 * membership read (ISS-8378). Additive: no existing route changes.
 *
 * `withAnyAuth` because the desktop renderer hosts the same surface over a
 * desktop-session token, which carries no `orgRole` claim — the service reads
 * Clerk directly, so every auth path gets a real answer instead of `member`.
 *
 * THREE OUTCOMES, THREE STATUSES, none folded into another:
 *
 * - `ready` and `partial` are 200. A `partial` body still carries every domain,
 *   because which ones failed is exactly what the caller needs and no status
 *   code can express it.
 * - `error` — the membership read did not complete — is 503, not 200 and not
 *   403. Not 403 because that is a DECISION and this is the absence of one;
 *   not 200 because an `ApiResult` with `success: true` tells every generic
 *   client wrapper the payload is trustworthy, and because a 200 keeps the
 *   failure out of `request_completed`'s error stream, leaving a Clerk outage
 *   that zeroes every actor's capabilities visible only in an unmonitored log
 *   line. `serviceUnavailableResponse` is the repo's existing helper for
 *   "a dependency could not be reached, so the server could not decide".
 * - A 500 is for the projection itself throwing, which is a bug, not a state.
 */
export const GET = withAnyAuth<SettingsViewModel, "/settings/view-model">(
  async ({ clerkOrgId, clerkUserId, orgRole }) => {
    try {
      const viewModel = await buildSettingsViewModel({
        clerkOrgId,
        clerkUserId,
        sessionRole: orgRole,
      });
      if (viewModel.status === SettingsViewModelStatus.Error) {
        return serviceUnavailableResponse(
          "Could not read the actor's organization membership",
          { code: SettingsDomainFailureReason.RoleUnresolved }
        );
      }
      return successResponse(viewModel);
    } catch (error) {
      return errorResponse("Failed to build the Settings view model", error);
    }
  }
);
