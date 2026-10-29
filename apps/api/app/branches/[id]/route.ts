import type { UpdateBranchPriorityResponse } from "@repo/api/src/types/artifact-priority-mutation";
import {
  BRANCH_ROW_FIELD_EDIT,
  BranchPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchDetailChecksDelivery,
  type BranchSelectedPullRequestIdentity,
  branchDetailQuerySchema,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ArtifactType, withDb } from "@repo/database";
import { branchDeleteReceiptWrite } from "@/app/branches/branch-delete-receipt";
import { updateBranchPriorityBodySchema } from "@/app/branches/branch-priority-validators";
import { branchSelectedPullRequestChecksService } from "@/app/branches/branch-selected-pull-request-checks-service";
import { branchService } from "@/app/branches/branch-service";
import { readBranchDetailForViewer } from "@/app/branches/read-branch-detail-for-viewer";
import { artifactBulkPriorityService } from "@/app/documents/artifact-bulk-priority-service";
import { singlePriorityReceiptRecorder } from "@/app/documents/single-priority-receipt";
import {
  captureSinglePriorityActivity,
  emitSinglePriorityRefusalAnalytics,
  emitSinglePrioritySideEffects,
} from "@/app/documents/single-priority-side-effects";
import { unsupportedRowFieldError } from "@/lib/artifact-row-field-refusal";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { statusMutationErrorResponse } from "@/lib/mutation-error-response";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<BranchPageDetail, "/branches/[id]">(
  async (authContext, request, params) => {
    const { user } = authContext;
    const { params: query, errorResponse: parseErrorResponse } =
      parseQueryParams(request, branchDetailQuerySchema);
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const { id } = await params;
      const detail = await readBranchDetailForViewer(
        authContext,
        id,
        selectedPullRequestIdentity(query)
      );
      const branch =
        detail && query.checks !== BranchDetailChecksDelivery.Lazy
          ? await branchSelectedPullRequestChecksService.enrichBranchDetail(
              user.organizationId,
              user.id,
              detail,
              request.signal
            )
          : detail;
      if (!branch) {
        return notFoundResponse("Branch");
      }
      return successResponse(branch);
    } catch (error) {
      return errorResponse("Failed to fetch branch", error);
    }
  },
  { requiredScopes: ["read"] }
);

function selectedPullRequestIdentity(query: {
  repositoryFullName?: string;
  pullRequestNumber?: number;
}): BranchSelectedPullRequestIdentity | undefined {
  return query.repositoryFullName && query.pullRequestNumber
    ? {
        repositoryFullName: query.repositoryFullName,
        pullRequestNumber: query.pullRequestNumber,
      }
    : undefined;
}

/**
 * PATCH /branches/[id] — set or clear a Branch's priority (ISS-10332).
 *
 * Priority is the only user-editable Branch field, so it is the whole body.
 * ORG-scoped, not owner/admin-only: priority is the same artifact field on
 * every type and takes the scope document priority already has (PLN-2086,
 * ruling 6). Ingest never writes `artifacts.priority`, so the value survives a
 * re-sync of the branch.
 *
 * `surface` (PLN-2086 Milestone 2) is optional provenance for the activity
 * receipt and canonical `artifact_field_edit_result` analytics event.
 *
 * A body key that is a field of the branch ROW (`branchName`, `status`,
 * `owner`, …) is refused with `unsupported_field` by name, before the strict
 * validator's generic answer (ISS-9485).
 *
 *  - 200 — written (or already held that value)
 *  - 400 — `unsupported_field`, or a Zod failure, including any other key the
 *          body does not declare
 *  - 404 — no BRANCH with that id in the caller's org
 *  - 409 — `stale_priority`: the stored value is neither `expectedPriority`
 *          nor the `priority` being written (ISS-9486: a retry never
 *          conflicts with its own earlier success)
 */
export const PATCH = withAnyAuth<
  UpdateBranchPriorityResponse,
  "/branches/[id]"
>(
  withOperationReceipts(
    OperationKind.UpdateFields,
    async ({ authMethod, user }, request, params, receipts) => {
      try {
        const { id } = await params;
        const {
          body,
          rawBody,
          errorResponse: parseError,
        } = await parseBody(request, updateBranchPriorityBodySchema);
        const unsupported = unsupportedRowFieldError(
          rawBody,
          BRANCH_ROW_FIELD_EDIT,
          Object.values(BranchPatchField)
        );
        if (unsupported) {
          return statusMutationErrorResponse(unsupported);
        }
        if (parseError) {
          return parseError;
        }
        const sideEffectInput = {
          user,
          authMethod,
          artifactId: id,
          artifactType: ArtifactType.BRANCH,
          priority: body.priority,
          ...(body.surface === undefined ? {} : { surface: body.surface }),
        } as const;
        const recordPriority = singlePriorityReceiptRecorder(receipts, id);
        // ISS-10993: the priority write and its activity receipt share ONE
        // transaction. `withDb.tx` joins an ambient transaction, so the
        // service's own `withDb.tx` runs on this one and a receipt that cannot
        // be written rolls the priority change back with it. ISS-12552: the
        // operation receipt rides the same transaction.
        const result = await withDb.tx(async (tx) => {
          const written = await artifactBulkPriorityService.updatePriority({
            artifactId: id,
            artifactType: ArtifactType.BRANCH,
            organizationId: user.organizationId,
            priority: body.priority,
            ...(body.expectedPriority === undefined
              ? {}
              : { expectedPriority: body.expectedPriority }),
          });
          if (written.ok) {
            await captureSinglePriorityActivity(tx, {
              ...sideEffectInput,
              written: written.value,
            });
            await recordPriority?.(tx, written.value);
          }
          return written;
        });
        if (!result.ok) {
          emitSinglePriorityRefusalAnalytics(
            sideEffectInput,
            result.error.status
          );
          return statusMutationErrorResponse(result.error);
        }
        emitSinglePrioritySideEffects({
          ...sideEffectInput,
          written: result.value,
        });
        return successResponse(
          withOperationReceipt({ id, priority: body.priority }, receipts)
        );
      } catch (error) {
        return errorResponse("Failed to update branch priority", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/branches/[id]">(
  withOperationReceipts(
    OperationKind.Delete,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        const deleted = await branchService.deleteBranchArtifact(
          id,
          user.organizationId,
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, branchDeleteReceiptWrite(written))
          )
        );
        if (!deleted) {
          return notFoundResponse("Branch");
        }
        return deleteResponse(receipts.receipt);
      } catch (error) {
        return errorResponse("Failed to delete branch", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);
