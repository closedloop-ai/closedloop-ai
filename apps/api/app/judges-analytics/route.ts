import type { JudgeStatsResponse } from "@repo/api/src/types/judges-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { paramsReportType } from "./lib/report-type-helpers";
import { createJudgesAnalyticsHandler } from "./lib/route-handler";
import { judgesAnalyticsService } from "./service";
import { judgesAnalyticsQueryValidator } from "./validators";

export const GET = withAnyAuth<JudgeStatsResponse, "/judges-analytics">(
  createJudgesAnalyticsHandler({
    validator: judgesAnalyticsQueryValidator,
    parseExtra: (params) => ({ reportType: params.reportType }),
    fetch: (orgId, startDate, endDate, extra) =>
      judgesAnalyticsService.getAggregateStats(
        orgId,
        startDate,
        endDate,
        paramsReportType(extra)
      ),
    errorMessage: "Failed to fetch judges analytics",
  })
);
