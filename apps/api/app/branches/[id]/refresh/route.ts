import type { BranchRefreshResponse } from "@repo/api/src/types/branch";
import { BranchRefreshReason } from "@repo/api/src/types/branch";
import { branchReadService } from "@/app/branches/branch-read-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const POST = withAnyAuth<
  BranchRefreshResponse,
  "/branches/[id]/refresh"
>(
  async ({ user, authMethod }, _, params) => {
    try {
      const { id } = await params;
      const response = await branchReadService.refreshBranch(
        user.organizationId,
        id,
        { userId: user.id, authMethod }
      );
      if (response.reason === BranchRefreshReason.NotFound) {
        return notFoundResponse("Branch");
      }
      const headers = new Headers();
      if (response.retryAfterSeconds) {
        headers.set("Retry-After", String(response.retryAfterSeconds));
      }
      const json = successResponse(response);
      for (const [key, value] of headers) {
        json.headers.set(key, value);
      }
      return json;
    } catch (error) {
      return errorResponse("Failed to refresh branch", error);
    }
  },
  { requiredScopes: ["write"] }
);
