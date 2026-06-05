import type { LoopUsageSummary } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../service";

export const GET = withAuth<LoopUsageSummary, "/loops/usage">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    try {
      const adminStatus = await getOrgAdminStatus(clerkOrgId, clerkUserId);
      if (!adminStatus.isAdmin) {
        log.warn("Denied loop usage read for non-admin user", {
          clerkOrgId,
          clerkUserId,
          reason: adminStatus.reason,
          method: "GET",
          route: "/loops/usage",
        });
        return forbiddenResponse();
      }

      const searchParams = request.nextUrl.searchParams;

      const startDateParam = searchParams.get("startDate");
      const endDateParam = searchParams.get("endDate");
      const command = searchParams.get("command") ?? undefined;

      // Validate date params if provided
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (startDateParam) {
        startDate = new Date(startDateParam);
        if (Number.isNaN(startDate.getTime())) {
          return badRequestResponse("Invalid startDate format");
        }
      }

      if (endDateParam) {
        endDate = new Date(endDateParam);
        if (Number.isNaN(endDate.getTime())) {
          return badRequestResponse("Invalid endDate format");
        }
      }

      const summary = await loopsService.getUsageSummary(user.organizationId, {
        startDate,
        endDate,
        command,
      });

      return successResponse(summary);
    } catch (error) {
      return errorResponse("Failed to fetch usage summary", error);
    }
  }
);
