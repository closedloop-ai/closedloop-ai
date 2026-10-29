import {
  type BranchActivityAtom,
  BranchActivityAttributionKind,
  branchActivityAtomProducerValidator,
} from "@repo/api/src/types/branch-activity";
import type { TransactionClient } from "@repo/database";
import { bindParameterChunkSize } from "@/app/agent-sessions/service/write-chunking";
import { chunksOf } from "@/lib/chunks-of";
import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";
import { recomputeBranchActivityAggregatesInTransaction } from "./branch-activity-aggregate";
import {
  BRANCH_ACTIVITY_ATOM_COLUMN_COUNT,
  type BranchActivityPersistResult,
  BranchActivityPersistStatus,
  type PersistedBranchActivityAtom,
  persistedAtomIdentity,
  persistedAtomsReplayCompatible,
} from "./branch-activity-evidence";
import { lockPullRequestBranchAttributionsInTransaction } from "./pull-request-branch-relink";

export type BranchActivityAtomBatchRecord = {
  branchArtifactId: string;
  atom: unknown;
};

type ParsedBatchRecord = {
  branchArtifactId: string;
  atom: BranchActivityAtom;
  persisted: PersistedBranchActivityAtom & {
    organizationId: string;
    branchArtifactId: string;
  };
};

type PersistedBatchAtom = PersistedBranchActivityAtom & {
  branchArtifactId: string;
};

type BranchActivityBatchClient = Pick<
  TransactionClient,
  "$executeRaw" | "$queryRaw" | "branchActivityAtom" | "branchDetail"
>;

/** A concurrent writer claimed an atom identity with incompatible evidence. */
export class BranchActivityBatchConflictError extends Error {
  constructor() {
    super("Branch activity batch conflicted during persistence");
    this.name = "BranchActivityBatchConflictError";
  }
}

/**
 * Validate and persist one Session's activity atoms with set-based ownership
 * reads, insertion, replay verification, and aggregate advancement. The record
 * count is whatever the payload carried (ISS-9860); the per-record reads and the
 * insert are chunked by bind budget so width costs statements, not a refusal.
 */
export async function persistBranchActivityAtomsInTransaction(
  tx: BranchActivityBatchClient,
  input: {
    organizationId: string;
    records: readonly BranchActivityAtomBatchRecord[];
    receivedAt?: Date;
  }
): Promise<BranchActivityPersistResult[]> {
  if (input.records.length === 0) {
    return [];
  }
  const receivedAt = input.receivedAt ?? new Date();
  const parsed = parseRecords(input.organizationId, input.records, receivedAt);
  if (!parsed) {
    return rejectedBatch(
      input.records.length,
      BranchActivityPersistStatus.Invalid
    );
  }

  const trustedIndexes = parsed.flatMap((record, index) =>
    isWithinTrustedFutureBoundary(record.persisted.occurredAt, receivedAt)
      ? [index]
      : []
  );
  const trusted = trustedIndexes.map((index) => parsed[index]);
  if (trusted.length === 0) {
    return rejectedBatch(
      input.records.length,
      BranchActivityPersistStatus.FutureTimestamp
    );
  }

  const ownershipFailure = await validateOwnership(
    tx,
    input.organizationId,
    trusted
  );
  if (ownershipFailure) {
    return rejectedBatch(input.records.length, ownershipFailure);
  }

  const before = await loadPersistedAtoms(tx, input.organizationId, trusted);
  const conflict = trusted.some((record) => {
    const stored = before.get(persistedAtomIdentity(record.persisted));
    return stored && !persistedAtomsReplayCompatible(stored, record.persisted);
  });
  if (conflict) {
    return rejectedBatch(
      input.records.length,
      BranchActivityPersistStatus.Conflict
    );
  }

  const missing = trusted.filter(
    (record) => !before.has(persistedAtomIdentity(record.persisted))
  );
  const inserted = await insertMissingAtoms(tx, missing);
  const after = await loadPersistedAtoms(tx, input.organizationId, trusted);
  const accepted = trusted.map((record) =>
    after.get(persistedAtomIdentity(record.persisted))
  );
  if (
    accepted.some(
      (stored, index) =>
        !(
          stored &&
          persistedAtomsReplayCompatible(stored, trusted[index].persisted)
        )
    )
  ) {
    throw new BranchActivityBatchConflictError();
  }

  await recomputeBranchActivityAggregatesInTransaction(tx, {
    organizationId: input.organizationId,
    branchArtifactIds: accepted.flatMap((row) =>
      row ? [row.branchArtifactId] : []
    ),
  });
  const insertedIdentities = new Set(inserted.map(persistedAtomIdentity));
  const trustedIndexSet = new Set(trustedIndexes);
  return parsed.map((record, index) => {
    if (!trustedIndexSet.has(index)) {
      return { status: BranchActivityPersistStatus.FutureTimestamp };
    }
    return {
      status:
        before.has(persistedAtomIdentity(record.persisted)) ||
        !insertedIdentities.has(persistedAtomIdentity(record.persisted))
          ? BranchActivityPersistStatus.Replayed
          : BranchActivityPersistStatus.Inserted,
    };
  });
}

function parseRecords(
  organizationId: string,
  records: readonly BranchActivityAtomBatchRecord[],
  receivedAt: Date
): ParsedBatchRecord[] | null {
  const parsed: ParsedBatchRecord[] = [];
  for (const record of records) {
    const atom = branchActivityAtomProducerValidator.safeParse(record.atom);
    if (!atom.success) {
      return null;
    }
    parsed.push({
      branchArtifactId: record.branchArtifactId,
      atom: atom.data,
      persisted: {
        version: atom.data.version,
        organizationId,
        branchArtifactId: record.branchArtifactId,
        source: atom.data.source,
        sourceEventId: atom.data.sourceEventId,
        occurredAt: new Date(atom.data.occurredAt),
        activityKind: atom.data.kind ?? null,
        attributionKind: atom.data.attribution.kind,
        pullRequestDetailId: pullRequestId(atom.data),
        completeness: atom.data.completeness,
        createdAt: receivedAt,
      },
    });
  }
  return parsed;
}

async function validateOwnership(
  tx: BranchActivityBatchClient,
  organizationId: string,
  records: readonly ParsedBatchRecord[]
): Promise<BranchActivityPersistStatus | null> {
  const branchIds = [
    ...new Set(records.map((record) => record.branchArtifactId)),
  ];
  const branches = await tx.branchDetail.findMany({
    where: { organizationId, artifactId: { in: branchIds } },
    select: { artifactId: true },
  });
  if (branches.length !== branchIds.length) {
    return BranchActivityPersistStatus.NotFound;
  }

  const pullRequestIds = [
    ...new Set(
      records.flatMap((record) =>
        record.persisted.pullRequestDetailId
          ? [record.persisted.pullRequestDetailId]
          : []
      )
    ),
  ];
  if (pullRequestIds.length === 0) {
    return null;
  }
  const branchByPullRequest =
    await lockPullRequestBranchAttributionsInTransaction(tx, {
      organizationId,
      pullRequestDetailIds: pullRequestIds,
    });
  const valid = records.every((record) => {
    const pullRequestDetailId = record.persisted.pullRequestDetailId;
    return (
      pullRequestDetailId === null ||
      branchByPullRequest.get(pullRequestDetailId) === record.branchArtifactId
    );
  });
  return valid ? null : BranchActivityPersistStatus.InvalidAttribution;
}

async function loadPersistedAtoms(
  tx: BranchActivityBatchClient,
  organizationId: string,
  records: readonly ParsedBatchRecord[]
): Promise<Map<string, PersistedBatchAtom>> {
  const byIdentity = new Map<string, PersistedBatchAtom>();
  for (const chunk of chunksOf(records, ATOM_IDENTITY_READ_CHUNK_SIZE)) {
    const rows = await tx.branchActivityAtom.findMany({
      where: {
        organizationId,
        OR: chunk.map((record) => ({
          branchArtifactId: record.branchArtifactId,
          source: record.atom.source,
          sourceEventId: record.atom.sourceEventId,
        })),
      },
      select: {
        version: true,
        source: true,
        sourceEventId: true,
        occurredAt: true,
        activityKind: true,
        attributionKind: true,
        pullRequestDetailId: true,
        completeness: true,
        createdAt: true,
        branchArtifactId: true,
      },
    });
    for (const row of rows) {
      byIdentity.set(persistedAtomIdentity(row), row);
    }
  }
  return byIdentity;
}

async function insertMissingAtoms(
  tx: BranchActivityBatchClient,
  missing: readonly ParsedBatchRecord[]
): Promise<InsertedAtomIdentity[]> {
  const inserted: InsertedAtomIdentity[] = [];
  for (const chunk of chunksOf(missing, ATOM_INSERT_CHUNK_SIZE)) {
    inserted.push(
      ...(await tx.branchActivityAtom.createManyAndReturn({
        data: chunk.map((record) => record.persisted),
        skipDuplicates: true,
        select: {
          branchArtifactId: true,
          source: true,
          sourceEventId: true,
        },
      }))
    );
  }
  return inserted;
}

function pullRequestId(atom: BranchActivityAtom): string | null {
  return atom.attribution.kind === BranchActivityAttributionKind.PullRequest
    ? atom.attribution.pullRequestId
    : null;
}

function rejectedBatch(
  length: number,
  status: BranchActivityPersistStatus
): BranchActivityPersistResult[] {
  return Array.from({ length }, () => ({ status }));
}

type InsertedAtomIdentity = {
  branchArtifactId: string;
  source: string;
  sourceEventId: string;
};

/** `OR` of `{branchArtifactId, source, sourceEventId}` beside the fixed org bind. */
const ATOM_IDENTITY_READ_CHUNK_SIZE = bindParameterChunkSize(3, 1);
/** Rows per `createManyAndReturn`: every `BranchActivityAtom` column is bound. */
const ATOM_INSERT_CHUNK_SIZE = bindParameterChunkSize(
  BRANCH_ACTIVITY_ATOM_COLUMN_COUNT,
  0
);
