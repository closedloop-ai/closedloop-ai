import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { sessionMeshInsightsQueryValidator } from "@repo/api/src/types/session-mesh";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { withSessionMeshAuth } from "../auth";
import { sessionMeshService } from "../service";
import { isRetainedReportingWindow } from "../service/reporting-window";

export const GET = withSessionMeshAuth(async ({ user }, request) => {
  try {
    const query = sessionMeshInsightsQueryValidator.safeParse(
      Object.fromEntries(request.nextUrl.searchParams)
    );
    if (!query.success) {
      return badRequestResponse("Invalid Session Mesh Insights filters");
    }
    const selectedUser =
      query.data.scope === InsightsScope.Org
        ? undefined
        : (query.data.userId ?? user.id);
    const { from: fromText, to: toText, period } = query.data;
    const to = toText ? new Date(toText) : new Date();
    const from = fromText
      ? new Date(fromText)
      : new Date(
          to.getTime() -
            (period === InsightsPeriod.All ? 90 : Number(period)) * 86_400_000
        );
    if (!isRetainedReportingWindow(from, to, new Date())) {
      return badRequestResponse(
        "Insights window must be a valid range within the retained last 90 days"
      );
    }
    return successResponse(
      await sessionMeshService.insights(
        user.organizationId,
        { from, to },
        selectedUser
      )
    );
  } catch (error) {
    return errorResponse("Failed to read Session Mesh insights", error);
  }
});
