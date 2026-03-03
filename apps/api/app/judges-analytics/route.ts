import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type {
  JudgeStatsResponse,
  JudgesAnalyticsReportType,
} from "@repo/api/src/types/judges-analytics";
import { withAuth } from "@/lib/auth/with-auth";
import { createJudgesAnalyticsHandler } from "./lib/route-handler";
import { judgesAnalyticsService } from "./service";
import { judgesAnalyticsQueryValidator } from "./validators";

export const GET = withAuth<JudgeStatsResponse, "/judges-analytics">(
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

function paramsReportType(extra?: Record<string, unknown>) {
  return (
    (extra?.reportType as JudgesAnalyticsReportType | undefined) ??
    EvaluationReportType.Plan
  );
}
