import "server-only";

import type { ComplianceResponse } from "@repo/api/src/types/analytics";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { complianceQuerySchema } from "../analytics-validators";
import { complianceService } from "./service";

/**
 * GET /agent-components/compliance
 *
 * Returns org compliance gaps: required (auto_install) distributions where
 * compute targets are not installed, or installed but unused.
 *
 * Admin-only: the compliance view is an admin Settings tab (FEA-4029), so the
 * data itself is gated to org admins/owners here (not only in the UI). A
 * non-admin member or an API key whose owner is not an org admin gets 403.
 * `isOrgAdmin` fails closed on a Clerk provider error.
 *
 * Query params:
 *   limit — optional; max items returned (default 50).
 */
export const GET = withAnyAuth<
  ComplianceResponse,
  "/agent-components/compliance"
>(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    const admin = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!admin) {
      return forbiddenResponse();
    }

    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      complianceQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    const { limit } = query;

    try {
      const response = await complianceService.getCompliance({
        organizationId: user.organizationId,
        limit,
      });
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch compliance gaps", error);
    }
  },
  { requiredScopes: ["read"] }
);
