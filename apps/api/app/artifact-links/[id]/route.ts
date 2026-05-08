import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { deleteResponse, errorResponse } from "@/lib/route-utils";
import { artifactLinksService } from "../service";

export const DELETE = withAnyAuth<{ deleted: true }, "/artifact-links/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      await artifactLinksService.deleteLink(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact link", error);
    }
  },
  { requiredScopes: ["delete"] }
);
