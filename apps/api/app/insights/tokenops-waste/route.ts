import type { TokenOpsWasteInsightsResponse } from "@repo/api/src/types/session-analytics";
import { SessionAnalyticsSection } from "@repo/api/src/types/session-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createInsightsHandler } from "../lib/route-handler";
import { fetchTokenOpsWaste } from "../tokenops-waste";

export const GET = withAnyAuth<
  TokenOpsWasteInsightsResponse,
  "/insights/tokenops-waste"
>(
  createInsightsHandler({
    fetch: (ctx, period) => fetchTokenOpsWaste(ctx, period),
    section: SessionAnalyticsSection.TokenOpsWaste,
    errorMessage: "Failed to fetch TokenOps waste insights",
  })
);
