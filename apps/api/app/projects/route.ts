import type { Project } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { createProjectSchema } from "./schemas";

export const GET = withAuth<Project[], "/projects">(async ({ user }) => {
  try {
    const projects = await database.project.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "desc" },
    });

    return successResponse(projects as Project[]);
  } catch (error) {
    return errorResponse("Failed to fetch projects", error);
  }
});

export const POST = withAuth<Project, "/projects">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createProjectSchema
      );
      if (parseError) {
        return parseError;
      }

      const project = await database.project.create({
        data: {
          organizationId: user.organizationId,
          name: body.name,
          description: body.description,
        },
      });

      return successResponse(project as Project);
    } catch (error) {
      return errorResponse("Failed to create project", error);
    }
  }
);
