import {
  type BranchActivityAtom,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  type BranchActivityEvidenceProjection,
  BranchActivityEvidenceReason,
  BranchActivitySource,
  branchActivityAtomProducerValidator,
  normalizeBranchActivityAtom,
} from "@repo/api/src/types/branch-activity";
import { type TransactionClient, withDb } from "@repo/database";

/** Stable outcomes returned by the Branch activity persistence boundary. */
export const BranchActivityPersistStatus = {
  Inserted: "inserted",
  Replayed: "replayed",
  Conflict: "conflict",
  Invalid: "invalid",
  NotFound: "not_found",
  InvalidAttribution: "invalid_attribution",
} as const;
export type BranchActivityPersistStatus =
  (typeof BranchActivityPersistStatus)[keyof typeof BranchActivityPersistStatus];

export type BranchActivityPersistResult = {
  status: BranchActivityPersistStatus;
};

export type PersistedBranchActivityAtom = {
  version: number;
  source: string;
  sourceEventId: string;
  occurredAt: Date;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
};

type BranchActivityPersistenceClient = Pick<
  TransactionClient,
  "branchActivityAtom" | "branchDetail" | "pullRequestDetail"
>;

/**
 * Persist one immutable activity atom and advance the legacy aggregate in one
 * Branch-owned transaction. When invoked inside an ambient `withDb.tx`, the
 * database wrapper joins that transaction instead of opening a second one.
 */
export function persistBranchActivityAtom(input: {
  organizationId: string;
  branchArtifactId: string;
  atom: unknown;
}): Promise<BranchActivityPersistResult> {
  return withDb.tx((tx) => persistBranchActivityAtomInTransaction(tx, input));
}

/**
 * Transaction implementation used by the public writer and focused tests.
 *
 * The boundary validates unknown input itself, enforces organization and
 * associated-PR ownership, and distinguishes exact replay from conflicting
 * reuse of a stable source identity. Unexpected database failures are allowed
 * to reject so the caller transaction rolls back instead of reporting success.
 */
export async function persistBranchActivityAtomInTransaction(
  tx: BranchActivityPersistenceClient,
  input: {
    organizationId: string;
    branchArtifactId: string;
    atom: unknown;
  }
): Promise<BranchActivityPersistResult> {
  const parsed = branchActivityAtomProducerValidator.safeParse(input.atom);
  if (!parsed.success) {
    return { status: BranchActivityPersistStatus.Invalid };
  }
  const branch = await tx.branchDetail.findUnique({
    where: {
      organizationId_artifactId: {
        artifactId: input.branchArtifactId,
        organizationId: input.organizationId,
      },
    },
    select: { artifactId: true },
  });
  if (!branch) {
    return { status: BranchActivityPersistStatus.NotFound };
  }

  const atom = parsed.data;
  const pullRequestDetailId = pullRequestId(atom);
  if (!(await hasValidAttribution(tx, input, atom, pullRequestDetailId))) {
    return { status: BranchActivityPersistStatus.InvalidAttribution };
  }

  const occurredAt = new Date(atom.occurredAt);
  const persisted = {
    version: atom.version,
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    source: atom.source,
    sourceEventId: atom.sourceEventId,
    occurredAt,
    attributionKind: atom.attribution.kind,
    pullRequestDetailId,
    completeness: atom.completeness,
  };
  const inserted = await tx.branchActivityAtom.createMany({
    data: [persisted],
    skipDuplicates: true,
  });
  let status: BranchActivityPersistStatus =
    BranchActivityPersistStatus.Inserted;
  let accepted: PersistedBranchActivityAtom = persisted;
  if (inserted.count === 0) {
    const stored = await tx.branchActivityAtom.findUnique({
      where: {
        organizationId_branchArtifactId_source_sourceEventId: {
          organizationId: input.organizationId,
          branchArtifactId: input.branchArtifactId,
          source: atom.source,
          sourceEventId: atom.sourceEventId,
        },
      },
      select: {
        version: true,
        source: true,
        sourceEventId: true,
        occurredAt: true,
        attributionKind: true,
        pullRequestDetailId: true,
        completeness: true,
      },
    });
    if (!(stored && persistedAtomsReplayCompatible(stored, persisted))) {
      return { status: BranchActivityPersistStatus.Conflict };
    }
    status = BranchActivityPersistStatus.Replayed;
    accepted = stored;
  }

  await tx.branchDetail.updateMany({
    where: {
      artifactId: input.branchArtifactId,
      organizationId: input.organizationId,
      OR: [
        { lastActivityAt: null },
        { lastActivityAt: { lt: accepted.occurredAt } },
      ],
    },
    data: { lastActivityAt: accepted.occurredAt },
  });
  return { status };
}

/** Project one bounded persisted row without synthesizing legacy provenance. */
export function projectCanonicalBranchActivityEvidence(
  persisted: PersistedBranchActivityAtom | null | undefined
): BranchActivityEvidenceProjection {
  if (!persisted) {
    return {
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.NoEvidence,
    };
  }
  const atom = normalizeBranchActivityAtom({
    version: persisted.version,
    source: persisted.source,
    sourceEventId: persisted.sourceEventId,
    occurredAt: persisted.occurredAt.toISOString(),
    attribution:
      persisted.attributionKind === BranchActivityAttributionKind.PullRequest &&
      persisted.pullRequestDetailId
        ? {
            kind: BranchActivityAttributionKind.PullRequest,
            pullRequestId: persisted.pullRequestDetailId,
          }
        : { kind: persisted.attributionKind },
    completeness: persisted.completeness,
  });
  if (!atom) {
    return {
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.MalformedEvidence,
    };
  }
  return {
    completeness: BranchActivityEvidenceCompleteness.Partial,
    latestAtom: atom,
    reason:
      atom.source === BranchActivitySource.Unknown
        ? BranchActivityEvidenceReason.UnknownSource
        : BranchActivityEvidenceReason.HistoricalCoverage,
  };
}

async function hasValidAttribution(
  tx: Pick<TransactionClient, "pullRequestDetail">,
  input: { organizationId: string; branchArtifactId: string },
  atom: BranchActivityAtom,
  pullRequestDetailId: string | null
): Promise<boolean> {
  if (atom.attribution.kind === BranchActivityAttributionKind.Branch) {
    return pullRequestDetailId === null;
  }
  if (!pullRequestDetailId) {
    return false;
  }
  const pullRequest = await tx.pullRequestDetail.findUnique({
    where: { id: pullRequestDetailId },
    select: { branchArtifactId: true, id: true, organizationId: true },
  });
  return (
    pullRequest?.id === pullRequestDetailId &&
    pullRequest.organizationId === input.organizationId &&
    pullRequest.branchArtifactId === input.branchArtifactId
  );
}

function pullRequestId(atom: BranchActivityAtom): string | null {
  return atom.attribution.kind === BranchActivityAttributionKind.PullRequest
    ? atom.attribution.pullRequestId
    : null;
}

/**
 * Treat monitored-Session completeness as conservative coverage metadata.
 * Replays retain the first immutable row when later payload-level capping is
 * the only difference instead of turning safe downgrade replay into conflict.
 */
export function persistedAtomsReplayCompatible(
  left: PersistedBranchActivityAtom,
  right: PersistedBranchActivityAtom
): boolean {
  return (
    left.version === right.version &&
    left.source === right.source &&
    left.sourceEventId === right.sourceEventId &&
    left.occurredAt.getTime() === right.occurredAt.getTime() &&
    left.attributionKind === right.attributionKind &&
    left.pullRequestDetailId === right.pullRequestDetailId &&
    (left.completeness === right.completeness ||
      (left.source === BranchActivitySource.MonitoredSession &&
        right.source === BranchActivitySource.MonitoredSession))
  );
}
