/**
 * ISS-12552: bind a session's operation claims to the
 * receipts the API recorded for its owner's writes. Pure: the caller loads the
 * candidate receipts (already scoped to the session's organization and to its
 * owner, the session artifact's `createdById`) and the receipts other sessions
 * already hold.
 *
 * Binding order, one receipt per claim: the harness call id; then an
 * operation id the write tool's own response returned; then a unique request
 * fingerprint inside the call's invoke-to-result window plus 120 seconds. A
 * shell claim binds only receipts whose printed `clop_` id it carries and
 * that were requested inside its own call window (PRD-800 "Writes
 * made outside the Closedloop MCP"). When another session of the same owner
 * already holds a receipt, the fork rule in receipt-claimants.ts decides who
 * keeps it. Two records of
 * one session synced from different compute targets are copies, never a
 * lineage: the copy with the lowest compute target id keeps the receipt, and
 * copies never tie (PRD-800 "Proving usage").
 */
import {
  OperationEvidenceOutcome,
  parseOperationId,
} from "@repo/api/src/types/attribution-evidence";
import { RECEIPTED_OPERATION_KINDS } from "@repo/api/src/types/closedloop-operation-semantics";
import {
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { ClaimPrecedence, claimPrecedence } from "./receipt-claimants";
import {
  FINGERPRINT_WINDOW_MS,
  receiptKindMatchesClaim,
  receiptOutcome,
} from "./receipt-outcome";
import type { SessionCopyIdentity } from "./transcript-copies";

export type ReceiptCandidate = {
  id: string;
  operationKind: string;
  outcome: string;
  clientCallId: string | null;
  requestFingerprint: string | null;
  requestedAt: Date;
  committedAt: Date | null;
  targetArtifactId: string | null;
  createdArtifactId: string | null;
  versionNumber: number | null;
  changedFields: string[];
  contentDigestBefore: string | null;
  contentDigestAfter: string | null;
};

/** A receipt another session's evidence already holds. */
export type ReceiptHolder = {
  receiptId: string;
  evidenceId: string;
  agentSessionId: string;
  invokedAt: Date | null;
  /** When the holder's session started, for the fork rule's tiebreak. */
  sessionStartedAt: Date | null;
  /**
   * The holder's claim names the receipt by identity (its call id, or an
   * operation id a shell command printed), not only by fingerprint.
   */
  byIdentity: boolean;
  /**
   * The holder is a copy of this session: the same owner, harness and external
   * session id synced from another compute target (PRD-800).
   */
  sameSession: boolean;
  /** The holder's session, for the copy rule. */
  session: SessionCopyIdentity;
  /** For a copy, the holder's compute target id sorts before this session's. */
  canonical: boolean;
  /**
   * The holder's session belongs to another member of the organization. A
   * receipt only ever proves its own principal's session (PRD-800
   * "Proving usage"), so such a holder never keeps it.
   */
  otherOwner: boolean;
  /**
   * The holder lost the receipt to a tie and still contests it, so no claim
   * can take it until the tie is settled.
   */
  tied: boolean;
};

export type ReconciledClaim = {
  claim: OperationClaim;
  /** Unique per session: the claim key, or one per receipt a shell claim binds. */
  rowKey: string;
  receipt?: ReceiptCandidate;
  outcome: OperationEvidenceOutcome;
  /** The receipt this claim ties for and neither claim holds. */
  contestedReceiptId?: string;
  /**
   * Another session's evidence row that gives this receipt up, and what it
   * becomes: a later claim in the lineage, or one tied with this claim.
   */
  displaced?: ReceiptHolder & { outcome: OperationEvidenceOutcome };
};

type ReconcileInput = {
  claims: readonly OperationClaim[];
  receipts: readonly ReceiptCandidate[];
  heldElsewhere: ReadonlyMap<string, ReceiptHolder>;
  /** When this session started, for the fork rule's tiebreak. */
  sessionStartedAt?: Date | null;
};

export function reconcileOperationClaims(
  input: ReconcileInput
): ReconciledClaim[] {
  const used = new Set<string>();
  const results: ReconciledClaim[] = [];
  for (const claim of input.claims) {
    if (claim.source === OperationClaimSource.Shell) {
      results.push(...reconcileShellClaim(claim, input, used));
    } else if (isReceiptedWrite(claim)) {
      results.push(reconcileWriteClaim(claim, input, used));
    } else {
      results.push({
        claim,
        rowKey: claim.claimKey,
        outcome: outcomeFromResult(claim),
      });
    }
  }
  return results;
}

/** The receipt ids a claim names through printed or returned operation ids. */
export function claimedReceiptIds(claim: OperationClaim): string[] {
  return (claim.operationIds ?? []).flatMap(
    (operationId) => parseOperationId(operationId) ?? []
  );
}

function isReceiptedWrite(claim: OperationClaim): boolean {
  return (
    claim.source === OperationClaimSource.ClosedloopMcp &&
    claim.operationKind !== undefined &&
    RECEIPTED_OPERATION_KINDS.has(claim.operationKind)
  );
}

function reconcileWriteClaim(
  claim: OperationClaim,
  input: ReconcileInput,
  used: Set<string>
): ReconciledClaim {
  const free = input.receipts.filter(
    (receipt) =>
      !used.has(receipt.id) &&
      receiptKindMatchesClaim(receipt.operationKind, claim.operationKind)
  );
  const candidates = candidatesFor(claim, free);
  if (candidates.length > 1) {
    return {
      claim,
      rowKey: claim.claimKey,
      outcome: OperationEvidenceOutcome.Ambiguous,
    };
  }
  const [receipt] = candidates;
  if (!receipt) {
    return {
      claim,
      rowKey: claim.claimKey,
      outcome: OperationEvidenceOutcome.AwaitingReceipt,
    };
  }
  return bind(claim, claim.claimKey, receipt, input, used);
}

function candidatesFor(
  claim: OperationClaim,
  free: readonly ReceiptCandidate[]
): ReceiptCandidate[] {
  if (!claim.ambiguous && claim.providerCallId) {
    const byCallId = free.filter(
      (receipt) => receipt.clientCallId === claim.providerCallId
    );
    if (byCallId.length > 0) {
      return byCallId;
    }
  }
  const ids = new Set(claimedReceiptIds(claim));
  const byOperationId = free.filter((receipt) => ids.has(receipt.id));
  if (byOperationId.length > 0) {
    return byOperationId;
  }
  return byFingerprint(claim, free);
}

function byFingerprint(
  claim: OperationClaim,
  free: readonly ReceiptCandidate[]
): ReceiptCandidate[] {
  const window = callWindow(claim, FINGERPRINT_WINDOW_MS);
  if (!(claim.requestFingerprint && window)) {
    return [];
  }
  return free.filter(
    (receipt) =>
      receipt.requestFingerprint === claim.requestFingerprint &&
      inWindow(receipt.requestedAt, window)
  );
}

function reconcileShellClaim(
  claim: OperationClaim,
  input: ReconcileInput,
  used: Set<string>
): ReconciledClaim[] {
  const window = callWindow(claim, 0);
  const ids = new Set(claimedReceiptIds(claim));
  const bound = window
    ? input.receipts.filter(
        (receipt) =>
          ids.has(receipt.id) &&
          !used.has(receipt.id) &&
          receiptKindMatchesClaim(receipt.operationKind, claim.operationKind) &&
          inWindow(receipt.requestedAt, window)
      )
    : [];
  if (bound.length === 0) {
    return [
      {
        claim,
        rowKey: claim.claimKey,
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
      },
    ];
  }
  return bound.map((receipt) =>
    bind(claim, `${claim.claimKey}#${receipt.id}`, receipt, input, used)
  );
}

function bind(
  claim: OperationClaim,
  rowKey: string,
  receipt: ReceiptCandidate,
  input: ReconcileInput,
  used: Set<string>
): ReconciledClaim {
  const holder = input.heldElsewhere.get(receipt.id);
  if (holder?.otherOwner) {
    used.add(receipt.id);
    return {
      claim,
      rowKey,
      receipt,
      outcome: receiptOutcome(receipt.outcome),
      displaced: {
        ...holder,
        outcome: OperationEvidenceOutcome.AwaitingReceipt,
      },
    };
  }
  if (holder?.tied) {
    // The tie outlives a resync of either side; neither claim takes the
    // receipt because the other was rebuilt without it.
    used.add(receipt.id);
    return {
      claim,
      rowKey,
      outcome: OperationEvidenceOutcome.Ambiguous,
      contestedReceiptId: receipt.id,
    };
  }
  if (holder?.sameSession) {
    return bindCopy(claim, rowKey, receipt, holder, used);
  }
  const precedence = holder
    ? forkPrecedence(claim, receipt, holder, input.sessionStartedAt ?? null)
    : ClaimPrecedence.First;
  if (holder && precedence === ClaimPrecedence.Tied) {
    // A fork keeps its parent's call times, so a tie that the session start
    // times do not break names no original: the receipt stays with neither
    // claim rather than with whichever synced first.
    used.add(receipt.id);
    return {
      claim,
      rowKey,
      outcome: OperationEvidenceOutcome.Ambiguous,
      contestedReceiptId: receipt.id,
      displaced: { ...holder, outcome: OperationEvidenceOutcome.Ambiguous },
    };
  }
  if (precedence === ClaimPrecedence.Second) {
    return {
      claim,
      rowKey,
      outcome: OperationEvidenceOutcome.DuplicateInLineage,
    };
  }
  used.add(receipt.id);
  return {
    claim,
    rowKey,
    receipt,
    outcome: receiptOutcome(receipt.outcome),
    ...(holder
      ? {
          displaced: {
            ...holder,
            outcome: OperationEvidenceOutcome.DuplicateInLineage,
          },
        }
      : {}),
  };
}

/** A copy of this session holds the receipt: the canonical copy keeps it. */
function bindCopy(
  claim: OperationClaim,
  rowKey: string,
  receipt: ReceiptCandidate,
  holder: ReceiptHolder,
  used: Set<string>
): ReconciledClaim {
  if (holder.canonical) {
    return {
      claim,
      rowKey,
      outcome: OperationEvidenceOutcome.DuplicateInLineage,
    };
  }
  used.add(receipt.id);
  return {
    claim,
    rowKey,
    receipt,
    outcome: receiptOutcome(receipt.outcome),
    displaced: {
      ...holder,
      outcome: OperationEvidenceOutcome.DuplicateInLineage,
    },
  };
}

/** A read, a reference, or a write with no receipt to bind: the transcript's own result. */
function outcomeFromResult(claim: OperationClaim): OperationEvidenceOutcome {
  switch (claim.resultState) {
    case ToolResultState.Error:
      return OperationEvidenceOutcome.Errored;
    case ToolResultState.Missing:
      return OperationEvidenceOutcome.MissingResult;
    case ToolResultState.SourceTruncated:
      return OperationEvidenceOutcome.Truncated;
    default:
      return OperationEvidenceOutcome.Committed;
  }
}

type Window = { from: number; to: number };

function callWindow(claim: OperationClaim, slackMs: number): Window | null {
  const from = parseTime(claim.invokedAt);
  const to = parseTime(claim.resultAt ?? claim.invokedAt);
  return from === null || to === null ? null : { from, to: to + slackMs };
}

function inWindow(at: Date, window: Window): boolean {
  const time = at.getTime();
  return time >= window.from && time <= window.to;
}

function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * The fork rule between this claim and another session's holder. Two sessions
 * that match a receipt only by fingerprint contest it: a fingerprint does not
 * say which session made the call (receipt-claimants.ts).
 */
function forkPrecedence(
  claim: OperationClaim,
  receipt: ReceiptCandidate,
  holder: ReceiptHolder,
  sessionStartedAt: Date | null
): ClaimPrecedence {
  if (!(holder.byIdentity && matchesByIdentity(claim, receipt))) {
    return ClaimPrecedence.Tied;
  }
  const invokedAt = parseTime(claim.invokedAt);
  return claimPrecedence(
    {
      invokedAt: invokedAt === null ? null : new Date(invokedAt),
      sessionStartedAt,
    },
    holder
  );
}

/** The claim names the receipt by call id or by an operation id it carries. */
export function matchesByIdentity(
  claim: OperationClaim,
  receipt: { id: string; clientCallId: string | null }
): boolean {
  return (
    (!claim.ambiguous &&
      claim.providerCallId !== undefined &&
      claim.providerCallId === receipt.clientCallId) ||
    claimedReceiptIds(claim).includes(receipt.id)
  );
}
