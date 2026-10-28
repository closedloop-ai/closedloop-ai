/**
 * ISS-12552: who already holds, contests or waits on a receipt a session's
 * claims could bind, read and settled the same way by sync reconciliation, the
 * late receipt binder and the historical backfill. Who keeps a receipt is
 * `resolveReceiptClaimants` (receipt-claimants.ts): the copy rule within one
 * session (PRD-800 "Proving usage") and the fork rule between
 * sessions of one owner.
 */
import { OperationEvidenceOutcome } from "@repo/api/src/types/attribution-evidence";
import {
  type OperationClaim,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import {
  type ClaimantResolution,
  type ReceiptClaimant,
  resolveReceiptClaimants,
} from "@repo/lib/attribution/receipt-claimants";
import {
  FINGERPRINT_WINDOW_MS,
  receiptKindMatchesClaim,
} from "@repo/lib/attribution/receipt-outcome";
import {
  matchesByIdentity,
  type ReceiptHolder,
  type ReconciledClaim,
} from "@repo/lib/attribution/reconcile-operation-claims";
import {
  isCanonicalComputeTarget,
  isSameSession,
  type SessionCopyIdentity,
} from "@repo/lib/attribution/transcript-copies";
import { z } from "zod";
import {
  type BindableReceipt,
  receiptBindingUpdate,
  releasedReceiptUpdate,
} from "@/lib/operation-receipts/receipt-binding-update";
import type { AgentSessionUpsertTx } from "../records";

type SessionScope = { organizationId: string; agentSessionId: string };

/** A session record as the copy and fork rules read it. */
export type SessionRuleIdentity = SessionCopyIdentity & {
  sessionStartedAt: Date | null;
};

export async function loadHeldElsewhere(
  tx: AgentSessionUpsertTx,
  session: SessionScope,
  owner: string | null,
  receipts: readonly { id: string; clientCallId: string | null }[]
): Promise<Map<string, ReceiptHolder>> {
  if (receipts.length === 0 || owner === null) {
    return new Map();
  }
  const receiptIds = receipts.map((receipt) => receipt.id);
  const callIds = new Map(
    receipts.map((receipt) => [receipt.id, receipt.clientCallId])
  );
  const own = await readSessionIdentity(tx, session.agentSessionId);
  // Organization-wide, not owner-scoped: a receipt is bound to at most one
  // claim (agent_session_operation_evidence_receipt_key), so every holder must
  // be seen here or the bind below would fail the sync on that index. Only the
  // owner's sessions are copies of this one. A claim that tied for a receipt
  // still contests it after the tie released it.
  const rows = await tx.agentSessionOperationEvidence.findMany({
    where: {
      organizationId: session.organizationId,
      agentSessionId: { not: session.agentSessionId },
      OR: [
        { receiptId: { in: receiptIds } },
        { contestedReceiptId: { in: receiptIds } },
      ],
    },
    select: {
      id: true,
      agentSessionId: true,
      receiptId: true,
      contestedReceiptId: true,
      invokedAt: true,
      source: true,
      providerCallId: true,
      session: {
        select: {
          ...SESSION_IDENTITY_SELECT,
          artifact: { select: { createdById: true } },
        },
      },
    },
  });
  const holders = new Map<string, ReceiptHolder>();
  for (const row of rows) {
    const receiptId = row.receiptId ?? row.contestedReceiptId;
    const otherOwner = row.session.artifact.createdById !== owner;
    const seen = receiptId ? holders.get(receiptId) : undefined;
    // An owner's holder or tie is settled before another member's row, which
    // is only ever displaced.
    if (!receiptId || seen?.tied || (seen && otherOwner)) {
      continue;
    }
    const sameSession =
      own !== null && !otherOwner && isSameSession(row.session, own);
    const callId = callIds.get(receiptId) ?? null;
    holders.set(receiptId, {
      receiptId,
      evidenceId: row.id,
      agentSessionId: row.agentSessionId,
      invokedAt: row.invokedAt,
      sessionStartedAt: row.session.sessionStartedAt,
      byIdentity:
        row.source === OperationClaimSource.Shell ||
        (callId !== null && row.providerCallId === callId),
      session: {
        harness: row.session.harness,
        externalSessionId: row.session.externalSessionId,
        computeTargetId: row.session.computeTargetId,
      },
      sameSession,
      canonical:
        sameSession &&
        own !== null &&
        isCanonicalComputeTarget(
          row.session.computeTargetId,
          own.computeTargetId
        ),
      otherOwner,
      tied: row.receiptId === null,
    });
  }
  return holders;
}

/** An unbound MCP write claim waiting in another session of the owner. */
export type RivalClaim = {
  evidenceId: string;
  agentSessionId: string;
  operationKind: string;
  providerCallId: string | null;
  requestFingerprint: string | null;
  invokedAt: Date | null;
  anchors: unknown;
  session: SessionCopyIdentity;
  sessionStartedAt: Date | null;
};

/**
 * The unbound MCP write claims the owner's other sessions (copies and forks
 * alike) hold for the same calls, by call id or fingerprint, so a receipt is
 * settled among all of them whichever session is read first.
 */
export async function loadRivalClaims(
  tx: AgentSessionUpsertTx,
  session: SessionScope,
  owner: string,
  keys: { callIds: readonly string[]; fingerprints: readonly string[] }
): Promise<RivalClaim[]> {
  if (keys.callIds.length === 0 && keys.fingerprints.length === 0) {
    return [];
  }
  const rows = await tx.agentSessionOperationEvidence.findMany({
    where: {
      organizationId: session.organizationId,
      agentSessionId: { not: session.agentSessionId },
      receiptId: null,
      outcome: { notIn: [...SETTLED_OUTCOMES] },
      session: { artifact: { createdById: owner } },
      OR: [
        { providerCallId: { in: [...keys.callIds] } },
        { requestFingerprint: { in: [...keys.fingerprints] } },
      ],
    },
    select: {
      id: true,
      agentSessionId: true,
      operationKind: true,
      providerCallId: true,
      requestFingerprint: true,
      invokedAt: true,
      anchors: true,
      session: { select: SESSION_IDENTITY_SELECT },
    },
  });
  return rows.map((row) => ({
    evidenceId: row.id,
    agentSessionId: row.agentSessionId,
    operationKind: row.operationKind,
    providerCallId: row.providerCallId,
    requestFingerprint: row.requestFingerprint,
    invokedAt: row.invokedAt,
    anchors: row.anchors,
    session: {
      harness: row.session.harness,
      externalSessionId: row.session.externalSessionId,
      computeTargetId: row.session.computeTargetId,
    },
    sessionStartedAt: row.session.sessionStartedAt,
  }));
}

/** A claim settled among a receipt's claimants; the caller's own has no row id. */
export type SettledClaimant = ReceiptClaimant & {
  evidenceId: string | null;
  /** The claim's row holds the receipt now. */
  heldReceipt: boolean;
};

/** What a rival's candidate test reads from a receipt. */
export type ClaimableReceipt = BindableReceipt & {
  clientCallId: string | null;
  requestFingerprint: string | null;
  requestedAt: Date;
};

/**
 * The rivals for the same call as `claim` that could bind the receipt
 * themselves: the same operation, and its call id, else its fingerprint
 * requested inside the rival's call window. A rival that cannot bind this
 * receipt is another call, so it neither takes the receipt nor yields to it.
 */
export function rivalsFor(
  rivals: readonly RivalClaim[],
  claim: { providerCallId: string | null; requestFingerprint: string | null },
  receipt: ClaimableReceipt
): SettledClaimant[] {
  return rivals
    .filter((rival) => isSameCall(rival, claim) && canBind(rival, receipt))
    .map((rival) => ({
      evidenceId: rival.evidenceId,
      agentSessionId: rival.agentSessionId,
      session: rival.session,
      invokedAt: rival.invokedAt,
      sessionStartedAt: rival.sessionStartedAt,
      byIdentity:
        rival.providerCallId !== null &&
        rival.providerCallId === receipt.clientCallId,
      heldReceipt: false,
    }));
}

/** The holder of a receipt, as a claimant the rules can weigh against others. */
export function holderClaimant(holder: ReceiptHolder): SettledClaimant {
  return {
    evidenceId: holder.evidenceId,
    agentSessionId: holder.agentSessionId,
    session: holder.session,
    invokedAt: holder.invokedAt,
    sessionStartedAt: holder.sessionStartedAt,
    byIdentity: holder.byIdentity,
    heldReceipt: true,
  };
}

/**
 * Writes a resolution to the claimants' rows: losers first, so the receipt's
 * unique holder index is free when the winner binds. The caller's own claim
 * (no row id) is the caller's to write. Returns the sessions whose evidence
 * changed, with their links marked stale until the post-commit link sync.
 */
export async function applyClaimantResolution(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  receipt: BindableReceipt,
  resolution: ClaimantResolution<SettledClaimant>
): Promise<string[]> {
  const touched = new Set<string>();
  for (const [outcome, claimants] of [
    [OperationEvidenceOutcome.DuplicateInLineage, resolution.duplicates],
    [OperationEvidenceOutcome.Ambiguous, resolution.contested],
  ] as const) {
    for (const heldReceipt of [true, false]) {
      const rows = claimants.filter(
        (claim) =>
          claim.evidenceId !== null && claim.heldReceipt === heldReceipt
      );
      if (rows.length === 0) {
        continue;
      }
      await tx.agentSessionOperationEvidence.updateMany({
        where: {
          organizationId,
          id: { in: rows.flatMap((claim) => claim.evidenceId ?? []) },
        },
        data: releasedReceiptUpdate(outcome, receipt.id, { heldReceipt }),
      });
      for (const claim of rows) {
        touched.add(claim.agentSessionId);
      }
    }
  }
  const { holder } = resolution;
  if (holder?.evidenceId && !holder.heldReceipt) {
    const { count } = await tx.agentSessionOperationEvidence.updateMany({
      where: { organizationId, id: holder.evidenceId, receiptId: null },
      data: receiptBindingUpdate(receipt),
    });
    if (count > 0) {
      touched.add(holder.agentSessionId);
    }
  }
  if (touched.size > 0) {
    await tx.agentSessionOperationEvidenceSnapshot.updateMany({
      where: { organizationId, agentSessionId: { in: [...touched] } },
      data: { linksSyncedDigest: null },
    });
  }
  return [...touched];
}

/**
 * When a claim's call window ends: its anchored result time, else its call
 * time. NaN when neither is a time.
 */
export function claimWindowEnd(row: {
  anchors: unknown;
  invokedAt: Date | null;
}): number {
  const resultAt = anchorsSchema.safeParse(row.anchors).data?.resultAt;
  return Date.parse(resultAt ?? row.invokedAt?.toISOString() ?? "");
}

export function readSessionIdentity(
  tx: AgentSessionUpsertTx,
  agentSessionId: string
): Promise<SessionRuleIdentity | null> {
  return tx.sessionDetail.findUnique({
    where: { artifactId: agentSessionId },
    select: SESSION_IDENTITY_SELECT,
  });
}

/**
 * Sync's half of the rules for receipts other sessions wait on. A receipt a
 * synced write claim bound is settled against the unbound claims the owner's
 * other sessions hold for the same call, as the late binder would have
 * settled it had it seen them all (PRD-800: "an entry both copies
 * hold ... belongs to the copy on the lowest compute target id"; the fork
 * rule between sessions). Holders are already settled by reconciliation, so
 * only waiting claims are read here.
 */
export async function settleSyncedClaimsWithRivals(
  tx: AgentSessionUpsertTx,
  session: SessionScope,
  owner: string | null,
  reconciled: readonly ReconciledClaim[]
): Promise<{ settled: ReconciledClaim[]; touchedSessionIds: string[] }> {
  const bound = reconciled.filter(
    (entry) =>
      entry.receipt !== undefined &&
      entry.claim.source === OperationClaimSource.ClosedloopMcp
  );
  const own =
    owner === null || bound.length === 0
      ? null
      : await readSessionIdentity(tx, session.agentSessionId);
  const rivals =
    owner === null || own === null
      ? []
      : await loadRivalClaims(tx, session, owner, {
          callIds: bound.flatMap((entry) => entry.claim.providerCallId ?? []),
          fingerprints: bound.flatMap(
            (entry) => entry.claim.requestFingerprint ?? []
          ),
        });
  if (own === null || rivals.length === 0) {
    return { settled: [...reconciled], touchedSessionIds: [] };
  }
  const touched = new Set<string>();
  const settled: ReconciledClaim[] = [];
  for (const entry of reconciled) {
    const { receipt, ...unbound } = entry;
    const competing =
      receipt && bound.includes(entry)
        ? rivalsFor(rivals, claimCallKeys(entry.claim), receipt)
        : [];
    if (!receipt || competing.length === 0) {
      settled.push(entry);
      continue;
    }
    const self: SettledClaimant = {
      evidenceId: null,
      agentSessionId: session.agentSessionId,
      session: own,
      invokedAt: parseClaimTime(entry.claim.invokedAt),
      sessionStartedAt: own.sessionStartedAt,
      byIdentity: matchesByIdentity(entry.claim, receipt),
      heldReceipt: false,
    };
    const resolution = resolveReceiptClaimants([self, ...competing]);
    if (!resolution) {
      settled.push(entry);
      continue;
    }
    for (const id of await applyClaimantResolution(
      tx,
      session.organizationId,
      receipt,
      resolution
    )) {
      touched.add(id);
    }
    settled.push(selfOutcome(entry, unbound, resolution, self, receipt.id));
  }
  return { settled, touchedSessionIds: [...touched] };
}

const anchorsSchema = z.object({ resultAt: z.string().optional() }).loose();

/** A claim already settled against another claimant binds nothing. */
const SETTLED_OUTCOMES = [
  OperationEvidenceOutcome.DuplicateInLineage,
  OperationEvidenceOutcome.Ambiguous,
] as const;

const SESSION_IDENTITY_SELECT = {
  harness: true,
  externalSessionId: true,
  computeTargetId: true,
  sessionStartedAt: true,
} as const;

/** The same call in another session: the same call id, else the same fingerprint. */
function isSameCall(
  rival: RivalClaim,
  claim: { providerCallId: string | null; requestFingerprint: string | null }
): boolean {
  if (claim.providerCallId !== null) {
    return rival.providerCallId === claim.providerCallId;
  }
  return (
    claim.requestFingerprint !== null &&
    rival.requestFingerprint === claim.requestFingerprint
  );
}

function canBind(rival: RivalClaim, receipt: ClaimableReceipt): boolean {
  if (!receiptKindMatchesClaim(receipt.operationKind, rival.operationKind)) {
    return false;
  }
  if (rival.providerCallId !== null) {
    return receipt.clientCallId === rival.providerCallId;
  }
  const end = claimWindowEnd(rival);
  return (
    rival.requestFingerprint !== null &&
    receipt.requestFingerprint === rival.requestFingerprint &&
    rival.invokedAt !== null &&
    receipt.requestedAt >= rival.invokedAt &&
    !Number.isNaN(end) &&
    receipt.requestedAt.getTime() <= end + FINGERPRINT_WINDOW_MS
  );
}

function claimCallKeys(claim: OperationClaim): {
  providerCallId: string | null;
  requestFingerprint: string | null;
} {
  return {
    providerCallId: claim.providerCallId ?? null,
    requestFingerprint: claim.requestFingerprint ?? null,
  };
}

function selfOutcome(
  entry: ReconciledClaim,
  unbound: Omit<ReconciledClaim, "receipt">,
  resolution: ClaimantResolution<SettledClaimant>,
  self: SettledClaimant,
  receiptId: string
): ReconciledClaim {
  if (resolution.holder === self) {
    return entry;
  }
  if (resolution.contested.includes(self)) {
    return {
      ...unbound,
      outcome: OperationEvidenceOutcome.Ambiguous,
      contestedReceiptId: receiptId,
    };
  }
  return { ...unbound, outcome: OperationEvidenceOutcome.DuplicateInLineage };
}

function parseClaimTime(value: string | undefined): Date | null {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time) ? null : new Date(time);
}
