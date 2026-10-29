import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/branch-activity-kind";
import { describe, expect, it, vi } from "vitest";
import { storedAtomIdentity } from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { bindParameterChunkSize } from "@/app/agent-sessions/service/write-chunking";
import { BranchActivityPersistStatus } from "./branch-activity-evidence";
import {
  BranchActivityBatchConflictError,
  persistBranchActivityAtomsInTransaction,
} from "./branch-activity-evidence-batch";

const ORGANIZATION_ID = "019ff900-1000-7000-8000-000000000001";
const BRANCH_ONE = "019ff900-1000-7000-8000-000000000002";
const BRANCH_TWO = "019ff900-1000-7000-8000-000000000003";
const PULL_REQUEST_ID = "019ff900-1000-7000-8000-000000000004";
/**
 * The bind budgets the writer sizes its statements against, derived here
 * independently: three binds per identity beside the org bind for the `OR`
 * read, and the seventeen `BranchActivityAtom` columns per inserted row —
 * thirteen, plus the four ISS-10009 push-evidence columns.
 */
const IDENTITY_READ_CHUNK = bindParameterChunkSize(3, 1);
const INSERT_CHUNK = bindParameterChunkSize(17, 0);
/** Every seventh record of the wide batch is pre-stored, so replays interleave. */
const PRESTORED_STRIDE = 7;

describe("batched Branch activity persistence", () => {
  it("persists a 100-PR-equivalent batch with fixed database statements", async () => {
    const stored: StoredAtom[] = [];
    const tx = createBatchClient(stored);
    const records = Array.from({ length: 200 }, (_, index) => ({
      branchArtifactId: index % 2 === 0 ? BRANCH_ONE : BRANCH_TWO,
      atom: atom(
        `event-${index + 1}`,
        index % 2 === 0 ? undefined : PULL_REQUEST_ID
      ),
    }));

    const results = await persistBranchActivityAtomsInTransaction(tx as never, {
      organizationId: ORGANIZATION_ID,
      records,
    });

    expect(results).toHaveLength(200);
    expect(results).toEqual(
      expect.arrayContaining([{ status: BranchActivityPersistStatus.Inserted }])
    );
    expect(tx.branchDetail.findMany).toHaveBeenCalledOnce();
    expect(tx.branchDetail.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        artifactId: { in: [BRANCH_ONE, BRANCH_TWO] },
      },
      select: { artifactId: true },
    });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.branchActivityAtom.findMany).toHaveBeenCalledTimes(2);
    expect(tx.branchActivityAtom.createManyAndReturn).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(200);
  });

  it("chunks the identity reads and the insert at the bind budget and answers in input order (ISS-9860)", async () => {
    const recordCount = IDENTITY_READ_CHUNK + 1;
    const stored: StoredAtom[] = Array.from(
      { length: recordCount },
      (_, index) => index
    )
      .filter((index) => index % PRESTORED_STRIDE === 0)
      .map((index) => persistedAtom(BRANCH_ONE, `event-${index}`));
    const prestoredCount = stored.length;
    const tx = createBatchClient(stored);
    const records = Array.from({ length: recordCount }, (_, index) => ({
      branchArtifactId: BRANCH_ONE,
      atom: atom(`event-${index}`),
    }));

    const results = await persistBranchActivityAtomsInTransaction(tx as never, {
      organizationId: ORGANIZATION_ID,
      records,
    });

    expect(results).toHaveLength(recordCount);
    expect(results).toEqual(
      records.map((_, index) => ({
        status:
          index % PRESTORED_STRIDE === 0
            ? BranchActivityPersistStatus.Replayed
            : BranchActivityPersistStatus.Inserted,
      }))
    );
    // One read before the insert and one after, each split per chunk.
    const readChunks = Math.ceil(recordCount / IDENTITY_READ_CHUNK);
    expect(readChunks).toBe(2);
    expect(tx.branchActivityAtom.findMany).toHaveBeenCalledTimes(
      2 * readChunks
    );
    for (const [args] of tx.branchActivityAtom.findMany.mock.calls) {
      expect(args.where.OR.length).toBeLessThanOrEqual(IDENTITY_READ_CHUNK);
    }
    const insertChunks = Math.ceil(
      (recordCount - prestoredCount) / INSERT_CHUNK
    );
    expect(insertChunks).toBeGreaterThan(1);
    expect(tx.branchActivityAtom.createManyAndReturn).toHaveBeenCalledTimes(
      insertChunks
    );
    for (const [args] of tx.branchActivityAtom.createManyAndReturn.mock.calls) {
      expect(args.data.length).toBeLessThanOrEqual(INSERT_CHUNK);
    }
    expect(stored).toHaveLength(recordCount);
    // One aggregate recompute for the one branch; no PR lock on this batch.
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
  });

  it("rejects a conflicting identity before any insert or aggregate update", async () => {
    const stored = [
      persistedAtom(BRANCH_ONE, "event-1", {
        occurredAt: new Date("2026-08-12T13:00:00.000Z"),
      }),
    ];
    const tx = createBatchClient(stored);

    await expect(
      persistBranchActivityAtomsInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        records: [{ branchArtifactId: BRANCH_ONE, atom: atom("event-1") }],
      })
    ).resolves.toEqual([{ status: BranchActivityPersistStatus.Conflict }]);
    expect(tx.branchActivityAtom.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects the batch when any branch is outside the organization", async () => {
    const tx = createBatchClient([]);
    tx.branchDetail.findMany.mockReturnValueOnce([{ artifactId: BRANCH_ONE }]);

    await expect(
      persistBranchActivityAtomsInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        records: [
          { branchArtifactId: BRANCH_ONE, atom: atom("event-1") },
          { branchArtifactId: BRANCH_TWO, atom: atom("event-2") },
        ],
      })
    ).resolves.toEqual([
      { status: BranchActivityPersistStatus.NotFound },
      { status: BranchActivityPersistStatus.NotFound },
    ]);
    expect(tx.branchActivityAtom.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("throws a typed conflict when an incompatible writer wins after the pre-read", async () => {
    const stored: StoredAtom[] = [];
    const tx = createBatchClient(stored);
    tx.branchActivityAtom.createManyAndReturn.mockImplementationOnce(
      ({ data }) => {
        const first = data[0];
        if (!first) {
          throw new Error("Expected one missing atom");
        }
        stored.push({
          ...first,
          occurredAt: new Date("2026-08-12T13:00:00.000Z"),
        });
        return [];
      }
    );

    await expect(
      persistBranchActivityAtomsInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        records: [{ branchArtifactId: BRANCH_ONE, atom: atom("event-1") }],
      })
    ).rejects.toBeInstanceOf(BranchActivityBatchConflictError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

type StoredAtom = ReturnType<typeof persistedAtom>;

function atom(sourceEventId: string, pullRequestId?: string) {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.MonitoredSession,
    kind: MonitoredSessionActivityEventKind.AgentRead,
    sourceEventId,
    occurredAt: "2026-08-12T12:00:00.000Z",
    attribution: pullRequestId
      ? {
          kind: BranchActivityAttributionKind.PullRequest,
          pullRequestId,
        }
      : { kind: BranchActivityAttributionKind.Branch },
    completeness: BranchActivityEvidenceCompleteness.Complete,
  };
}

function persistedAtom(
  branchArtifactId: string,
  sourceEventId: string,
  overrides: Partial<{
    occurredAt: Date;
  }> = {}
) {
  return {
    version: BranchActivityAtomVersion.V1,
    organizationId: ORGANIZATION_ID,
    branchArtifactId,
    source: BranchActivitySource.MonitoredSession,
    activityKind: MonitoredSessionActivityEventKind.AgentRead,
    sourceEventId,
    occurredAt: new Date("2026-08-12T12:00:00.000Z"),
    attributionKind: BranchActivityAttributionKind.Branch,
    pullRequestDetailId: null,
    completeness: BranchActivityEvidenceCompleteness.Complete,
    ...overrides,
  };
}

function createBatchClient(stored: StoredAtom[]) {
  return {
    branchDetail: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          where.artifactId.in.map((artifactId: string) => ({ artifactId }))
        ),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        { id: PULL_REQUEST_ID, branchArtifactId: BRANCH_TWO },
      ]),
    branchActivityAtom: {
      // Set-keyed rather than `OR.some` per row: the chunking case pushes
      // ~11k identities through here four times, and a quadratic scan stalls.
      findMany: vi.fn().mockImplementation(({ where }) => {
        const wanted = new Set<string>(
          where.OR.map(
            (identity: {
              branchArtifactId: string;
              source: string;
              sourceEventId: string;
            }) => storedAtomIdentity(identity)
          )
        );
        return stored.filter(
          (row) =>
            row.organizationId === where.organizationId &&
            wanted.has(storedAtomIdentity(row))
        );
      }),
      createManyAndReturn: vi.fn().mockImplementation(({ data }) => {
        stored.push(...data);
        return data.map((row: StoredAtom) => ({
          branchArtifactId: row.branchArtifactId,
          source: row.source,
          sourceEventId: row.sourceEventId,
        }));
      }),
    },
    $executeRaw: vi.fn().mockResolvedValue(2),
  };
}
