import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { deleteResponse, errorResponse } from "@/lib/route-utils";
import { entityLinksService } from "../service";

export const DELETE = withAnyAuth<{ deleted: true }, "/entity-links/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      await entityLinksService.deleteLink(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete entity link", error);
    }
  },
  { requiredScopes: ["delete"] }
);
