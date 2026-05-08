import type { SetComputeTargetSharingResponse } from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { computeTargetsService } from "../../service";
import { setSharingValidator } from "../../validators";

/**
 * PATCH /compute-targets/:id/sharing
 * Toggles whether a compute target is shared with the organization.
 * Only the owner can toggle sharing.
 */
export const PATCH = withAnyAuth<
  SetComputeTargetSharingResponse,
  "/compute-targets/[id]/sharing"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      setSharingValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    const result = await computeTargetsService.setSharing(
      id,
      user.organizationId,
      user.id,
      body.isSharedWithOrg
    );

    if (!result) {
      return notFoundResponse("Compute target");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to update sharing settings", error);
  }
});
