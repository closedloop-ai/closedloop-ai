import type { ExternalLink } from "@repo/api/src/types/external-link";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { externalLinksService } from "../service";
import { updateExternalLinkValidator } from "../validators";

export const GET = withAuth<ExternalLink, "/external-links/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const externalLink = await externalLinksService.findById(
        id,
        user.organizationId
      );

      if (!externalLink) {
        return notFoundResponse("External link");
      }

      return successResponse(externalLink);
    } catch (error) {
      return errorResponse("Failed to fetch external link", error);
    }
  }
);

export const PUT = withAuth<ExternalLink, "/external-links/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateExternalLinkValidator
      );
      if (parseError) {
        return parseError;
      }

      const externalLink = await externalLinksService.update(
        user.organizationId,
        id,
        body
      );

      return successResponse(externalLink);
    } catch (error) {
      return errorResponse("Failed to update external link", error);
    }
  }
);

export const DELETE = withAuth<{ deleted: true }, "/external-links/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      await externalLinksService.delete(user.organizationId, id);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete external link", error);
    }
  }
);
