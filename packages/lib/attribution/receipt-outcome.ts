/**
 * ISS-12552: what a stored receipt says, read back into the evidence
 * vocabulary. Shared by sync reconciliation and binding at receipt write so
 * the two can never read a receipt differently.
 */
import {
  OperationEvidenceOutcome,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";

/** Slack after a call's result for a fingerprint match. */
export const FINGERPRINT_WINDOW_MS = 120_000;

/** A receipt's stored outcome; one this reader does not know is ambiguous. */
export function receiptOutcome(outcome: string): OperationEvidenceOutcome {
  switch (outcome) {
    case OperationEvidenceOutcome.Committed:
      return OperationEvidenceOutcome.Committed;
    case OperationEvidenceOutcome.NoOp:
      return OperationEvidenceOutcome.NoOp;
    case OperationEvidenceOutcome.Rejected:
      return OperationEvidenceOutcome.Rejected;
    default:
      return OperationEvidenceOutcome.Ambiguous;
  }
}

const KNOWN_OPERATION_KINDS: readonly string[] = Object.values(OperationKind);

function isOperationKind(value: string): value is OperationKind {
  return KNOWN_OPERATION_KINDS.includes(value);
}

/** A stored operation kind; one this reader does not know is unsupported. */
export function storedOperationKind(value: string): OperationKind {
  return isOperationKind(value) ? value : OperationKind.Unsupported;
}

/**
 * A version receipt whose content digest moved. A null before-digest is a
 * previous version with no content, so the first content saved onto it is a
 * change; a null after-digest records no content to have changed to.
 */
export function receiptContentChanged(receipt: {
  contentDigestBefore: string | null;
  contentDigestAfter: string | null;
}): boolean {
  return (
    receipt.contentDigestAfter !== null &&
    receipt.contentDigestBefore !== receipt.contentDigestAfter
  );
}

const KNOWN_EVIDENCE_OUTCOMES: readonly string[] = Object.values(
  OperationEvidenceOutcome
);

function isEvidenceOutcome(value: string): value is OperationEvidenceOutcome {
  return KNOWN_EVIDENCE_OUTCOMES.includes(value);
}

/** A stored evidence outcome; one this reader does not know is ambiguous. */
export function storedEvidenceOutcome(value: string): OperationEvidenceOutcome {
  return isEvidenceOutcome(value) ? value : OperationEvidenceOutcome.Ambiguous;
}

/**
 * A receipt binds a claim only when the claim names no operation or names the
 * receipt's: a claim cannot borrow another operation's receipt to claim a
 * write it never made. A shell claim names none; its printed operation id is
 * the binding.
 */
export function receiptKindMatchesClaim(
  receiptOperationKind: string,
  claimOperationKind: string | null | undefined
): boolean {
  return (
    claimOperationKind === null ||
    claimOperationKind === undefined ||
    storedOperationKind(receiptOperationKind) === claimOperationKind
  );
}
