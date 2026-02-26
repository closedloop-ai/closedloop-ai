import type { Workstream } from "@repo/api/src/types/workstream";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { workstreamsService } from "../service";
import { updateWorkstreamValidator } from "../validators";

export const GET = withAnyAuth<Workstream, "/workstreams/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      const workstream = await workstreamsService.findById(
        id,
        user.organizationId
      );

      if (!workstream) {
        return notFoundResponse("Workstream");
      }

      return successResponse(workstream);
    } catch (error) {
      return errorResponse("Failed to fetch workstream", error);
    }
  }
);

export const PUT = withAnyAuth<Workstream, "/workstreams/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const existing = await workstreamsService.findById(
        id,
        user.organizationId
      );

      if (!existing) {
        return notFoundResponse("Workstream");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateWorkstreamValidator
      );
      if (parseError) {
        return parseError;
      }

      const workstream = await workstreamsService.update(
        id,
        user.organizationId,
        body
      );

      return successResponse(workstream);
    } catch (error) {
      return errorResponse("Failed to update workstream", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/workstreams/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      await workstreamsService.delete(id, user.organizationId);

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete workstream", error);
    }
  },
  { requiredScopes: ["delete"] }
);
