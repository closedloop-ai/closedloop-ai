import type { SessionFrustrationSettingResponse } from "@repo/api/src/types/settings";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
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
    const adminStatus = await getOrgAdminStatus(clerkOrgId, clerkUserId);
    if (!adminStatus.isAdmin) {
      log.warn("Denied frustration setting update for non-admin user", {
        clerkOrgId,
        clerkUserId,
        reason: adminStatus.reason,
        method: "PUT",
        route: "/settings/frustration",
      });
      scheduleLogFlush();
      return forbiddenResponse();
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
