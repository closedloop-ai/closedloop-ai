import type {
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../projects/service";
import { workstreamsService } from "./service";
import { createWorkstreamValidator } from "./validators";

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

      const project = await projectsService.findById(
        projectId,
        user.organizationId
      );

      if (!project) {
        return notFoundResponse("Project");
      }

      const workstreams = await workstreamsService.findByProject({
        projectId,
        state: state as WorkstreamState | undefined,
        search: search ?? undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
      });

      return successResponse(workstreams);
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
        createWorkstreamValidator
      );
      if (parseError) {
        return parseError;
      }

      const project = await projectsService.findById(
        body.projectId,
        user.organizationId
      );

      if (!project) {
        return notFoundResponse("Project");
      }

      const workstream = await workstreamsService.create(user.id, body);

      return successResponse(workstream);
    } catch (error) {
      return errorResponse("Failed to create workstream", error);
    }
  }
);
