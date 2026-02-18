import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";
import { apiKeysService } from "../service";

export const DELETE = withAuth<{ deleted: true }, "/api-keys/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const revoked = await apiKeysService.revoke(id, user.organizationId);

      if (!revoked) {
        return notFoundResponse("API key");
      }

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to revoke API key", error);
    }
  }
);
