import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { DesktopDistributionStatusResponse } from "@repo/api/src/types/distribution";
import { DistributionTargetStatusValue } from "@repo/api/src/types/distribution";
import { z } from "zod";
import { distributionsService } from "@/app/distributions/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { writeInShape } from "@/lib/record-write-in-transaction";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { distributionStatusReceiptWrite } from "./status-receipt";

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
  withOperationReceipts(
    OperationKind.DesktopSync,
    async ({ user, clerkUserId }, request, _params, receipts) => {
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
        const { computeTargetId, reports } = body;
        const result = await writeInShape(
          receipts.whenRecording<number>((tx, accepted) =>
            receipts.record(tx, distributionStatusReceiptWrite(accepted))
          ),
          {
            unrecorded: () =>
              distributionsService.upsertStatusReports(
                user.organizationId,
                computeTargetId,
                user.id,
                clerkUserId,
                reports
              ),
            recorded: (recordWrite) =>
              distributionsService.upsertStatusReports(
                user.organizationId,
                computeTargetId,
                user.id,
                clerkUserId,
                reports,
                recordWrite
              ),
          }
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
        if (result.value === 0) {
          await receipts.recordStandalone(distributionStatusReceiptWrite(0));
        }
        return successResponse(
          withOperationReceipt({ accepted: result.value }, receipts)
        );
      } catch (error) {
        return errorResponse(
          "Failed to process distribution status reports",
          error
        );
      }
    }
  ),
  { requiredScopes: ["write"] }
);
