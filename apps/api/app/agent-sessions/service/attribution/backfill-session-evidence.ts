/**
 * ISS-12552: re-reconcile one session's stored evidence.
 * Binds unbound MCP claims to receipts written since (by call id, else a
 * unique fingerprint inside the call window), settled among the owner's other
 * sessions' claims for the same call by the copy and fork rules sync and the
 * late binder apply (receipt-claimants.ts),
 * corroborates pre-receipt document writes only from a document version the
 * session owner created on the claim's observed target inside its window, and
 * reclassifies rows an older policy wrote. The runner syncs the session's
 * evidence links under its organization's flag answer once this commits. Every
 * change is an in-place update, and a row already bound or corroborated is left
 * alone, so a second run changes nothing.
 * Missing proof is never inferred: a session with no synced evidence is
 * counted, not given evidence.
 */
import {
  OperationEvidenceOutcome,
  OperationKind,
  OperationSource,
  UnresolvedReason,
} from "@repo/api/src/types/attribution-evidence";
import { RECEIPTED_OPERATION_KINDS } from "@repo/api/src/types/closedloop-operation-semantics";
import type { Prisma } from "@repo/database";
import {
  ATTRIBUTION_POLICY_VERSION,
  classifyOperation,
} from "@repo/lib/attribution/classify-operation";
import { resolveReceiptClaimants } from "@repo/lib/attribution/receipt-claimants";
import {
  FINGERPRINT_WINDOW_MS,
  receiptKindMatchesClaim,
  storedOperationKind,
} from "@repo/lib/attribution/receipt-outcome";
import type { ReceiptHolder } from "@repo/lib/attribution/reconcile-operation-claims";
import {
  receiptBindingUpdate,
  releasedReceiptUpdate,
} from "@/lib/operation-receipts/receipt-binding-update";
import type { AgentSessionUpsertTx } from "../records";
import {
  applyClaimantResolution,
  claimWindowEnd,
  holderClaimant,
  loadHeldElsewhere,
  loadRivalClaims,
  readSessionIdentity,
  rivalsFor,
  type SessionRuleIdentity,
  type SettledClaimant,
} from "./receipt-holders";

export type SessionBackfillResult = {
  noRetainedProof: boolean;
  bound: number;
  corroborated: number;
  reclassified: number;
  /** Writes still awaiting a receipt a day later, finalized as missing. */
  finalized: number;
  /**
   * Other sessions whose receipt binding the run changed: a canonical copy or
   * fork parent that took a receipt, or a displaced holder. Their links are
   * synced with this session's once the run's transaction commits.
   */
  bindingChangedSessionIds: string[];
};

/**
 * The rows the backfill reads. Only MCP claims bind or are corroborated; a
 * shell claim binds only at sync, inside its own call window, and is read here
 * to be finalized.
 */
const BACKFILLED_SOURCES = [
  OperationSource.Mcp,
  OperationSource.HistoricalRecord,
  OperationSource.Shell,
] as const;

/** How long a write may wait for its receipt. */
const AWAITING_RECEIPT_FINALIZE_MS = 24 * 60 * 60 * 1000;

/** Writes that leave a document version a backfill can corroborate. */
const VERSIONED_KINDS: ReadonlySet<string> = new Set([
  OperationKind.Create,
  OperationKind.CreateVersion,
]);
/**
 * A later copy in a lineage, and a claim tied with another session's for one
 * receipt, are settled by sync reconciliation; the backfill never hands either
 * a receipt or a version.
 */
const UNBINDABLE_OUTCOMES: ReadonlySet<string> = new Set([
  OperationEvidenceOutcome.DuplicateInLineage,
  OperationEvidenceOutcome.Ambiguous,
]);

type EvidenceRow = Prisma.AgentSessionOperationEvidenceGetPayload<{
  select: typeof EVIDENCE_SELECT;
}>;

const EVIDENCE_SELECT = {
  id: true,
  organizationId: true,
  receiptId: true,
  operationKind: true,
  outcome: true,
  source: true,
  unresolvedReason: true,
  providerCallId: true,
  requestFingerprint: true,
  invokedAt: true,
  anchors: true,
  targetArtifactId: true,
  observedTarget: true,
  versionNumber: true,
  policyVersion: true,
} as const;

const RECEIPT_SELECT = {
  id: true,
  operationKind: true,
  outcome: true,
  clientCallId: true,
  requestFingerprint: true,
  requestedAt: true,
  targetArtifactId: true,
  createdArtifactId: true,
  committedAt: true,
  changedFields: true,
  versionNumber: true,
  contentDigestBefore: true,
  contentDigestAfter: true,
} as const;

export async function backfillSessionEvidence(
  tx: AgentSessionUpsertTx,
  session: { organizationId: string; agentSessionId: string },
  now: Date = new Date()
): Promise<SessionBackfillResult> {
  const result: SessionBackfillResult = {
    noRetainedProof: false,
    bound: 0,
    corroborated: 0,
    reclassified: 0,
    finalized: 0,
    bindingChangedSessionIds: [],
  };
  const [snapshot, artifact] = await Promise.all([
    tx.agentSessionOperationEvidenceSnapshot.findFirst({
      where: {
        agentSessionId: session.agentSessionId,
        organizationId: session.organizationId,
      },
      select: { agentSessionId: true },
    }),
    tx.artifact.findFirst({
      where: {
        id: session.agentSessionId,
        organizationId: session.organizationId,
      },
      select: { createdById: true },
    }),
  ]);
  if (!snapshot) {
    return { ...result, noRetainedProof: true };
  }
  const owner = artifact?.createdById;
  if (!owner) {
    return result;
  }
  const rows = await tx.agentSessionOperationEvidence.findMany({
    where: {
      organizationId: session.organizationId,
      agentSessionId: session.agentSessionId,
      source: { in: [...BACKFILLED_SOURCES] },
    },
    orderBy: [{ invokedAt: "asc" }, { id: "asc" }],
    select: EVIDENCE_SELECT,
  });
  const changed = new Set<string>();
  result.bound = await bindReceipts(tx, session, owner, rows, changed);
  changed.delete(session.agentSessionId);
  result.bindingChangedSessionIds = [...changed];
  result.corroborated = await corroborateVersions(
    tx,
    session.organizationId,
    owner,
    rows
  );
  result.reclassified = await reclassifyBound(tx, session.organizationId, rows);
  result.finalized = await finalizeUnreceipted(tx, session, rows, now);
  return result;
}

/**
 * A write still awaiting its receipt a day after the call is
 * finalized as having no result. A shell claim whose printed operation id
 * never bound is finalized the same way, so a resync with the same
 * digest finds nothing waiting and changes nothing.
 */
async function finalizeUnreceipted(
  tx: AgentSessionUpsertTx,
  session: { organizationId: string; agentSessionId: string },
  rows: readonly EvidenceRow[],
  now: Date
): Promise<number> {
  const cutoff = now.getTime() - AWAITING_RECEIPT_FINALIZE_MS;
  const stale = rows.filter(
    (row) =>
      row.receiptId === null &&
      row.outcome === OperationEvidenceOutcome.AwaitingReceipt &&
      row.invokedAt !== null &&
      row.invokedAt.getTime() < cutoff
  );
  if (stale.length === 0) {
    return 0;
  }
  const classification = classifyOperation({
    operationKind: OperationKind.Unsupported,
    outcome: OperationEvidenceOutcome.MissingResult,
    targetMatched: true,
  });
  const { count } = await tx.agentSessionOperationEvidence.updateMany({
    where: {
      organizationId: session.organizationId,
      agentSessionId: session.agentSessionId,
      id: { in: stale.map((row) => row.id) },
      outcome: OperationEvidenceOutcome.AwaitingReceipt,
      receiptId: null,
    },
    data: {
      outcome: OperationEvidenceOutcome.MissingResult,
      relationshipKind: classification.kind,
      unresolvedReason: classification.unresolvedReason ?? null,
      policyVersion: ATTRIBUTION_POLICY_VERSION,
    },
  });
  return count;
}

function isBindable(row: EvidenceRow): boolean {
  return (
    row.receiptId === null &&
    row.source === OperationSource.Mcp &&
    RECEIPTED_OPERATION_KINDS.has(storedOperationKind(row.operationKind)) &&
    !UNBINDABLE_OUTCOMES.has(row.outcome) &&
    row.unresolvedReason !== UnresolvedReason.AmbiguousToolId
  );
}

async function bindReceipts(
  tx: AgentSessionUpsertTx,
  session: { organizationId: string; agentSessionId: string },
  owner: string,
  rows: EvidenceRow[],
  changed: Set<string>
): Promise<number> {
  const { organizationId } = session;
  const bindable = rows.filter(isBindable);
  const callIds = bindable.flatMap((row) => row.providerCallId ?? []);
  const fingerprints = bindable.flatMap((row) => row.requestFingerprint ?? []);
  if (callIds.length === 0 && fingerprints.length === 0) {
    return 0;
  }
  const starts = bindable.flatMap((row) => row.invokedAt?.getTime() ?? []);
  const ends = bindable
    .map((row) => claimWindowEnd(row) + FINGERPRINT_WINDOW_MS)
    .filter((end) => Number.isFinite(end));
  const fingerprintArm =
    fingerprints.length > 0 && starts.length > 0 && ends.length > 0
      ? [
          {
            requestFingerprint: { in: fingerprints },
            // A fingerprint repeats for the same write; only receipts inside
            // some claim's window can bind.
            requestedAt: {
              gte: new Date(Math.min(...starts)),
              lte: new Date(Math.max(...ends)),
            },
          },
        ]
      : [];
  const receipts = await tx.artifactOperationReceipt.findMany({
    where: {
      organizationId,
      principalUserId: owner,
      OR: [{ clientCallId: { in: callIds } }, ...fingerprintArm],
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: RECEIPT_SELECT,
  });
  const receiptIds = receipts.map((receipt) => receipt.id);
  const [holders, heldElsewhere, rivals, own] = await Promise.all([
    tx.agentSessionOperationEvidence.findMany({
      where: {
        organizationId,
        OR: [
          { receiptId: { in: receiptIds } },
          { contestedReceiptId: { in: receiptIds } },
        ],
      },
      select: { receiptId: true, contestedReceiptId: true },
    }),
    loadHeldElsewhere(tx, session, owner, receipts),
    loadRivalClaims(tx, session, owner, { callIds, fingerprints }),
    readSessionIdentity(tx, session.agentSessionId),
  ]);
  if (!own) {
    return 0;
  }
  const held = new Set(
    holders.flatMap((row) => row.receiptId ?? row.contestedReceiptId ?? [])
  );
  let bound = 0;
  for (const row of bindable) {
    // A receipt another session holds is still this claim's to settle under
    // the copy and fork rules; a tie, or this session's own other claim,
    // keeps it.
    const free = receipts.filter(
      (receipt) =>
        (!held.has(receipt.id) ||
          isSettleable(heldElsewhere.get(receipt.id))) &&
        receiptKindMatchesClaim(receipt.operationKind, row.operationKind)
    );
    const [receipt, ...more] = candidatesFor(row, free);
    if (!receipt || more.length > 0) {
      continue;
    }
    const outcome = await settleRow(tx, {
      row,
      own: { ...own, agentSessionId: session.agentSessionId },
      receipt,
      holder: heldElsewhere.get(receipt.id),
      rivals: rivalsFor(rivals, row, receipt),
      changed,
    });
    if (outcome !== RowSettlement.Unsettled) {
      held.add(receipt.id);
      heldElsewhere.delete(receipt.id);
    }
    if (
      outcome === RowSettlement.Bound ||
      outcome === RowSettlement.BoundElsewhere
    ) {
      bound += 1;
    }
  }
  return bound;
}

const RowSettlement = {
  /** This row binds the receipt. */
  Bound: "bound",
  /** Another session's waiting claim for the same call binds it. */
  BoundElsewhere: "boundElsewhere",
  /** The receipt stays with its holder, or every claim contests it. */
  Yielded: "yielded",
  Unsettled: "unsettled",
} as const;
type RowSettlement = (typeof RowSettlement)[keyof typeof RowSettlement];

/**
 * Settles one unbound row's receipt among the row, the receipt's holder in
 * another session and the owner's other waiting claims for the same call.
 * Another member's holder is displaced first: a receipt proves only its
 * principal's session.
 */
async function settleRow(
  tx: AgentSessionUpsertTx,
  input: {
    row: EvidenceRow;
    own: SessionRuleIdentity & { agentSessionId: string };
    receipt: ReceiptRow;
    holder: ReceiptHolder | undefined;
    rivals: SettledClaimant[];
    /** Collects the sessions whose binding changed. */
    changed: Set<string>;
  }
): Promise<RowSettlement> {
  const { row, own, receipt, changed } = input;
  let holder = input.holder;
  if (holder?.otherOwner) {
    changed.add(holder.agentSessionId);
    await tx.agentSessionOperationEvidence.updateMany({
      where: { organizationId: row.organizationId, id: holder.evidenceId },
      data: releasedReceiptUpdate(
        OperationEvidenceOutcome.AwaitingReceipt,
        receipt.id,
        { heldReceipt: true }
      ),
    });
    holder = undefined;
  }
  const self: SettledClaimant = {
    evidenceId: row.id,
    agentSessionId: own.agentSessionId,
    session: own,
    invokedAt: row.invokedAt,
    sessionStartedAt: own.sessionStartedAt,
    byIdentity:
      row.providerCallId !== null &&
      row.providerCallId === receipt.clientCallId,
    heldReceipt: false,
  };
  const resolution = resolveReceiptClaimants([
    self,
    ...(holder ? [holderClaimant(holder)] : []),
    ...input.rivals,
  ]);
  if (!resolution) {
    return RowSettlement.Unsettled;
  }
  for (const sessionId of await applyClaimantResolution(
    tx,
    row.organizationId,
    receipt,
    resolution
  )) {
    changed.add(sessionId);
  }
  if (resolution.holder === self) {
    Object.assign(row, receiptBindingUpdate(receipt));
    return RowSettlement.Bound;
  }
  Object.assign(row, {
    outcome: resolution.contested.includes(self)
      ? OperationEvidenceOutcome.Ambiguous
      : OperationEvidenceOutcome.DuplicateInLineage,
  });
  return resolution.holder && !resolution.holder.heldReceipt
    ? RowSettlement.BoundElsewhere
    : RowSettlement.Yielded;
}

function candidatesFor(
  row: EvidenceRow,
  free: readonly ReceiptRow[]
): ReceiptRow[] {
  const byCallId = free.filter(
    (receipt) =>
      row.providerCallId !== null && receipt.clientCallId === row.providerCallId
  );
  if (byCallId.length > 0) {
    return byCallId;
  }
  const end = claimWindowEnd(row);
  return free.filter(
    (receipt) =>
      row.requestFingerprint !== null &&
      receipt.requestFingerprint === row.requestFingerprint &&
      row.invokedAt !== null &&
      receipt.requestedAt >= row.invokedAt &&
      !Number.isNaN(end) &&
      receipt.requestedAt.getTime() <= end + FINGERPRINT_WINDOW_MS
  );
}

/** A holder the rules can weigh: any other session's, unless it is a tie. */
function isSettleable(holder: ReceiptHolder | undefined): boolean {
  return holder !== undefined && !holder.tied;
}

type ReceiptRow = Prisma.ArtifactOperationReceiptGetPayload<{
  select: typeof RECEIPT_SELECT;
}>;

async function corroborateVersions(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  owner: string,
  rows: EvidenceRow[]
): Promise<number> {
  const open = rows.filter(
    (row) =>
      row.receiptId === null &&
      !UNBINDABLE_OUTCOMES.has(row.outcome) &&
      row.source === OperationSource.Mcp &&
      VERSIONED_KINDS.has(row.operationKind) &&
      row.targetArtifactId !== null &&
      row.observedTarget !== null &&
      row.invokedAt !== null
  );
  if (open.length === 0) {
    return 0;
  }
  const documentIds = [
    ...new Set(open.flatMap((row) => row.targetArtifactId ?? [])),
  ];
  // Only versions inside some open claim's window can corroborate one.
  const starts = open.flatMap((row) => row.invokedAt?.getTime() ?? []);
  const ends = open
    .map((row) => claimWindowEnd(row) + FINGERPRINT_WINDOW_MS)
    .filter((end) => Number.isFinite(end));
  if (starts.length === 0 || ends.length === 0) {
    return 0;
  }
  const versions = await tx.documentVersion.findMany({
    where: {
      documentId: { in: documentIds },
      createdById: owner,
      documentDetail: { artifact: { organizationId } },
      createdAt: {
        gte: new Date(Math.min(...starts)),
        lte: new Date(Math.max(...ends)),
      },
    },
    orderBy: [{ documentId: "asc" }, { version: "asc" }],
    select: { documentId: true, version: true, content: true, createdAt: true },
  });
  const previous = await previousContents(tx, organizationId, versions);
  // A version any session already proves, by a bound receipt or an earlier
  // corroboration, credits no second session in its lineage.
  const proven = await tx.agentSessionOperationEvidence.findMany({
    where: {
      organizationId,
      targetArtifactId: { in: documentIds },
      versionNumber: { not: null },
      OR: [
        { receiptId: { not: null } },
        { source: OperationSource.HistoricalRecord },
      ],
    },
    select: { targetArtifactId: true, versionNumber: true },
  });
  const used = new Set(
    proven.flatMap((row) =>
      row.targetArtifactId && row.versionNumber !== null
        ? [`${row.targetArtifactId}:${row.versionNumber}`]
        : []
    )
  );
  let corroborated = 0;
  for (const row of open) {
    const start = row.invokedAt?.getTime() ?? Number.NaN;
    const end = claimWindowEnd(row) + FINGERPRINT_WINDOW_MS;
    const candidates = versions.filter(
      (version) =>
        version.documentId === row.targetArtifactId &&
        !used.has(`${version.documentId}:${version.version}`) &&
        version.createdAt.getTime() >= start &&
        version.createdAt.getTime() <= end &&
        (row.operationKind === OperationKind.Create) === (version.version === 1)
    );
    const [version] = candidates;
    if (!version || candidates.length > 1) {
      continue;
    }
    const contentChanged =
      version.version === 1 ||
      previous.get(`${version.documentId}:${version.version - 1}`) !==
        version.content;
    const classification = classifyOperation({
      operationKind: storedOperationKind(row.operationKind),
      outcome: OperationEvidenceOutcome.Committed,
      targetMatched: true,
      contentChanged,
      changedFields: contentChanged ? ["content"] : [],
    });
    const corroboration = {
      source: OperationSource.HistoricalRecord,
      outcome: OperationEvidenceOutcome.Committed,
      relationshipKind: classification.kind,
      unresolvedReason: classification.unresolvedReason ?? null,
      effectiveAt: version.createdAt,
      versionNumber: version.version,
      changedFields: contentChanged ? ["content"] : [],
      policyVersion: ATTRIBUTION_POLICY_VERSION,
    };
    await tx.agentSessionOperationEvidence.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: corroboration,
      select: { id: true },
    });
    Object.assign(row, corroboration);
    used.add(`${version.documentId}:${version.version}`);
    corroborated += 1;
  }
  return corroborated;
}

/** The content of each version before a candidate, to tell a no-op apart. */
async function previousContents(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  versions: readonly { documentId: string; version: number }[]
): Promise<Map<string, string | null>> {
  const wanted = versions.filter((version) => version.version > 1);
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await tx.documentVersion.findMany({
    where: {
      documentDetail: { artifact: { organizationId } },
      OR: wanted.map((version) => ({
        documentId: version.documentId,
        version: version.version - 1,
      })),
    },
    select: { documentId: true, version: true, content: true },
  });
  return new Map(
    rows.map((row) => [`${row.documentId}:${row.version}`, row.content])
  );
}

async function reclassifyBound(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  rows: readonly EvidenceRow[]
): Promise<number> {
  const stale = rows.filter(
    (row) =>
      row.receiptId !== null && row.policyVersion < ATTRIBUTION_POLICY_VERSION
  );
  if (stale.length === 0) {
    return 0;
  }
  const receipts = await tx.artifactOperationReceipt.findMany({
    where: {
      organizationId,
      id: { in: stale.flatMap((row) => row.receiptId ?? []) },
    },
    select: RECEIPT_SELECT,
  });
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  let reclassified = 0;
  for (const row of stale) {
    const receipt = row.receiptId ? byId.get(row.receiptId) : undefined;
    if (!receipt) {
      continue;
    }
    await tx.agentSessionOperationEvidence.update({
      where: { id: row.id, organizationId: row.organizationId },
      data: receiptBindingUpdate(receipt),
      select: { id: true },
    });
    reclassified += 1;
  }
  return reclassified;
}
