import type { DashboardStats } from "@repo/api/src/types/dashboard";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { dashboardService } from "../service";

export const GET = withAuth<DashboardStats, "/dashboard/stats">(
  async ({ user }) => {
    try {
      const stats = await dashboardService.getDashboardStats(
        user.organizationId
      );
      return successResponse(stats);
    } catch (error) {
      return errorResponse("Failed to fetch dashboard stats", error);
    }
  }
);
