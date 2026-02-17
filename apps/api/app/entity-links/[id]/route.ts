import { withAuth } from "@/lib/auth/with-auth";
import { deleteResponse, errorResponse } from "@/lib/route-utils";
import { entityLinksService } from "../service";

export const DELETE = withAuth<{ deleted: true }, "/entity-links/[id]">(
  async (_authContext, _, params) => {
    try {
      const { id } = await params;
      await entityLinksService.deleteLink(id);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete entity link", error);
    }
  }
);
