import type { Workstream } from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateWorkstreamSchema } from "../schemas";

export const GET = withAuth<Workstream, "/workstreams/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      const workstream = await database.workstream.findUnique({
        where: { id, project: { organizationId: user.organizationId } },
      });

      if (!workstream) {
        return notFoundResponse("Workstream");
      }

      return successResponse(workstream as Workstream);
    } catch (error) {
      return errorResponse("Failed to fetch workstream", error);
    }
  }
);

export const PUT = withAuth<Workstream, "/workstreams/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const existing = await database.workstream.findUnique({
        where: { id, project: { organizationId: user.organizationId } },
      });

      if (!existing) {
        return notFoundResponse("Workstream");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateWorkstreamSchema
      );
      if (parseError) {
        return parseError;
      }

      // If state is being changed, update stateChangedAt
      const updateData: Record<string, unknown> = { ...body };
      if (body.state) {
        updateData.stateChangedAt = new Date();
      }

      const workstream = await database.workstream.update({
        where: { id },
        data: updateData,
      });

      return successResponse(workstream as Workstream);
    } catch (error) {
      return errorResponse("Failed to update workstream", error);
    }
  }
);

export const DELETE = withAuth<{ deleted: true }, "/workstreams/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      await database.workstream.delete({
        where: { id, project: { organizationId: user.organizationId } },
      });

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete workstream", error);
    }
  }
);
