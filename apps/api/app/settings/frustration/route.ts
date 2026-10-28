import type { SessionFrustrationSettingResponse } from "@repo/api/src/types/settings";
import { SettingsCommandCapability } from "@repo/api/src/types/settings-command";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { z } from "zod";
import {
  getSettingsCommandDecision,
  settingsCommandDenialReason,
  settingsCommandDenialResponse,
} from "@/lib/auth/settings-command";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  OrgAdminGate,
  reportOrgAdminDenial,
} from "@/lib/observability/admin-denial-telemetry";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { frustrationSettingService } from "../frustration-setting-service";

const frustrationSettingValidator = z.object({
  calculateSessionFrustration: z.boolean(),
});

/**
 * GET /settings/frustration
 * Returns the organization's current session-frustration toggle. Any-auth so the
 * desktop (API key / desktop-session token) can read the gate as well as the
 * browser settings page.
 */
export const GET = withAnyAuth<
  SessionFrustrationSettingResponse,
  "/settings/frustration"
>(async ({ user }) => {
  try {
    const calculateSessionFrustration =
      await frustrationSettingService.isFrustrationEnabled(user.organizationId);
    return successResponse({ calculateSessionFrustration });
  } catch (error) {
    return errorResponse("Failed to fetch frustration setting", error);
  }
});

/**
 * PUT /settings/frustration
 * Set the organization's session-frustration toggle. Requires admin role — a
 * browser (Clerk) admin only, so this uses `withAuth` (not `withAnyAuth`): the
 * gate is an org-policy decision, not a programmatic one.
 */
export const PUT = withAuth<
  SessionFrustrationSettingResponse,
  "/settings/frustration"
>(async ({ user, clerkOrgId, clerkUserId }, request) => {
  try {
    const decision = await getSettingsCommandDecision({
      clerkOrgId,
      clerkUserId,
      domain: SettingsDomainId.Sync,
      capability: SettingsCommandCapability.Admin,
    });
    if (!decision.allowed) {
      reportOrgAdminDenial({
        clerkOrgId,
        clerkUserId,
        gate: OrgAdminGate.FrustrationSetting,
        reason: settingsCommandDenialReason(decision.code),
      });
      return settingsCommandDenialResponse(decision.code);
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      frustrationSettingValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    await frustrationSettingService.setFrustrationEnabled(
      user.organizationId,
      body.calculateSessionFrustration
    );
    return successResponse({
      calculateSessionFrustration: body.calculateSessionFrustration,
    });
  } catch (error) {
    return errorResponse("Failed to set frustration setting", error);
  }
});
