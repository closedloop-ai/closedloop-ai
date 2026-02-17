import { z } from "zod";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { type ComputeMode, computeModeService } from "../compute-mode-service";

type ComputeModeResponse = { computeMode: ComputeMode };

const computeModeValidator = z.object({
  computeMode: z.enum(["GITHUB_ACTIONS", "LOOPS"]),
});

/**
 * GET /settings/compute-mode
 * Returns the organization's current compute mode.
 */
export const GET = withAuth<ComputeModeResponse, "/settings/compute-mode">(
  async ({ user }) => {
    try {
      const computeMode = await computeModeService.getComputeMode(
        user.organizationId
      );
      return successResponse({ computeMode });
    } catch (error) {
      return errorResponse("Failed to fetch compute mode", error);
    }
  }
);

/**
 * PUT /settings/compute-mode
 * Set the organization's compute mode. Requires admin role.
 */
export const PUT = withAuth<ComputeModeResponse, "/settings/compute-mode">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    try {
      const isAdmin = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!isAdmin) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        computeModeValidator
      );
      if (parseError || !body) {
        return parseError;
      }

      await computeModeService.setComputeMode(
        user.organizationId,
        body.computeMode
      );
      return successResponse({ computeMode: body.computeMode });
    } catch (error) {
      return errorResponse("Failed to set compute mode", error);
    }
  }
);
