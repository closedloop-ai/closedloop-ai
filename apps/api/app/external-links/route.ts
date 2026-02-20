import type { ExternalLink } from "@repo/api/src/types/external-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { externalLinksService } from "./service";
import {
  createExternalLinkValidator,
  findExternalLinksQueryValidator,
} from "./validators";

export const GET = withAnyAuth<ExternalLink[], "/external-links">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;

      // Convert searchParams to plain object for validation
      const queryParams = Object.fromEntries(searchParams.entries());

      // Validate query parameters
      const parseResult =
        findExternalLinksQueryValidator.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const externalLinks = await externalLinksService.findAll({
        organizationId: user.organizationId,
        ...parseResult.data,
      });

      return successResponse(externalLinks);
    } catch (error) {
      return errorResponse("Failed to fetch external links", error);
    }
  }
);

export const POST = withAnyAuth<ExternalLink, "/external-links">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createExternalLinkValidator
      );
      if (parseError) {
        return parseError;
      }

      const externalLink = await externalLinksService.create(
        user.organizationId,
        body
      );

      return successResponse(externalLink);
    } catch (error) {
      return errorResponse("Failed to create external link", error);
    }
  }
);
