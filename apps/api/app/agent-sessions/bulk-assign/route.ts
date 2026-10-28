import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  captureBulkAssignActivity,
  emitBulkAssignSideEffects,
} from "../bulk-assign-side-effects";
import { bulkAssignReceiptRecorder } from "../session-operation-receipt";
import { sessionWriteService } from "../session-write-service";
import { agentSessionBulkAssignBodySchema } from "../validators";
import type { AgentSessionBulkAssignResponse } from "../write-contract";

/**
 * POST /agent-sessions/bulk-assign — assign a project or an owner to a set of
 * sessions (ISS-8649), backing the `projects` and `owners` bulk-action
 * descriptors the Sessions rail renders.
 *
 * The rail's third command, `tags`, is NOT served here: bulk tag
 * application already exists at `POST /entity-tags/batch`
 * (`tagService.batchApplyTag`), which writes `tagArtifact` rows for any artifact
 * type and validates every id against the caller's org first. A second bulk-tag
 * path would be a duplicate write surface for one contract.
 *
 * ALL-OR-NOTHING by construction. Every id is authorized individually — the
 * caller's `organizationId` is part of the write predicate, so an id from
 * another org matches nothing — and the row count the database reports is then
 * compared against the requested id count inside the transaction. A set mixing
 * an authorized and an unauthorized (or deleted) id therefore refuses whole and
 * leaves every row unchanged, instead of applying the authorized subset.
 *
 * Status mapping (apps/api/AGENTS.md "Errors as values"):
 *  - 200 — every id assigned
 *  - 400 — Zod failure (empty set, over cap, malformed id), or a target project
 *          or owner outside the caller's org
 *  - 404 — at least one id is absent or outside the caller's org; nothing written
 *  - 500 — uncaught service error
 */
export const POST = withAnyAuth<
  AgentSessionBulkAssignResponse,
  typeof BatchMutationRoute.AgentSessionsAssign
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
        // service's own `withDb.tx`, and the all-or-nothing refusal below only
        // rolls back while that one is outermost.
        const result = await sessionWriteService.bulkAssignSessions(
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
          return successResponse(result.value.response);
        }
        if (result.error === Status.NotFound) {
          return notFoundResponse("Agent session");
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
