import type {
  CreateDistributionRequest,
  DistributionDto,
} from "@repo/api/src/types/distribution";
import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { distributionsService } from "./service";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const createDistributionSchema = z
  .object({
    catalogItemId: z.string().uuid(),
    mode: z.enum([DistributionMode.AutoInstall, DistributionMode.OptIn]),
    targetingType: z.enum([
      DistributionTargetingType.All,
      DistributionTargetingType.Specific,
    ]),
    desiredEnabled: z.boolean().optional(),
    targetComputeTargetIds: z.array(z.string().uuid()).optional(),
    targetUserIds: z.array(z.string().uuid()).optional(),
  })
  .superRefine((val, ctx) => {
    // A "specific" distribution with no targeting entries would create a
    // Distribution row that matches zero devices — permanently unreachable and
    // silently a no-op. Reject it so the caller gets a 400 instead of a vacuous
    // distribution. (targetingType "all" needs no entries.)
    if (
      val.targetingType === DistributionTargetingType.Specific &&
      !val.targetComputeTargetIds?.length &&
      !val.targetUserIds?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Specific targeting requires at least one targetComputeTargetId or targetUserId",
        path: ["targetComputeTargetIds"],
      });
    }
  });

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /distributions
 *
 * List all distributions for the calling user's organization.
 * Org-visible (no admin gate). Returns `DistributionDto[]` without per-device
 * `targetStatuses` (detail view only).
 */
export const GET = withAnyAuth<DistributionDto[], "/distributions">(
  async ({ user }) => {
    try {
      const distributions = await distributionsService.listForOrg(
        user.organizationId
      );
      return successResponse(distributions);
    } catch (error) {
      return errorResponse("Failed to fetch distributions", error);
    }
  },
  { requiredScopes: ["read"] }
);

/**
 * POST /distributions
 *
 * Create a new Distribution (admin-only via `isOrgAdmin`).
 * Body: `{ catalogItemId, mode, targetingType, desiredEnabled?, targetComputeTargetIds?, targetUserIds? }`.
 */
export const POST = withAnyAuth<DistributionDto, "/distributions">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    const { body, errorResponse: parseErr } = await parseBody(
      request,
      createDistributionSchema
    );
    if (parseErr) {
      return parseErr;
    }

    try {
      const result = await distributionsService.create(
        user.organizationId,
        user.id,
        clerkOrgId,
        clerkUserId,
        body as CreateDistributionRequest
      );
      if (!result.ok) {
        if (result.error === 403) {
          return forbiddenResponse();
        }
        if (result.error === 400) {
          return errorResponse("Invalid catalogItemId", null, 400);
        }
        return errorResponse("Failed to create distribution", result.error);
      }
      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to create distribution", error);
    }
  },
  { requiredScopes: ["write"] }
);
