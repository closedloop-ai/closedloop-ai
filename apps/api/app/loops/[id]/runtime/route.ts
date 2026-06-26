import { log } from "@repo/observability/log";
import type { LoopRuntimeState } from "@/app/loops/types";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../../service";

export const GET = withAuth<LoopRuntimeState, "/loops/[id]/runtime">(
  async ({ user, clerkOrgId, clerkUserId }, _, params) => {
    try {
      const adminStatus = await getOrgAdminStatus(clerkOrgId, clerkUserId);
      if (!adminStatus.isAdmin) {
        log.warn("Denied loop runtime read for non-admin user", {
          clerkOrgId,
          clerkUserId,
          reason: adminStatus.reason,
          method: "GET",
          route: "/loops/[id]/runtime",
        });
        scheduleLogFlush();
        return forbiddenResponse();
      }

      const { id } = await params;

      const runtime = await loopsService.getLoopRuntime(
        id,
        user.organizationId
      );

      if (!runtime) {
        return notFoundResponse("Loop");
      }

      scheduleLogFlush();
      return successResponse(runtime);
    } catch (error) {
      return errorResponse("Failed to fetch loop runtime", error);
    }
  }
);
