import type { JudgeStatsResponse } from "@repo/api/src/types/judges-analytics";
import { withAuth } from "@/lib/auth/with-auth";
import { createJudgesAnalyticsHandler } from "./lib/route-handler";
import { judgesAnalyticsService } from "./service";
import { judgesAnalyticsQueryValidator } from "./validators";

export const GET = withAuth<JudgeStatsResponse, "/judges-analytics">(
  createJudgesAnalyticsHandler({
    validator: judgesAnalyticsQueryValidator,
    fetch: (orgId, startDate, endDate) =>
      judgesAnalyticsService.getAggregateStats(orgId, startDate, endDate),
    errorMessage: "Failed to fetch judges analytics",
  })
);
