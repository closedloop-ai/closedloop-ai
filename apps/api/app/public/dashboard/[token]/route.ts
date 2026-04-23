import type { ApiResult } from "@repo/api/src/types/common";
import { success } from "@repo/api/src/types/common";
import type {
  PublicUsageDashboardResponse,
  TimeInterval,
} from "@repo/api/src/types/dashboard";
import { NextResponse } from "next/server";
import { dashboardService } from "@/app/dashboard/service";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

type RouteParams = { params: Promise<{ token: string }> };

export async function GET(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<PublicUsageDashboardResponse>>> {
  try {
    const { token } = await params;
    const url = new URL(request.url);

    const rangeParam = url.searchParams.get("range");
    const rangeDays =
      rangeParam !== null ? Number.parseInt(rangeParam, 10) : undefined;
    const modelsParam = url.searchParams.get("models");
    const models = modelsParam
      ? modelsParam.split(",").filter(Boolean)
      : undefined;

    const intervalParam = url.searchParams.get("interval");
    const validIntervals = new Set<TimeInterval>(["15min", "1h", "1d"]);
    const interval: TimeInterval =
      intervalParam && validIntervals.has(intervalParam as TimeInterval)
        ? (intervalParam as TimeInterval)
        : "1d";

    const result = await dashboardService.getPublicUsageDashboard(token, {
      rangeDays:
        rangeDays !== undefined && !Number.isNaN(rangeDays)
          ? rangeDays
          : undefined,
      models,
      interval,
    });

    if (!result) {
      return notFoundResponse("Dashboard");
    }

    const response = NextResponse.json(success(result));
    response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return response;
  } catch (error) {
    return errorResponse("Failed to fetch public dashboard", error);
  }
}
