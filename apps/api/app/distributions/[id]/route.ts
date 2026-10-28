import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { DistributionDto } from "@repo/api/src/types/distribution";
import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { Status } from "@repo/api/src/types/result";
import { z } from "zod";
import { roleUnresolvedResponse } from "@/lib/auth/org-admin-denial";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  recordNoOpUnlessRecorded,
  recordOrganizationWrite,
} from "@/lib/organization-write-receipt";
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
    // The path segment is untrusted and `Distribution.id` is `@db.Uuid`, so a
    // malformed one raises at the driver and the catch below would report a
    // caller's typo as a 500, recording a RouteHandler error span with it.
    if (!isUuid(id)) {
      return notFoundResponse("Distribution");
    }

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
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, params, receipts) => {
      const { id } = await params;
      if (!isUuid(id)) {
        return notFoundResponse("Distribution");
      }

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
          body,
          recordOrganizationWrite(receipts)
        );
        if (!result.ok) {
          if (result.error === Status.ServiceUnavailable) {
            return roleUnresolvedResponse();
          }
          if (result.error === Status.Forbidden) {
            return forbiddenResponse();
          }
          if (result.error === Status.NotFound) {
            return notFoundResponse("Distribution");
          }
          return errorResponse("Failed to update distribution", result.error);
        }
        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to update distribution", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

/**
 * DELETE /distributions/{id}
 *
 * Withdraw a distribution — stop offering this pack to the organization
 * (ISS-5123). Admin-only; the admin gate lives in the service alongside
 * `create`/`update`, which is this route file's existing convention.
 *
 * Soft withdrawal, not a row delete: already-installed copies on members'
 * machines are left in place and keep working, and the per-device install
 * history is preserved. Idempotent — withdrawing an already-withdrawn
 * distribution succeeds as a no-op and returns the same record.
 */
export const DELETE = withAnyAuth<DistributionDto, "/distributions/[id]">(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, _request, params, receipts) => {
      const { id } = await params;
      if (!isUuid(id)) {
        return notFoundResponse("Distribution");
      }

      try {
        const result = await distributionsService.withdraw(
          user.organizationId,
          id,
          user.id,
          clerkOrgId,
          clerkUserId,
          recordOrganizationWrite(receipts)
        );
        if (!result.ok) {
          if (result.error === Status.ServiceUnavailable) {
            return roleUnresolvedResponse();
          }
          if (result.error === Status.Forbidden) {
            return forbiddenResponse();
          }
          if (result.error === Status.NotFound) {
            return notFoundResponse("Distribution");
          }
          return errorResponse("Failed to withdraw distribution", result.error);
        }
        // ISS-12552: withdrawing an already-withdrawn distribution changes
        // nothing, so it is recorded as a no-op on its own.
        await recordNoOpUnlessRecorded(receipts);
        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to withdraw distribution", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
