/**
 * ISS-12552: persist a synced session's operation evidence.
 * Runs inside the sync ingest transaction. A slice older than what the session
 * stored never replaces its evidence. A snapshot with the digest already
 * stored is a no-op unless it can now say more: this parse dropped fewer
 * claims than the stored one did, a row still awaits a receipt that may have
 * committed since, or the session's evidence links were never synced for it.
 * Any other replaces the session's evidence rows, and a row the backfill
 * corroborated keeps that proof while it stays unbound. The caller syncs the
 * evidence links of this session, and of every other session whose receipt
 * binding this sync changed (a displaced holder, a canonical copy or a fork
 * parent that took the receipt), after its transaction commits
 * (`settleCommittedSessionEvidence`).
 *
 * Implementation-join claims (Daveth Oakhurst, 2026-10-20: one per branch,
 * the requests the Desktop's write-to-commit join placed on it) are kept on
 * the snapshot and never become evidence rows: implementation rows come from
 * `deriveImplementationEvidence`, which reads them.
 */
import {
  OperationEvidenceOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  IMPLEMENTATION_JOIN_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  type SessionOperationEvidence,
} from "@repo/api/src/types/operation-claims";
import { Prisma } from "@repo/database";
import { claimRequestAnchors } from "@repo/lib/attribution/allocation-inputs";
import { ATTRIBUTION_POLICY_VERSION } from "@repo/lib/attribution/classify-operation";
import { classifyReconciledClaim } from "@repo/lib/attribution/classify-reconciled-claim";
import { isImplementationJoinClaim } from "@repo/lib/attribution/implementation-requests";
import { FINGERPRINT_WINDOW_MS } from "@repo/lib/attribution/receipt-outcome";
import {
  claimedReceiptIds,
  type ReceiptCandidate,
  type ReconciledClaim,
  reconcileOperationClaims,
} from "@repo/lib/attribution/reconcile-operation-claims";
import { releasedReceiptUpdate } from "@/lib/operation-receipts/receipt-binding-update";
import type { AgentSessionUpsertTx } from "../records";
import {
  loadHeldElsewhere,
  readSessionIdentity,
  settleSyncedClaimsWithRivals,
} from "./receipt-holders";
import {
  resolveClaimTargets,
  type TargetResolver,
} from "./resolve-claim-targets";

type PersistInput = {
  organizationId: string;
  agentSessionId: string;
  /** As parsed at ingress, which counts the claims it dropped. */
  evidence:
    | (SessionOperationEvidence & { unparsedClaims?: number })
    | undefined;
  /** The slice passed the session's freshness gate (FEA-3477). */
  fresh: boolean;
};

export type PersistedOperationEvidence = {
  /** It wrote the session's snapshot, so the caller re-derives. */
  snapshotWritten: boolean;
  /** Other sessions whose receipt binding this sync changed. */
  bindingChangedSessionIds: string[];
};

const NOTHING_PERSISTED: PersistedOperationEvidence = {
  snapshotWritten: false,
  bindingChangedSessionIds: [],
};

export async function persistSessionOperationEvidence(
  tx: AgentSessionUpsertTx,
  input: PersistInput
): Promise<PersistedOperationEvidence> {
  const { evidence, organizationId, agentSessionId } = input;
  if (!(evidence && input.fresh)) {
    return NOTHING_PERSISTED;
  }
  if (await isStoredSnapshotCurrent(tx, input, evidence)) {
    return NOTHING_PERSISTED;
  }
  const claims = evidence.claims.filter(
    (claim) => !isImplementationJoinClaim(claim)
  );
  const owner = await tx.artifact.findFirst({
    where: { id: agentSessionId, organizationId },
    select: { createdById: true },
  });
  const receipts = owner?.createdById
    ? await loadReceiptCandidates(tx, {
        organizationId,
        principalUserId: owner.createdById,
        claims,
      })
    : [];
  const heldElsewhere = await loadHeldElsewhere(
    tx,
    { organizationId, agentSessionId },
    owner?.createdById ?? null,
    receipts
  );
  const identity =
    heldElsewhere.size > 0
      ? await readSessionIdentity(tx, agentSessionId)
      : null;
  const reconciled = reconcileOperationClaims({
    claims,
    receipts,
    heldElsewhere,
    sessionStartedAt: identity?.sessionStartedAt ?? null,
  });
  const targets = await resolveClaimTargets(tx, organizationId, claims);
  const displaced = await releaseDisplacedReceipts(
    tx,
    organizationId,
    reconciled
  );
  const { settled, touchedSessionIds } = await settleSyncedClaimsWithRivals(
    tx,
    { organizationId, agentSessionId },
    owner?.createdById ?? null,
    reconciled
  );
  const corroborated = await loadCorroborations(tx, input);
  // Implementation rows come from repository evidence, not this snapshot.
  await tx.agentSessionOperationEvidence.deleteMany({
    where: {
      organizationId,
      agentSessionId,
      source: { not: OperationSource.Repository },
    },
  });
  const rows = settled.map((entry) =>
    withCorroboration(
      toEvidenceRow(entry, {
        organizationId,
        agentSessionId,
        extractorVersion: evidence.extractorVersion,
        targets,
      }),
      corroborated.get(entry.rowKey)
    )
  );
  await tx.agentSessionOperationEvidence.createMany({ data: rows });
  const snapshot = {
    organizationId,
    digest: evidence.digest,
    extractorVersion: evidence.extractorVersion,
    coverage: evidence.coverage,
    unparsedClaims: evidence.unparsedClaims ?? 0,
    repositoryActivity: repositoryActivity(evidence),
    // The rows just changed; the links are synced for them after commit.
    linksSyncedDigest: null,
  };
  await tx.agentSessionOperationEvidenceSnapshot.upsert({
    where: { agentSessionId, organizationId },
    create: { agentSessionId, ...snapshot },
    update: snapshot,
    select: { agentSessionId: true },
  });
  return {
    snapshotWritten: true,
    bindingChangedSessionIds: [
      ...new Set([...displaced, ...touchedSessionIds]),
    ].filter((id) => id !== agentSessionId),
  };
}

/**
 * The snapshot's implementation joins: the claims, possibly none, from an
 * extractor that sends them; database NULL from an older one, so the
 * derivation can tell "joined nothing" from "could not see".
 */
function repositoryActivity(
  evidence: SessionOperationEvidence
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return evidence.extractorVersion >= IMPLEMENTATION_JOIN_EXTRACTOR_VERSION
    ? evidence.claims.filter(isImplementationJoinClaim)
    : Prisma.DbNull;
}

/**
 * Receipts the session's owner made in its organization that any claim could
 * bind: by call id, by named operation id, or by fingerprint. An empty owner
 * binds nothing, so a session with no `createdById` gets no candidates.
 */
async function loadReceiptCandidates(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    principalUserId: string;
    claims: readonly OperationClaim[];
  }
): Promise<ReceiptCandidate[]> {
  const callIds = uniqueValues(input.claims, (claim) => claim.providerCallId);
  const fingerprints = uniqueValues(
    input.claims,
    (claim) => claim.requestFingerprint
  );
  const receiptIds = [...new Set(input.claims.flatMap(claimedReceiptIds))];
  const fingerprintSpan = fingerprintWindowSpan(input.claims);
  const or: Prisma.ArtifactOperationReceiptWhereInput[] = [
    ...(callIds.length > 0 ? [{ clientCallId: { in: callIds } }] : []),
    ...(receiptIds.length > 0 ? [{ id: { in: receiptIds } }] : []),
    ...(fingerprints.length > 0 && fingerprintSpan
      ? [
          {
            requestFingerprint: { in: fingerprints },
            requestedAt: { gte: fingerprintSpan.from, lte: fingerprintSpan.to },
          },
        ]
      : []),
  ];
  if (or.length === 0) {
    return [];
  }
  return await tx.artifactOperationReceipt.findMany({
    where: {
      organizationId: input.organizationId,
      principalUserId: input.principalUserId,
      OR: or,
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      operationKind: true,
      outcome: true,
      clientCallId: true,
      requestFingerprint: true,
      requestedAt: true,
      committedAt: true,
      targetArtifactId: true,
      createdArtifactId: true,
      versionNumber: true,
      changedFields: true,
      contentDigestBefore: true,
      contentDigestAfter: true,
    },
  });
}

/**
 * A later claim in the owner's lineage gives its receipt up to the earliest; a
 * tied claim gives it up and keeps contesting it. Returns the sessions whose
 * rows gave a receipt up, with their links marked stale until the caller's
 * post-commit link sync.
 */
async function releaseDisplacedReceipts(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  reconciled: readonly ReconciledClaim[]
): Promise<string[]> {
  const groups = new Map<
    string,
    { outcome: OperationEvidenceOutcome; receiptId: string; ids: string[] }
  >();
  for (const { displaced } of reconciled) {
    if (displaced) {
      const key =
        displaced.outcome === OperationEvidenceOutcome.Ambiguous
          ? `${displaced.outcome}:${displaced.receiptId}`
          : displaced.outcome;
      const group = groups.get(key) ?? {
        outcome: displaced.outcome,
        receiptId: displaced.receiptId,
        ids: [],
      };
      group.ids.push(displaced.evidenceId);
      groups.set(key, group);
    }
  }
  for (const { outcome, receiptId, ids } of groups.values()) {
    await tx.agentSessionOperationEvidence.updateMany({
      where: { organizationId, id: { in: ids } },
      data: releasedReceiptUpdate(outcome, receiptId, { heldReceipt: true }),
    });
  }
  const sessions = [
    ...new Set(
      reconciled.flatMap(({ displaced }) => displaced?.agentSessionId ?? [])
    ),
  ];
  if (sessions.length > 0) {
    await tx.agentSessionOperationEvidenceSnapshot.updateMany({
      where: { organizationId, agentSessionId: { in: sessions } },
      data: { linksSyncedDigest: null },
    });
  }
  return sessions;
}

type RowContext = {
  organizationId: string;
  agentSessionId: string;
  extractorVersion: number;
  targets: TargetResolver;
};

function toEvidenceRow(
  entry: ReconciledClaim,
  context: RowContext
): Prisma.AgentSessionOperationEvidenceCreateManyInput {
  const { claim, receipt } = entry;
  const observed = context.targets.observed(claim);
  const { operationKind, targetArtifactId, ...classification } =
    classifyReconciledClaim(entry, observed.artifactId);
  return {
    organizationId: context.organizationId,
    agentSessionId: context.agentSessionId,
    claimKey: entry.rowKey,
    receiptId: receipt?.id ?? null,
    contestedReceiptId: entry.contestedReceiptId ?? null,
    targetArtifactId,
    observedTarget: observed.text,
    relationshipKind: classification.kind,
    outcome: entry.outcome,
    operationKind,
    source: evidenceSource(claim),
    unresolvedReason: classification.unresolvedReason ?? null,
    agentId: claim.agentId ?? null,
    invokedAt: toDate(claim.invokedAt),
    effectiveAt: receipt?.committedAt ?? null,
    changedFields: receipt?.changedFields ?? [],
    versionNumber: receipt?.versionNumber ?? null,
    providerCallId: claim.providerCallId ?? null,
    requestFingerprint: claim.requestFingerprint ?? null,
    anchors: {
      ...(claim.toolName ? { toolName: claim.toolName } : {}),
      ...(claim.providerCallId
        ? { providerToolUseId: claim.providerCallId }
        : {}),
      ...(claim.resultAt ? { resultAt: claim.resultAt } : {}),
      ...claimRequestAnchors(claim),
    },
    extractorVersion: context.extractorVersion,
    policyVersion: ATTRIBUTION_POLICY_VERSION,
  };
}

function evidenceSource(claim: OperationClaim): OperationSource {
  switch (claim.source) {
    case OperationClaimSource.Shell:
      return OperationSource.Shell;
    case OperationClaimSource.ClosedloopMcp:
      return OperationSource.Mcp;
    default:
      return OperationSource.TranscriptOnly;
  }
}

function uniqueValues(
  claims: readonly OperationClaim[],
  read: (claim: OperationClaim) => string | undefined
): string[] {
  return [...new Set(claims.flatMap((claim) => read(claim) ?? []))];
}

function toDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The stored snapshot already says everything this one can: same digest, no
 * claim this parse reads that the stored parse dropped, no row waiting on a
 * receipt, and links synced for that digest.
 */
async function isStoredSnapshotCurrent(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; agentSessionId: string },
  evidence: SessionOperationEvidence & { unparsedClaims?: number }
): Promise<boolean> {
  const stored = await tx.agentSessionOperationEvidenceSnapshot.findUnique({
    where: {
      agentSessionId: input.agentSessionId,
      organizationId: input.organizationId,
    },
    select: { digest: true, unparsedClaims: true, linksSyncedDigest: true },
  });
  if (
    stored?.digest !== evidence.digest ||
    stored.linksSyncedDigest !== stored.digest ||
    (evidence.unparsedClaims ?? 0) < stored.unparsedClaims
  ) {
    return false;
  }
  const awaiting = await tx.agentSessionOperationEvidence.findFirst({
    where: {
      organizationId: input.organizationId,
      agentSessionId: input.agentSessionId,
      outcome: OperationEvidenceOutcome.AwaitingReceipt,
    },
    select: { id: true },
  });
  return awaiting === null;
}

const CORROBORATION_SELECT = {
  claimKey: true,
  source: true,
  targetArtifactId: true,
  outcome: true,
  relationshipKind: true,
  unresolvedReason: true,
  effectiveAt: true,
  versionNumber: true,
  changedFields: true,
  policyVersion: true,
} as const;

type Corroboration = Prisma.AgentSessionOperationEvidenceGetPayload<{
  select: typeof CORROBORATION_SELECT;
}>;

/**
 * Rows the backfill settled, by claim key: proved from document history, or
 * finalized after a day without a receipt.
 */
async function loadCorroborations(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; agentSessionId: string }
): Promise<Map<string, Corroboration>> {
  const rows = await tx.agentSessionOperationEvidence.findMany({
    where: {
      organizationId: input.organizationId,
      agentSessionId: input.agentSessionId,
      OR: [
        { source: OperationSource.HistoricalRecord },
        { outcome: OperationEvidenceOutcome.MissingResult, receiptId: null },
      ],
    },
    select: CORROBORATION_SELECT,
  });
  return new Map(rows.map((row) => [row.claimKey, row]));
}

/**
 * A replaced row keeps the backfill's proof (AC-009: a later read never
 * downgrades durable evidence) while it is still the same unbound claim on the
 * same target. A receipt bound in this snapshot outranks it.
 */
function withCorroboration(
  row: Prisma.AgentSessionOperationEvidenceCreateManyInput,
  prior: Corroboration | undefined
): Prisma.AgentSessionOperationEvidenceCreateManyInput {
  if (
    prior?.source !== OperationSource.HistoricalRecord &&
    prior?.outcome === OperationEvidenceOutcome.MissingResult
  ) {
    // A write finalized without a receipt stays finalized while sync still
    // finds no receipt for it; otherwise every sync would replace it again.
    return row.receiptId === null &&
      row.outcome === OperationEvidenceOutcome.AwaitingReceipt
      ? {
          ...row,
          outcome: prior.outcome,
          relationshipKind: prior.relationshipKind,
          unresolvedReason: prior.unresolvedReason,
          policyVersion: prior.policyVersion,
        }
      : row;
  }
  if (
    !prior ||
    row.receiptId !== null ||
    row.outcome === OperationEvidenceOutcome.DuplicateInLineage ||
    row.outcome === OperationEvidenceOutcome.Ambiguous ||
    row.targetArtifactId !== prior.targetArtifactId
  ) {
    return row;
  }
  return {
    ...row,
    source: OperationSource.HistoricalRecord,
    outcome: prior.outcome,
    relationshipKind: prior.relationshipKind,
    unresolvedReason: prior.unresolvedReason,
    effectiveAt: prior.effectiveAt,
    versionNumber: prior.versionNumber,
    changedFields: prior.changedFields,
    policyVersion: prior.policyVersion,
  };
}

/**
 * The span every claim's fingerprint window falls in. A fingerprint repeats
 * for the same write with the same arguments, so the read is bounded to the
 * times a match could bind (reconcile-operation-claims.ts `byFingerprint`).
 */
function fingerprintWindowSpan(
  claims: readonly OperationClaim[]
): { from: Date; to: Date } | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const claim of claims) {
    const start = Date.parse(claim.invokedAt ?? "");
    const end = Date.parse(claim.resultAt ?? claim.invokedAt ?? "");
    if (
      claim.requestFingerprint &&
      Number.isFinite(start) &&
      Number.isFinite(end)
    ) {
      from = Math.min(from, start);
      to = Math.max(to, end + FINGERPRINT_WINDOW_MS);
    }
  }
  return Number.isFinite(from)
    ? { from: new Date(from), to: new Date(to) }
    : null;
}
