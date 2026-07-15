import type { DistributionDto } from "@repo/api/src/types/distribution";
import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { distributionsService } from "../service";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const updateDistributionSchema = z
  .object({
    mode: z
      .enum([DistributionMode.AutoInstall, DistributionMode.OptIn])
      .optional(),
    targetingType: z
      .enum([DistributionTargetingType.All, DistributionTargetingType.Specific])
      .optional(),
    desiredEnabled: z.boolean().optional(),
    targetComputeTargetIds: z.array(z.string().uuid()).optional(),
    targetUserIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /distributions/{id}
 *
 * Returns the distribution detail including full `DistributionTargetStatus` rows.
 * Org-visible (no admin gate).
 */
export const GET = withAnyAuth<DistributionDto, "/distributions/[id]">(
  async ({ user }, _request, params) => {
    const { id } = await params;
    try {
      const distribution = await distributionsService.getDetailForOrg(
        user.organizationId,
        id
      );
      if (!distribution) {
        return notFoundResponse("Distribution");
      }
      return successResponse(distribution);
    } catch (error) {
      return errorResponse("Failed to fetch distribution", error);
    }
  },
  { requiredScopes: ["read"] }
);

/**
 * PATCH /distributions/{id}
 *
 * Update a distribution's mode, targeting type, or targeting set (admin-only).
 */
export const PATCH = withAnyAuth<DistributionDto, "/distributions/[id]">(
  async ({ user, clerkOrgId, clerkUserId }, request, params) => {
    const { id } = await params;

    const { body, errorResponse: parseErr } = await parseBody(
      request,
      updateDistributionSchema
    );
    if (parseErr) {
      return parseErr;
    }

    try {
      const result = await distributionsService.update(
        user.organizationId,
        id,
        clerkOrgId,
        clerkUserId,
        body
      );
      if (!result.ok) {
        if (result.error === 403) {
          return forbiddenResponse();
        }
        if (result.error === 404) {
          return notFoundResponse("Distribution");
        }
        return errorResponse("Failed to update distribution", result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to update distribution", error);
    }
  },
  { requiredScopes: ["write"] }
);
