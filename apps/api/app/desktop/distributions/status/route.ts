import type { DesktopDistributionStatusResponse } from "@repo/api/src/types/distribution";
import { DistributionTargetStatusValue } from "@repo/api/src/types/distribution";
import { z } from "zod";
import { distributionsService } from "@/app/distributions/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const statusReportSchema = z.object({
  distributionId: z.string().uuid(),
  status: z.enum([
    DistributionTargetStatusValue.Pending,
    DistributionTargetStatusValue.Installed,
    DistributionTargetStatusValue.Enabled,
    DistributionTargetStatusValue.Failed,
    DistributionTargetStatusValue.OptedIn,
    DistributionTargetStatusValue.Declined,
  ]),
  installedVersion: z.string().optional(),
  installRunId: z.string().optional(),
  failureReason: z.string().optional(),
});

const desktopDistributionStatusSchema = z.object({
  computeTargetId: z.string().uuid(),
  reports: z.array(statusReportSchema).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /desktop/distributions/status
 *
 * Desktop reports install/enable status for one or more distributions.
 * Upserts `DistributionTargetStatus` rows per (distribution, computeTarget).
 *
 * Authentication: `withAnyAuth` (API-key, desktop-session, or Clerk session).
 * Authorization: ComputeTarget ownership gate (NOT admin-only).
 *
 * Returns `{ accepted: number }` — the count of reports that were persisted.
 * Reports for distributions not belonging to the calling org are silently dropped.
 */
export const POST = withAnyAuth<
  DesktopDistributionStatusResponse,
  "/desktop/distributions/status"
>(
  async ({ user, clerkUserId }, request) => {
    const { body, errorResponse: parseErr } = await parseBody(
      request,
      desktopDistributionStatusSchema
    );
    if (parseErr) {
      return parseErr;
    }

    if (!body.computeTargetId) {
      return badRequestResponse("computeTargetId is required");
    }

    try {
      const result = await distributionsService.upsertStatusReports(
        user.organizationId,
        body.computeTargetId,
        user.id,
        clerkUserId,
        body.reports
      );
      if (!result.ok) {
        if (result.error === "forbidden") {
          return forbiddenResponse();
        }
        return errorResponse(
          "Failed to process distribution status reports",
          result.error
        );
      }
      return successResponse({ accepted: result.value });
    } catch (error) {
      return errorResponse(
        "Failed to process distribution status reports",
        error
      );
    }
  },
  { requiredScopes: ["write"] }
);
