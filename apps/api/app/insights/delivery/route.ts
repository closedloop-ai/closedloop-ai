import type { DeliveryInsightsResponse } from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createInsightsHandler } from "../lib/route-handler";
import { insightsService } from "../service";

/**
 * ISS-8424: this read starts `runPostConnectObservedSync` in a `waitUntil` lane
 * when the merged-PR population is unmeasured, and the platform bounds that lane
 * by the function's own ceiling rather than by when the response was sent —
 * the same hazard `integrations/github/connect` and `clerk-link` declare 300 for.
 *
 * Undeclared, the sweep is killed at the platform default mid-run, and the org
 * is worse off than if it had never fired: `claimOrganizationRun` writes the
 * cooldown at CLAIM time, so a truncated pass leaves Delivery unmeasured for the
 * full hour with no verification written. Route-segment config must be a static
 * literal, so the number lives here and
 * `unmeasured-delivery-resync-route-ceiling.test.ts` pins it to the lease.
 */
export const maxDuration = 300;

export const GET = withAnyAuth<DeliveryInsightsResponse, "/insights/delivery">(
  createInsightsHandler({
    fetch: (ctx, period) => insightsService.getDelivery(ctx, period),
    section: InsightsSection.Delivery,
    errorMessage: "Failed to fetch delivery insights",
  })
);
