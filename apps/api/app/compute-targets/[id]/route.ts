import type {
  ComputeTarget,
  UpdateComputeTargetInput,
} from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  conflictResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { computeTargetsService } from "../service";
import { updateComputeTargetValidator } from "../validators";

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * PUT /compute-targets/:id
 * Updates metadata for a user-owned compute target.
 */
export const PUT = withAnyAuth<ComputeTarget, "/compute-targets/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateComputeTargetValidator
      );
      if (parseError || !body) {
        return parseError;
      }

      const target = await computeTargetsService.updateOwned(
        id,
        user.organizationId,
        user.id,
        body as UpdateComputeTargetInput,
        user.clerkId
      );

      if (!target) {
        return notFoundResponse("Compute target");
      }

      return successResponse(target);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return conflictResponse(
          "A compute target with that machine name already exists"
        );
      }
      return errorResponse("Failed to update compute target", error);
    }
  }
);

/**
 * DELETE /compute-targets/:id
 * Deletes a user-owned compute target.
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/compute-targets/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const deleted = await computeTargetsService.deleteOwned(
        id,
        user.organizationId,
        user.id
      );
      if (!deleted) {
        return notFoundResponse("Compute target");
      }

      relayEventBus.closeTargetConnections(id);

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete compute target", error);
    }
  }
);
