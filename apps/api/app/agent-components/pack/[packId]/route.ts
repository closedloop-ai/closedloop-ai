import "server-only";

import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { agentComponentsService } from "../../service";

/**
 * GET /agent-components/pack/{packId}
 *
 * Org-wide analytics rollup for a pack (usage, sessions, KLOC/$, adoption),
 * keyed by the shared `packId`. Visible to all org members (no admin gate);
 * powers the desktop-team overlay. 404 when the org has no data for the pack.
 */
export const GET = withAnyAuth<
  PackAnalyticsResponse,
  "/agent-components/pack/[packId]"
>(
  async ({ user }, _request, params) => {
    try {
      const { packId } = await params;
      const analytics = await agentComponentsService.getPackAnalytics(
        user.organizationId,
        decodeURIComponent(packId)
      );
      if (!analytics) {
        return notFoundResponse("Pack analytics");
      }
      return successResponse(analytics);
    } catch (error) {
      return errorResponse("Failed to fetch pack analytics", error);
    }
  },
  { requiredScopes: ["read"] }
);
