import type { AgentsInsightsResponse } from "@repo/api/src/types/insights";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createInsightsHandler } from "../lib/route-handler";
import { insightsService } from "../service";

export const GET = withAnyAuth<AgentsInsightsResponse, "/insights/agents">(
  createInsightsHandler({
    fetch: (ctx, period) => insightsService.getAgents(ctx, period),
    errorMessage: "Failed to fetch agents insights",
  })
);
