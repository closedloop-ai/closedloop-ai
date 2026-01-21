import type { Project } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { projectsService } from "./service";
import { createProjectValidator } from "./validators";

export const GET = withAuth<Project[], "/projects">(async ({ user }) => {
  try {
    const projects = await projectsService.findByOrganization(
      user.organizationId
    );
    return successResponse(projects);
  } catch (error) {
    return errorResponse("Failed to fetch projects", error);
  }
});

export const POST = withAuth<Project, "/projects">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createProjectValidator
      );
      if (parseError) {
        return parseError;
      }

      const project = await projectsService.create(user.organizationId, {
        name: body.name,
        description: body.description,
      });

      return successResponse(project);
    } catch (error) {
      return errorResponse("Failed to create project", error);
    }
  }
);
