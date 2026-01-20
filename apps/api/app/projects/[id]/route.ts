import type { Project } from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateProjectSchema } from "../schemas";

export const GET = withAuth<Project, "/projects/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const project = await database.project.findUnique({
        where: { id, organizationId: user.organizationId },
      });

      if (!project) {
        return notFoundResponse("Project");
      }

      return successResponse(project as Project);
    } catch (error) {
      return errorResponse("Failed to fetch project", error);
    }
  }
);

export const PUT = withAuth<Project, "/projects/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const existing = await database.project.findUnique({
        where: { id, organizationId: user.organizationId },
      });

      if (!existing) {
        return notFoundResponse("Project");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateProjectSchema
      );
      if (parseError) {
        return parseError;
      }

      const data: Prisma.ProjectUpdateInput = {
        name: body.name,
        description: body.description,
        settings: body.settings as Prisma.InputJsonValue,
      };

      const project = await database.project.update({
        where: { id },
        data,
      });

      return successResponse(project as Project);
    } catch (error) {
      return errorResponse("Failed to update project", error);
    }
  }
);

export const DELETE = withAuth<{ deleted: true }, "/projects/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      const existing = await database.project.findUnique({
        where: { id, organizationId: user.organizationId },
      });

      if (!existing) {
        return notFoundResponse("Project");
      }

      await database.project.delete({ where: { id } });
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete project", error);
    }
  }
);
