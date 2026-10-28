import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  batchMutationResponse,
  orderBatchResults,
} from "@/lib/batch-mutation-response";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
} from "@/lib/route-utils";
import {
  captureBulkAssignActivity,
  emitBulkAssignSideEffects,
} from "../../bulk-assign-side-effects";
import { sessionBulkAssignItemService } from "../../session-bulk-assign-item-service";
import { bulkAssignReceiptRecorder } from "../../session-operation-receipt";
import { agentSessionBulkAssignBodySchema } from "../../validators";

/**
 * POST /agent-sessions/bulk-assign/v2 — the v1 request body, answered with one
 * result per distinct requested session id (ISS-9464). v1 is unchanged.
 *
 * Still ALL-OR-NOTHING (ISS-8649): a set containing an id outside the caller's
 * org, or absent, writes nothing. Instead of v1's bare 404, the response names
 * those ids `artifacts_not_found` and every other id `batch_refused`.
 *
 * Status mapping:
 *  - 200 — every id assigned, or a per-id refusal reported item by item
 *  - 400 — Zod failure (empty set, over cap, malformed id), or a target project
 *          or owner outside the caller's org
 *  - 500 — uncaught service error
 */
export const POST = withAnyAuth<
  BatchMutationResponse,
  "/agent-sessions/bulk-assign/v2"
>(
  withOperationReceipts(
    OperationKind.UpdateFields,
    async ({ authMethod, user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          agentSessionBulkAssignBodySchema
        );
        if (parseError) {
          return parseError;
        }

        const transactionId = newBulkTransactionId();
        const recordReceipts = bulkAssignReceiptRecorder(receipts, body.field);
        // ISS-10993: the write and its activity receipt share ONE transaction —
        // the WRITE's, handed in as a callback rather than opened around the call.
        // A transaction opened here would be joined rather than nested by the
        // service's own `withDb.tx`, so the all-or-nothing refusal would not roll
        // back and the per-item labelling read would run against the partial
        // write it exists to report as refused.
        const result = await sessionBulkAssignItemService.bulkAssign(
          {
            organizationId: user.organizationId,
            sessionIds: body.sessionIds,
            field: body.field,
            value: body.value,
          },
          async (tx, commit) => {
            await captureBulkAssignActivity(tx, {
              user,
              authMethod,
              field: body.field,
              changes: commit.changes,
              transactionId,
            });
            await recordReceipts?.(tx, commit.changes);
          }
        );
        if (result.ok) {
          emitBulkAssignSideEffects({
            user,
            authMethod,
            field: body.field,
            changes: result.value.changes,
            transactionId,
          });
          return batchMutationResponse(
            orderBatchResults(body.sessionIds, result.value.results),
            transactionId
          );
        }
        if (result.error === Status.BadRequest) {
          return badRequestResponse(
            "Unknown project or owner for this organization"
          );
        }
        return errorResponse("Failed to assign agent sessions", result.error);
      } catch (error) {
        return errorResponse("Failed to assign agent sessions", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
