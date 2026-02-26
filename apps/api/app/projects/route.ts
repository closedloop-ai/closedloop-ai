import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "./service";
import { createProjectValidator } from "./validators";

/**
 * GET /projects - List all projects
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 * Query params:
 *   - teamId: Filter by team
 *   - limit: Maximum number of projects to return (1-100, only applies when teamId is provided)
 */
export const GET = withAnyAuth<ProjectWithDetails[], "/projects">(
  async ({ user }, request) => {
    try {
      const url = new URL(request.url);

      // Validate query parameters
      const querySchema = z.object({
        teamId: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      });

      const queryResult = querySchema.safeParse({
        teamId: url.searchParams.get("teamId") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      });

      if (!queryResult.success) {
        return badRequestResponse("Invalid query parameters");
      }

      const { teamId, limit } = queryResult.data;

      // Determine which service method to call based on parameters
      const projects = teamId
        ? await projectsService.findByTeam(
            teamId,
            user.organizationId,
            limit ? { limit } : undefined
          )
        : await projectsService.findByOrganization(user.organizationId);

      return successResponse(
        projects.map((p) => projectsService.toProjectWithDetails(p))
      );
    } catch (error) {
      return errorResponse("Failed to fetch projects", error);
    }
  }
);

/**
 * POST /projects - Create a new project
 */
export const POST = withAnyAuth<ProjectWithDetails, "/projects">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createProjectValidator
      );
      if (parseError) {
        return parseError;
      }

      const project = await projectsService.create(
        user.organizationId,
        user.id,
        body
      );

      // Fetch the full project with details
      const projectWithDetails = await projectsService.findById(
        project.id,
        user.organizationId
      );

      if (!projectWithDetails) {
        return errorResponse(
          "Project created but could not be retrieved",
          new Error("Project not found")
        );
      }

      return successResponse(
        projectsService.toProjectWithDetails(projectWithDetails)
      );
    } catch (error) {
      return errorResponse("Failed to create project", error);
    }
  },
  { requiredScopes: ["write"] }
);
