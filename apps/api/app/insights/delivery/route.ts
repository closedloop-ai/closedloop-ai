import type { DeliveryInsightsResponse } from "@repo/api/src/types/insights";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createInsightsHandler } from "../lib/route-handler";
import { insightsService } from "../service";

export const GET = withAnyAuth<DeliveryInsightsResponse, "/insights/delivery">(
  createInsightsHandler({
    fetch: (ctx, period) => insightsService.getDelivery(ctx, period),
    errorMessage: "Failed to fetch delivery insights",
  })
);
