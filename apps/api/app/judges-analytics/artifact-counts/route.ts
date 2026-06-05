import type {
  ArtifactCountsGroupBy,
  ArtifactCountsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createJudgesAnalyticsHandler } from "../lib/route-handler";
import { judgesAnalyticsService } from "../service";
import { artifactCountsQueryValidator } from "../validators";

export const GET = withAnyAuth<
  ArtifactCountsResponse,
  "/judges-analytics/artifact-counts"
>(
  createJudgesAnalyticsHandler({
    validator: artifactCountsQueryValidator,
    parseExtra: (params) => ({ groupBy: params.groupBy }),
    fetch: (orgId, startDate, endDate, extra) =>
      judgesAnalyticsService.getArtifactCounts(
        orgId,
        startDate,
        endDate,
        (extra?.groupBy ?? "day") as ArtifactCountsGroupBy
      ),
    errorMessage: "Failed to fetch artifact counts",
  })
);
