import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldValuesService } from "../custom-fields/values-service";
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

      // Batch-load custom field values for all projects in a single query
      const projectIds = projects.map((p) => p.id);
      const allValues =
        projectIds.length > 0
          ? await customFieldValuesService.getValuesForEntity(
              CustomFieldEntityType.Project,
              projectIds,
              user.organizationId
            )
          : [];

      const valuesByEntityId = new Map(
        projects.map((p) => [p.id, [] as typeof allValues])
      );
      for (const value of allValues) {
        const list = valuesByEntityId.get(value.entityId);
        if (list) {
          list.push(value);
        }
      }

      const projectsWithFields = projects.map((p) => ({
        ...p,
        customFields: valuesByEntityId.get(p.id) ?? [],
      }));

      return successResponse(projectsWithFields);
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

      return successResponse(projectWithDetails);
    } catch (error) {
      return errorResponse("Failed to create project", error);
    }
  },
  { requiredScopes: ["write"] }
);
