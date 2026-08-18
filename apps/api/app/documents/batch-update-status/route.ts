import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import {
  dispatchAuditEvents,
  userAuditActor,
} from "@/app/audit/audit-emit-service";
import { captureBatchStatusChange } from "@/lib/artifact-activity-capture";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { documentService } from "../document-service";
import { batchUpdateStatusValidator } from "../validators";

/**
 * POST /documents/batch-update-status
 * Update the status of multiple documents atomically.
 */
export const POST = withAnyAuth(
  async ({ authMethod, user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchUpdateStatusValidator
      );
      if (parseError) {
        return parseError;
      }

      // Snapshot the "before" status per artifact so the activity feed can
      // record each status transition. Best-effort: read failures are ignored
      // and simply mean a change goes uncaptured, never that the write fails.
      const beforeStatuses = await Promise.resolve(
        documentService.getStatusesByIds(body.documentIds, user.organizationId)
      ).catch(() => new Map<string, string>());

      const { updatedIds, changedIds } =
        await documentService.batchUpdateStatus(
          body.documentIds,
          body.status,
          user.organizationId
        );

      // Record each real transition on the tamper-evident audit ledger
      // (FEA-3862). Only `changedIds` — documents already at the target status
      // did not transition, so emitting for them would forge ledger entries for
      // events that never happened (mirrors the single-document PUT guard).
      // Non-blocking and best-effort: a SINGLE bulk outbox insert off the
      // response path, so ledger emission never fails the batch update and the
      // enqueue is one pooled write regardless of batch size (not one per doc).
      const actor = userAuditActor(user.id);
      dispatchAuditEvents(
        changedIds.map((documentId) => ({
          organizationId: user.organizationId,
          actor,
          action: AuditAction.DocumentStatusChanged,
          objectType: AuditObjectType.Document,
          objectId: documentId,
          detail: { to: body.status, batch: true },
        }))
      );

      // Capture the status transitions into the activity feed (FEA-3864).
      // Keyed off `changedIds` — the same real-transition set the audit ledger
      // uses — so a no-op re-apply (before === target) is never recorded as a
      // change on either hook. Non-blocking and isolated — never fails the write
      // (defense-in-depth guard so a synchronous throw can't 500 a batch that
      // already committed).
      try {
        captureBatchStatusChange({
          organizationId: user.organizationId,
          actor: { userId: user.id, authMethod },
          changes: changedIds.flatMap((id) => {
            const before = beforeStatuses.get(id);
            return before === undefined
              ? []
              : [{ artifactId: id, before, after: body.status }];
          }),
        });
      } catch {
        // Swallowed by design: activity capture must never fail the write.
      }

      return successResponse(updatedIds);
    } catch (error) {
      return errorResponse("Failed to update document statuses", error);
    }
  },
  { requiredScopes: ["write"] }
);
