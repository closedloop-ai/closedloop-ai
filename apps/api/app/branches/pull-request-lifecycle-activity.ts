import {
  type BranchActivityAtom,
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
  branchActivityAtomProducerValidator,
} from "@repo/api/src/types/branch-activity";
import type { TransactionClient } from "@repo/database";
import {
  type BranchActivityPersistResult,
  type BranchActivityPersistStatus,
  type PersistedBranchActivityAtom,
  BranchActivityPersistStatus as PersistStatus,
  persistedAtomIdentity,
  persistedAtomsReplayCompatible,
} from "./branch-activity-evidence";
import {
  type BranchActivityAtomBatchRecord,
  BranchActivityBatchConflictError,
  persistBranchActivityAtomsInTransaction,
} from "./branch-activity-evidence-batch";

/**
 * The three real-world PR transitions the immutable ledger records, and the
 * only vocabulary an occurrence-derived atom identity is built from.
 */
export const PullRequestLifecycleOccurrence = {
  Opened: "opened",
  Merged: "merged",
  Closed: "closed",
} as const;
export type PullRequestLifecycleOccurrence =
  (typeof PullRequestLifecycleOccurrence)[keyof typeof PullRequestLifecycleOccurrence];

export type PersistPullRequestLifecycleActivityInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  openedAt: Date | null;
  mergedAt: Date | null;
  closedAt: Date | null;
};

/** Persisted identity and evidence fields used to reconcile lifecycle replay. */
export type PersistedPullRequestLifecycleActivityAtom =
  PersistedBranchActivityAtom & {
    branchArtifactId: string;
  };

/** Rejecting canonical atom outcomes that must abort an enclosing PR writer. */
export class PullRequestLifecycleActivityPersistenceError extends Error {
  readonly statuses: readonly BranchActivityPersistStatus[];

  constructor(statuses: readonly BranchActivityPersistStatus[]) {
    super(`Pull request lifecycle activity rejected: ${statuses.join(", ")}`);
    this.name = "PullRequestLifecycleActivityPersistenceError";
    this.statuses = statuses;
  }
}

/**
 * Persist authoritative PR lifecycle observations with the caller's transaction.
 * Opened is independent; merged takes precedence over closed for terminal state.
 */
export async function persistPullRequestLifecycleActivityInTransaction(
  tx: TransactionClient,
  input: PersistPullRequestLifecycleActivityInput
): Promise<void> {
  await persistPullRequestLifecycleActivityRecordsInTransaction(tx, {
    organizationId: input.organizationId,
    records: buildPullRequestLifecycleActivityRecords(input),
  });
}

/** Build stable canonical atom records from authoritative PR timestamps. */
export function buildPullRequestLifecycleActivityRecords(
  input: PersistPullRequestLifecycleActivityInput
): BranchActivityAtomBatchRecord[] {
  const records: BranchActivityAtomBatchRecord[] = [];
  if (input.openedAt) {
    records.push(
      lifecycleRecord(
        input,
        PullRequestLifecycleOccurrence.Opened,
        input.openedAt
      )
    );
  }
  if (input.mergedAt) {
    records.push(
      lifecycleRecord(
        input,
        PullRequestLifecycleOccurrence.Merged,
        input.mergedAt
      )
    );
  } else if (input.closedAt) {
    records.push(
      lifecycleRecord(
        input,
        PullRequestLifecycleOccurrence.Closed,
        input.closedAt
      )
    );
  }
  return records;
}

/**
 * Build the one canonical atom every lane must emit for a PR lifecycle
 * occurrence.
 *
 * The identity is derived from the occurrence itself — never from the
 * transport that observed it — so the GitHub webhook lane and the non-webhook
 * lanes (App backfill, tombstoned-repository settlement) converge on a single
 * immutable row per real-world event instead of one row per identity space.
 * Closes carry the occurrence time because a PR can be closed, reopened, and
 * closed again; opens and merges happen at most once.
 *
 * Forward-only: rows the webhook lane already wrote under a delivery identity
 * stay where they are. Nothing in an atom records which occurrence a delivery
 * reported, so healing them would mean re-deriving that from the PR's current
 * timestamps — a separate migration over the immutable ledger, not part of
 * closing the identity split.
 */
export function pullRequestLifecycleActivityAtom(input: {
  pullRequestDetailId: string;
  occurrence: PullRequestLifecycleOccurrence;
  occurredAt: Date;
}): BranchActivityAtom {
  const occurredAtIso = input.occurredAt.toISOString();
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.PullRequestLifecycle,
    sourceEventId:
      input.occurrence === PullRequestLifecycleOccurrence.Closed
        ? `${input.pullRequestDetailId}:${input.occurrence}:${occurredAtIso}`
        : `${input.pullRequestDetailId}:${input.occurrence}`,
    occurredAt: occurredAtIso,
    attribution: {
      kind: BranchActivityAttributionKind.PullRequest,
      pullRequestId: input.pullRequestDetailId,
    },
    completeness: BranchActivityEvidenceCompleteness.Complete,
  } satisfies BranchActivityAtom;
}

/** Persist a bounded set of PR lifecycle records and reject unsafe outcomes. */
export async function persistPullRequestLifecycleActivityRecordsInTransaction(
  tx: TransactionClient,
  input: {
    organizationId: string;
    records: readonly BranchActivityAtomBatchRecord[];
  }
): Promise<void> {
  const records = resolvePullRequestLifecycleActivityRecordIdentities(
    input.records,
    await loadLegacyClosedAtoms(tx, input.organizationId, input.records)
  );
  let results: BranchActivityPersistResult[];
  try {
    results = await persistBranchActivityAtomsInTransaction(tx, {
      organizationId: input.organizationId,
      records,
    });
  } catch (error) {
    if (error instanceof BranchActivityBatchConflictError) {
      throw new PullRequestLifecycleActivityPersistenceError([
        PersistStatus.Conflict,
      ]);
    }
    throw error;
  }
  const rejectingStatuses = results.flatMap(({ status }) =>
    isCommitSafe(status) ? [] : [status]
  );
  if (rejectingStatuses.length > 0) {
    throw new PullRequestLifecycleActivityPersistenceError(rejectingStatuses);
  }
}

/**
 * Reuse a matching legacy `:closed` atom while assigning new closes an
 * occurrence-specific identity, so old evidence replays without collapsing a
 * later close after reopen.
 */
export function resolvePullRequestLifecycleActivityRecordIdentities(
  records: readonly BranchActivityAtomBatchRecord[],
  persistedAtoms: readonly PersistedPullRequestLifecycleActivityAtom[]
): BranchActivityAtomBatchRecord[] {
  const persistedByIdentity = new Map(
    persistedAtoms.map((atom) => [persistedAtomIdentity(atom), atom])
  );
  return records.map((record) => {
    const parsed = branchActivityAtomProducerValidator.safeParse(record.atom);
    if (!parsed.success) {
      return record;
    }
    const legacySourceEventId = legacyClosedSourceEventId(parsed.data);
    if (!legacySourceEventId) {
      return record;
    }
    const stored = persistedByIdentity.get(
      persistedAtomIdentity({
        branchArtifactId: record.branchArtifactId,
        source: parsed.data.source,
        sourceEventId: legacySourceEventId,
      })
    );
    const legacyCandidate = persistedLifecycleAtom(
      record.branchArtifactId,
      parsed.data,
      legacySourceEventId
    );
    if (!(stored && persistedAtomsReplayCompatible(stored, legacyCandidate))) {
      return record;
    }
    return {
      branchArtifactId: record.branchArtifactId,
      atom: { ...parsed.data, sourceEventId: legacySourceEventId },
    };
  });
}

function lifecycleRecord(
  input: PersistPullRequestLifecycleActivityInput,
  occurrence: PullRequestLifecycleOccurrence,
  occurredAt: Date
): BranchActivityAtomBatchRecord {
  return {
    branchArtifactId: input.branchArtifactId,
    atom: pullRequestLifecycleActivityAtom({
      pullRequestDetailId: input.pullRequestDetailId,
      occurrence,
      occurredAt,
    }),
  };
}

function loadLegacyClosedAtoms(
  tx: TransactionClient,
  organizationId: string,
  records: readonly BranchActivityAtomBatchRecord[]
): Promise<PersistedPullRequestLifecycleActivityAtom[]> {
  const candidates = records.flatMap((record) => {
    const parsed = branchActivityAtomProducerValidator.safeParse(record.atom);
    if (parsed.success) {
      const sourceEventId = legacyClosedSourceEventId(parsed.data);
      return sourceEventId
        ? [
            {
              branchArtifactId: record.branchArtifactId,
              source: parsed.data.source,
              sourceEventId,
            },
          ]
        : [];
    }
    return [];
  });
  if (candidates.length === 0) {
    return Promise.resolve([]);
  }
  return tx.branchActivityAtom.findMany({
    where: { organizationId, OR: candidates },
    select: {
      version: true,
      source: true,
      sourceEventId: true,
      occurredAt: true,
      attributionKind: true,
      pullRequestDetailId: true,
      completeness: true,
      branchArtifactId: true,
    },
  });
}

function legacyClosedSourceEventId(atom: BranchActivityAtom): string | null {
  if (
    atom.source !== BranchActivitySource.PullRequestLifecycle ||
    atom.attribution.kind !== BranchActivityAttributionKind.PullRequest
  ) {
    return null;
  }
  const legacySourceEventId = `${atom.attribution.pullRequestId}:${PullRequestLifecycleOccurrence.Closed}`;
  return atom.sourceEventId.startsWith(`${legacySourceEventId}:`)
    ? legacySourceEventId
    : null;
}

function persistedLifecycleAtom(
  branchArtifactId: string,
  atom: BranchActivityAtom,
  sourceEventId: string
): PersistedPullRequestLifecycleActivityAtom {
  return {
    version: atom.version,
    branchArtifactId,
    source: atom.source,
    sourceEventId,
    occurredAt: new Date(atom.occurredAt),
    attributionKind: atom.attribution.kind,
    pullRequestDetailId:
      atom.attribution.kind === BranchActivityAttributionKind.PullRequest
        ? atom.attribution.pullRequestId
        : null,
    completeness: atom.completeness,
  };
}

function isCommitSafe(status: BranchActivityPersistStatus): boolean {
  return status === PersistStatus.Inserted || status === PersistStatus.Replayed;
}
