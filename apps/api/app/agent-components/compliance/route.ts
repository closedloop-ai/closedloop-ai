import "server-only";

import type { ComplianceResponse } from "@repo/api/src/types/analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { complianceQuerySchema } from "../analytics-validators";
import { complianceService } from "./service";

/**
 * GET /agent-components/compliance
 *
 * Returns org-visible compliance gaps: required (auto_install) distributions
 * where compute targets are not installed, or installed but unused.
 * Visible to all org members (withAnyAuth, no admin gate).
 *
 * Query params:
 *   limit — optional; max items returned (default 50).
 */
export const GET = withAnyAuth<
  ComplianceResponse,
  "/agent-components/compliance"
>(
  async ({ user }, request) => {
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
