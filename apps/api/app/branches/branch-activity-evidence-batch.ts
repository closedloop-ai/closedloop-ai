import {
  type BranchActivityAtom,
  BranchActivityAttributionKind,
  branchActivityAtomProducerValidator,
} from "@repo/api/src/types/branch-activity";
import { Prisma, type TransactionClient } from "@repo/database";
import {
  type BranchActivityPersistResult,
  BranchActivityPersistStatus,
  type PersistedBranchActivityAtom,
  persistedAtomsReplayCompatible,
} from "./branch-activity-evidence";

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
  "$executeRaw" | "branchActivityAtom" | "branchDetail" | "pullRequestDetail"
>;

/**
 * Validate and persist one bounded Session's activity atoms with set-based
 * ownership reads, insertion, replay verification, and aggregate advancement.
 */
export async function persistBranchActivityAtomsInTransaction(
  tx: BranchActivityBatchClient,
  input: {
    organizationId: string;
    records: readonly BranchActivityAtomBatchRecord[];
  }
): Promise<BranchActivityPersistResult[]> {
  if (input.records.length === 0) {
    return [];
  }
  const parsed = parseRecords(input.organizationId, input.records);
  if (!parsed) {
    return rejectedBatch(
      input.records.length,
      BranchActivityPersistStatus.Invalid
    );
  }

  const ownershipFailure = await validateOwnership(
    tx,
    input.organizationId,
    parsed
  );
  if (ownershipFailure) {
    return rejectedBatch(input.records.length, ownershipFailure);
  }

  const before = await loadPersistedAtoms(tx, input.organizationId, parsed);
  const conflict = parsed.some((record) => {
    const stored = before.get(atomIdentity(record.persisted));
    return stored && !persistedAtomsReplayCompatible(stored, record.persisted);
  });
  if (conflict) {
    return rejectedBatch(
      input.records.length,
      BranchActivityPersistStatus.Conflict
    );
  }

  const missing = parsed.filter(
    (record) => !before.has(atomIdentity(record.persisted))
  );
  const inserted =
    missing.length === 0
      ? { count: 0 }
      : await tx.branchActivityAtom.createMany({
          data: missing.map((record) => record.persisted),
          skipDuplicates: true,
        });
  const after = await loadPersistedAtoms(tx, input.organizationId, parsed);
  const accepted = parsed.map((record) =>
    after.get(atomIdentity(record.persisted))
  );
  if (
    accepted.some(
      (stored, index) =>
        !(
          stored &&
          persistedAtomsReplayCompatible(stored, parsed[index].persisted)
        )
    )
  ) {
    throw new Error("branch activity batch changed during persistence");
  }

  await advanceBranchActivity(tx, input.organizationId, accepted);
  const insertedAllMissing = inserted.count === missing.length;
  return parsed.map((record) => ({
    status:
      before.has(atomIdentity(record.persisted)) || !insertedAllMissing
        ? BranchActivityPersistStatus.Replayed
        : BranchActivityPersistStatus.Inserted,
  }));
}

function parseRecords(
  organizationId: string,
  records: readonly BranchActivityAtomBatchRecord[]
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
        attributionKind: atom.data.attribution.kind,
        pullRequestDetailId: pullRequestId(atom.data),
        completeness: atom.data.completeness,
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
  const pullRequests = await tx.pullRequestDetail.findMany({
    where: { organizationId, id: { in: pullRequestIds } },
    select: { branchArtifactId: true, id: true },
  });
  const branchByPullRequest = new Map(
    pullRequests.map((pullRequest) => [
      pullRequest.id,
      pullRequest.branchArtifactId,
    ])
  );
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
  const rows = await tx.branchActivityAtom.findMany({
    where: {
      organizationId,
      OR: records.map((record) => ({
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
      attributionKind: true,
      pullRequestDetailId: true,
      completeness: true,
      branchArtifactId: true,
    },
  });
  return new Map(rows.map((row) => [atomIdentity(row), row]));
}

async function advanceBranchActivity(
  tx: BranchActivityBatchClient,
  organizationId: string,
  rows: readonly (PersistedBatchAtom | undefined)[]
): Promise<void> {
  const latestByBranch = new Map<string, Date>();
  for (const row of rows) {
    if (!row) {
      continue;
    }
    const branchArtifactId = row.branchArtifactId;
    const current = latestByBranch.get(branchArtifactId);
    if (!current || current < row.occurredAt) {
      latestByBranch.set(branchArtifactId, row.occurredAt);
    }
  }
  if (latestByBranch.size === 0) {
    return;
  }
  const values = [...latestByBranch].map(
    ([artifactId, occurredAt]) =>
      Prisma.sql`(${artifactId}::uuid, ${occurredAt}::timestamptz)`
  );
  await tx.$executeRaw(Prisma.sql`
    UPDATE branch_detail AS branch
    SET last_activity_at = data.occurred_at,
        updated_at = now()
    FROM (VALUES ${Prisma.join(values)}) AS data(artifact_id, occurred_at)
    WHERE branch.artifact_id = data.artifact_id
      AND branch.organization_id = ${organizationId}::uuid
      AND (branch.last_activity_at IS NULL OR branch.last_activity_at < data.occurred_at)
  `);
}

function pullRequestId(atom: BranchActivityAtom): string | null {
  return atom.attribution.kind === BranchActivityAttributionKind.PullRequest
    ? atom.attribution.pullRequestId
    : null;
}

function atomIdentity(
  atom: Pick<PersistedBranchActivityAtom, "source" | "sourceEventId"> & {
    branchArtifactId?: string;
  }
): string {
  return `${atom.branchArtifactId ?? ""}\u0000${atom.source}\u0000${atom.sourceEventId}`;
}

function rejectedBatch(
  length: number,
  status: BranchActivityPersistStatus
): BranchActivityPersistResult[] {
  return Array.from({ length }, () => ({ status }));
}
