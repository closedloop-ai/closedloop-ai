import type { UtilizationInsightsResponse } from "@repo/api/src/types/insights";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createInsightsHandler } from "../lib/route-handler";
import { insightsService } from "../service";

export const GET = withAnyAuth<
  UtilizationInsightsResponse,
  "/insights/utilization"
>(
  createInsightsHandler({
    fetch: (ctx, period) => insightsService.getUtilization(ctx, period),
    errorMessage: "Failed to fetch utilization insights",
  })
);
