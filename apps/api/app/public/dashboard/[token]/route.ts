import type { ApiResult } from "@repo/api/src/types/common";
import { success } from "@repo/api/src/types/common";
import type { PublicDashboardResponse } from "@repo/api/src/types/dashboard";
import { rateLimit } from "@repo/security";
import { NextResponse } from "next/server";
import { dashboardService } from "@/app/dashboard/service";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

type RouteParams = { params: Promise<{ token: string }> };

export async function GET(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<PublicDashboardResponse>>> {
  try {
    const { token } = await params;

    await rateLimit(
      `public_dashboard_${request.headers.get("x-forwarded-for") ?? "unknown"}`,
      30,
      "60s",
      request
    );

    const result = await dashboardService.getPublicDashboardByToken(token);

    if (!result) {
      return notFoundResponse("Dashboard");
    }

    return NextResponse.json(success(result));
  } catch (error) {
    return errorResponse("Failed to fetch public dashboard", error);
  }
}
