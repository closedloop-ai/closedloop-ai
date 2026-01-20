import type {
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createWorkstreamSchema } from "./schemas";

export const GET = withAuth<Workstream[], "/workstreams">(
  async ({ user }, request) => {
    try {
      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get("projectId");
      const state = searchParams.get("state");
      const search = searchParams.get("search");
      const limit = searchParams.get("limit");

      if (!projectId) {
        return badRequestResponse("projectId is required");
      }

      const project = await database.project.findUnique({
        where: { id: projectId, organizationId: user.organizationId },
      });

      if (!project) {
        return notFoundResponse("Project");
      }

      const workstreams = await database.workstream.findMany({
        where: {
          projectId,
          ...(state ? { state: state as WorkstreamState } : {}),
          ...(search
            ? {
                OR: [
                  { title: { contains: search, mode: "insensitive" } },
                  { description: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        ...(limit ? { take: Number.parseInt(limit, 10) } : {}),
      });

      return successResponse(workstreams as Workstream[]);
    } catch (error) {
      return errorResponse("Failed to fetch workstreams", error);
    }
  }
);

export const POST = withAuth<Workstream, "/workstreams">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createWorkstreamSchema
      );
      if (parseError) {
        return parseError;
      }

      const project = await database.project.findUnique({
        where: { id: body.projectId, organizationId: user.organizationId },
      });

      if (!project) {
        return notFoundResponse("Project");
      }

      const workstream = await database.workstream.create({
        data: {
          projectId: body.projectId,
          title: body.title,
          description: body.description,
          type: body.type ?? "FEATURE_DELIVERY",
          createdById: user.id,
          assignedToId: body.assignedToId,
          hasUIChanges: body.hasUIChanges ?? false,
        },
      });

      return successResponse(workstream as Workstream);
    } catch (error) {
      return errorResponse("Failed to create workstream", error);
    }
  }
);
