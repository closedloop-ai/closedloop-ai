import type { LostWorkInsightsResponse } from "@repo/api/src/types/session-analytics";
import { SessionAnalyticsSection } from "@repo/api/src/types/session-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createInsightsHandler } from "../lib/route-handler";
import { fetchLostWork } from "../lost-work";

export const GET = withAnyAuth<LostWorkInsightsResponse, "/insights/lost-work">(
  createInsightsHandler({
    fetch: (ctx, period) => fetchLostWork(ctx, period),
    section: SessionAnalyticsSection.LostWork,
    errorMessage: "Failed to fetch lost-work insights",
  })
);
