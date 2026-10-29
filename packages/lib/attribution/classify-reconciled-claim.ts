/**
 * ISS-12552: the relationship one reconciled claim gives its target, shared by
 * the evidence the API persists and the golden Layer 1 suite. A reference
 * claim is a reference. Every other claim is classified as the operation it
 * was, whether or not its target resolved: PRD-800 "Operation evidence and
 * classification" keeps a denied, errored or failed call as unresolved
 * evidence and a successful list or search as a read, never as a mention.
 * A bound receipt is the record of the operation, so its kind and artifact
 * decide, never the claim's (the late binder and the backfill classify the
 * same way through `classifyBoundReceipt`).
 */
import {
  AttributionRelationshipKind,
  type OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import { OperationClaimSource } from "@repo/api/src/types/operation-claims";
import {
  classifyOperation,
  type OperationClassification,
} from "./classify-operation";
import { receiptContentChanged, storedOperationKind } from "./receipt-outcome";
import type {
  ReceiptCandidate,
  ReconciledClaim,
} from "./reconcile-operation-claims";

export type ReconciledClaimClassification = OperationClassification & {
  operationKind: OperationKind;
  /** A bound receipt's artifact, else the observed target; null when neither resolved. */
  targetArtifactId: string | null;
};

export function classifyReconciledClaim(
  entry: ReconciledClaim,
  observedArtifactId: string | null
): ReconciledClaimClassification {
  const { claim, receipt } = entry;
  if (receipt) {
    return classifyBoundReceipt(receipt, entry.outcome);
  }
  const operationKind = claim.operationKind ?? OperationKind.Unsupported;
  if (claim.source === OperationClaimSource.Reference) {
    return {
      operationKind,
      targetArtifactId: observedArtifactId,
      kind: AttributionRelationshipKind.Reference,
    };
  }
  return {
    operationKind,
    targetArtifactId: observedArtifactId,
    ...classifyOperation({
      operationKind,
      outcome: entry.outcome,
      targetMatched: true,
    }),
  };
}

export type BoundReceipt = Pick<
  ReceiptCandidate,
  | "operationKind"
  | "targetArtifactId"
  | "createdArtifactId"
  | "changedFields"
  | "contentDigestBefore"
  | "contentDigestAfter"
>;

/** What a bound receipt proves: its own operation, on its own artifact. */
export function classifyBoundReceipt(
  receipt: BoundReceipt,
  outcome: OperationEvidenceOutcome
): ReconciledClaimClassification {
  const operationKind = storedOperationKind(receipt.operationKind);
  return {
    operationKind,
    targetArtifactId:
      operationKind === OperationKind.Create
        ? receipt.createdArtifactId
        : receipt.targetArtifactId,
    ...classifyOperation({
      operationKind,
      outcome,
      targetMatched: true,
      contentChanged: receiptContentChanged(receipt),
      changedFields: receipt.changedFields,
    }),
  };
}
