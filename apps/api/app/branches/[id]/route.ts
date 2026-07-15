import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchService } from "@/app/branches/branch-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<BranchPageDetail, "/branches/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const branch = await branchReadService.getBranchDetail(
        user.organizationId,
        id
      );
      if (!branch) {
        return notFoundResponse("Branch");
      }
      return successResponse(branch);
    } catch (error) {
      return errorResponse("Failed to fetch branch", error);
    }
  },
  { requiredScopes: ["read"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/branches/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const deleted = await branchService.deleteBranchArtifact(
        id,
        user.organizationId
      );
      if (!deleted) {
        return notFoundResponse("Branch");
      }
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete branch", error);
    }
  },
  { requiredScopes: ["delete"] }
);
