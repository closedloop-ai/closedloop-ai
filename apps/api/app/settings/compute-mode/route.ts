import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { type ComputeMode, computeModeService } from "../compute-mode-service";

type ComputeModeResponse = { computeMode: ComputeMode };

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
  async ({ user }, request) => {
    try {
      const body = (await request.json()) as { computeMode?: string };
      const mode = body.computeMode;

      if (mode !== "GITHUB_ACTIONS" && mode !== "LOOPS") {
        return badRequestResponse(
          "computeMode must be 'GITHUB_ACTIONS' or 'LOOPS'"
        );
      }

      await computeModeService.setComputeMode(user.organizationId, mode);
      return successResponse({ computeMode: mode });
    } catch (error) {
      return errorResponse("Failed to set compute mode", error);
    }
  }
);
