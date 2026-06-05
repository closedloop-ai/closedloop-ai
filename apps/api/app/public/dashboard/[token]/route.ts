import type { ApiResult } from "@repo/api/src/types/common";
import { success } from "@repo/api/src/types/common";
import type { PublicDashboardResponse } from "@repo/api/src/types/dashboard";
import { NextResponse } from "next/server";
import { dashboardService } from "@/app/dashboard/service";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

type RouteParams = { params: Promise<{ token: string }> };

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<PublicDashboardResponse>>> {
  try {
    const { token } = await params;

    const result = await dashboardService.getPublicDashboardByToken(token);

    if (!result) {
      return notFoundResponse("Dashboard");
    }

    const response = NextResponse.json(success(result));
    // Allow cross-origin pages to load this resource even when the browser
    // defaults Cross-Origin-Embedder-Policy to same-origin.
    response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return response;
  } catch (error) {
    return errorResponse("Failed to fetch public dashboard", error);
  }
}
