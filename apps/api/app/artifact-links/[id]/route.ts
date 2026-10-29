import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { blockedDependentUnblockService } from "@/app/documents/blocked-dependent-unblock-service";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { createOperationReceiptRecorder } from "@/lib/operation-receipts/operation-receipt-recorder";
import { deleteResponse, errorResponse } from "@/lib/route-utils";
import { readLinkWriteAttributionEvidence } from "../link-implementation-evidence";
import { artifactLinksService } from "../service";

export const DELETE = withAnyAuth<{ deleted: true }, "/artifact-links/[id]">(
  (auth, request, params) =>
    // ISS-12552: the receipt and the derivation share the organization's answer.
    runWithAttributionEvidenceGate(async () => {
      const { user } = auth;
      try {
        const routeParams = await params;
        const receipts = await createOperationReceiptRecorder(
          auth,
          request,
          routeParams
        );
        const { id } = routeParams;
        await readLinkWriteAttributionEvidence(user.organizationId);
        const { unblockCandidateIds } = await artifactLinksService.deleteLink(
          id,
          user.organizationId,
          // ISS-12552: a delete that matched no row changed nothing.
          receipts.whenRecording<{ deleted: boolean }>((tx, { deleted }) =>
            receipts.record(tx, {
              operationKind: OperationKind.LinkDelete,
              outcome: deleted
                ? OperationReceiptOutcome.Committed
                : OperationReceiptOutcome.NoOp,
              ...(deleted ? { linkId: id } : {}),
            })
          )
        );
        // ISS-9632: removing a `BLOCKS` edge resolves that blocker, so the
        // dependent may now have nothing live holding it. Awaited but internally
        // best-effort — it cannot fail a delete that already committed.
        await blockedDependentUnblockService.resolveBlocksForRemovedEdges({
          organizationId: user.organizationId,
          dependentIds: unblockCandidateIds,
        });
        await receipts.settle();
        return deleteResponse(receipts.receipt);
      } catch (error) {
        return errorResponse("Failed to delete artifact link", error);
      }
    }),
  { requiredScopes: ["delete"] }
);
