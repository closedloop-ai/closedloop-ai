import type { ExternalLink } from "@repo/api/src/types/external-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId, resolveWorkstreamId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
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

      const { projectId, workstreamId, ...restQuery } = parseResult.data;
      let resolvedProjectId: string | undefined;
      if (projectId) {
        const pId = await resolveProjectId(projectId, user.organizationId);
        if (!pId) {
          return notFoundResponse("Project");
        }
        resolvedProjectId = pId;
      }
      let resolvedWorkstreamId: string | undefined;
      if (workstreamId) {
        const wId = await resolveWorkstreamId(
          workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
      }

      const externalLinks = await externalLinksService.findAll({
        organizationId: user.organizationId,
        projectId: resolvedProjectId,
        workstreamId: resolvedWorkstreamId,
        ...restQuery,
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

      const resolvedProjectId = await resolveProjectId(
        body.projectId,
        user.organizationId
      );
      if (!resolvedProjectId) {
        return notFoundResponse("Project");
      }
      let resolvedWorkstreamId: string | undefined;
      if (body.workstreamId) {
        const wId = await resolveWorkstreamId(
          body.workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
      }

      const externalLink = await externalLinksService.create(
        user.organizationId,
        {
          ...body,
          projectId: resolvedProjectId,
          workstreamId: resolvedWorkstreamId,
        }
      );

      return successResponse(externalLink);
    } catch (error) {
      return errorResponse("Failed to create external link", error);
    }
  },
  { requiredScopes: ["write"] }
);
