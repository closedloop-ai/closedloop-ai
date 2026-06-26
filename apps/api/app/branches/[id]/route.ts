import { branchService } from "@/app/branches/branch-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";

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
