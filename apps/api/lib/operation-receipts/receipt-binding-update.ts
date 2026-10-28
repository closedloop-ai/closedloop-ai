/**
 * ISS-12552: the evidence fields a bound receipt decides. Not `server-only`:
 * the historical backfill runs it under `tsx` as a script.
 */
import {
  OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import {
  ATTRIBUTION_POLICY_VERSION,
  classifyOperation,
} from "@repo/lib/attribution/classify-operation";
import { classifyBoundReceipt } from "@repo/lib/attribution/classify-reconciled-claim";
import { receiptOutcome } from "@repo/lib/attribution/receipt-outcome";

export type BindableReceipt = {
  id: string;
  operationKind: string;
  outcome: string;
  targetArtifactId: string | null;
  createdArtifactId: string | null;
  committedAt: Date | null;
  changedFields: string[];
  versionNumber: number | null;
  contentDigestBefore: string | null;
  contentDigestAfter: string | null;
};

/**
 * Classified under the current policy; shared by the late binder and the
 * backfill, and classified as sync reconciliation classifies a bound receipt.
 */
export function receiptBindingUpdate(receipt: BindableReceipt) {
  const outcome = receiptOutcome(receipt.outcome);
  const classification = classifyBoundReceipt(receipt, outcome);
  return {
    receiptId: receipt.id,
    contestedReceiptId: null,
    outcome,
    targetArtifactId: classification.targetArtifactId,
    relationshipKind: classification.kind,
    unresolvedReason: classification.unresolvedReason ?? null,
    effectiveAt: receipt.committedAt,
    changedFields: receipt.changedFields,
    versionNumber: receipt.versionNumber,
    policyVersion: ATTRIBUTION_POLICY_VERSION,
  };
}

/**
 * The fields of an evidence row that gives its receipt up, or never takes it:
 * a later claim in an owner's lineage, a non-canonical copy of one session, or
 * one of two claims tied at the same instant, which keeps contesting the
 * receipt so a later sync of either side cannot take it. Nothing the receipt
 * decided stays on the row (PRD-800 "Revision": consumers replace
 * projections), so a duplicate never shows another row's durable change. A row
 * that held the receipt also drops the target the receipt gave it; a row that
 * never held one keeps the target its own call named.
 */
export function releasedReceiptUpdate(
  outcome: OperationEvidenceOutcome,
  receiptId: string,
  release: { heldReceipt: boolean } = { heldReceipt: false }
) {
  const released = classifyOperation({
    operationKind: OperationKind.Unsupported,
    outcome,
    targetMatched: true,
  });
  return {
    receiptId: null,
    contestedReceiptId:
      outcome === OperationEvidenceOutcome.Ambiguous ? receiptId : null,
    outcome,
    relationshipKind: released.kind,
    unresolvedReason: released.unresolvedReason ?? null,
    effectiveAt: null,
    changedFields: [],
    versionNumber: null,
    ...(release.heldReceipt ? { targetArtifactId: null } : {}),
  };
}
