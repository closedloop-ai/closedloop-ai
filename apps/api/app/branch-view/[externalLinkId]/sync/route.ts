import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { syncCommentsAndReviews } from "../service";

export const POST = withAnyAuth<
  { synced: boolean },
  "/branch-view/[externalLinkId]/sync"
>(async ({ user }, _, params) => {
  try {
    const { externalLinkId } = await params;

    const ctx = await resolvePrContext(externalLinkId, user.organizationId);
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const result = await syncCommentsAndReviews(ctx);
    if (result.error) {
      return errorResponse(result.error, result.error);
    }

    return successResponse({ synced: true });
  } catch (error) {
    return errorResponse("Failed to sync comments", error);
  }
});
