import type { BranchViewData } from "@repo/api/src/types/branch-view";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  errorResponse,
  notFoundResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { getBranchViewData } from "./service";

export const GET = withAnyAuth<BranchViewData, "/branch-view/[externalLinkId]">(
  async ({ user }, _, params) => {
    try {
      const { externalLinkId } = await params;

      const ctx = await resolvePrContext(externalLinkId, user.organizationId);
      if (!ctx) {
        return notFoundResponse("Branch view");
      }

      const result = await getBranchViewData(ctx, user);
      if (result.error || !result.data) {
        return errorResponse(
          result.error ?? "Branch view data unavailable",
          result.error,
          404
        );
      }

      scheduleLogFlush();
      return successResponse(result.data);
    } catch (error) {
      return errorResponse("Failed to fetch branch view data", error);
    }
  }
);
