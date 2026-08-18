import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { describe, expect, it, vi } from "vitest";
import { BranchActivityPersistStatus } from "./branch-activity-evidence";
import { persistBranchActivityAtomsInTransaction } from "./branch-activity-evidence-batch";

const ORGANIZATION_ID = "019ff900-1000-7000-8000-000000000001";
const BRANCH_ONE = "019ff900-1000-7000-8000-000000000002";
const BRANCH_TWO = "019ff900-1000-7000-8000-000000000003";
const PULL_REQUEST_ID = "019ff900-1000-7000-8000-000000000004";

describe("batched Branch activity persistence", () => {
  it("persists a Session batch with a fixed set of database statements", async () => {
    const stored: StoredAtom[] = [];
    const tx = createBatchClient(stored);

    await expect(
      persistBranchActivityAtomsInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        records: [
          { branchArtifactId: BRANCH_ONE, atom: atom("event-1") },
          {
            branchArtifactId: BRANCH_TWO,
            atom: atom("event-2", PULL_REQUEST_ID),
          },
        ],
      })
    ).resolves.toEqual([
      { status: BranchActivityPersistStatus.Inserted },
      { status: BranchActivityPersistStatus.Inserted },
    ]);

    expect(tx.branchDetail.findMany).toHaveBeenCalledOnce();
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledOnce();
    expect(tx.branchActivityAtom.findMany).toHaveBeenCalledTimes(2);
    expect(tx.branchActivityAtom.createMany).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(stored).toHaveLength(2);
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
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

type StoredAtom = ReturnType<typeof persistedAtom>;

function atom(sourceEventId: string, pullRequestId?: string) {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.MonitoredSession,
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
    pullRequestDetail: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: PULL_REQUEST_ID, branchArtifactId: BRANCH_TWO },
        ]),
    },
    branchActivityAtom: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          stored.filter(
            (row) =>
              row.organizationId === where.organizationId &&
              where.OR.some(
                (identity: {
                  branchArtifactId: string;
                  source: string;
                  sourceEventId: string;
                }) =>
                  identity.branchArtifactId === row.branchArtifactId &&
                  identity.source === row.source &&
                  identity.sourceEventId === row.sourceEventId
              )
          )
        ),
      createMany: vi.fn().mockImplementation(({ data }) => {
        stored.push(...data);
        return { count: data.length };
      }),
    },
    $executeRaw: vi.fn().mockResolvedValue(2),
  };
}
