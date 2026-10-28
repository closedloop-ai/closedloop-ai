import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchActivityPersistStatus } from "./branch-activity-evidence";

const persistBatchMock = vi.hoisted(() => vi.fn());

vi.mock("./branch-activity-evidence-batch", async () => {
  const actual = await vi.importActual<
    typeof import("./branch-activity-evidence-batch")
  >("./branch-activity-evidence-batch");
  return {
    ...actual,
    persistBranchActivityAtomsInTransaction: persistBatchMock,
  };
});

import { BranchActivityBatchConflictError } from "./branch-activity-evidence-batch";
import {
  PullRequestLifecycleActivityPersistenceError,
  persistPullRequestLifecycleActivityInTransaction,
} from "./pull-request-lifecycle-activity";

const organizationId = "019ff900-2000-7000-8000-000000000001";
const branchArtifactId = "019ff900-2000-7000-8000-000000000002";
const pullRequestDetailId = "019ff900-2000-7000-8000-000000000003";
const openedAt = new Date("2026-08-10T12:00:00.000Z");
const mergedAt = new Date("2026-08-11T12:00:00.000Z");
const closedAt = new Date("2026-08-11T13:00:00.000Z");

describe("pull request lifecycle activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistBatchMock.mockResolvedValue([
      { status: BranchActivityPersistStatus.Inserted },
      { status: BranchActivityPersistStatus.Inserted },
    ]);
  });

  it("writes opened and merged atoms with stable complete PR attribution", async () => {
    const tx = { transaction: true };

    await persistPullRequestLifecycleActivityInTransaction(tx as never, {
      organizationId,
      branchArtifactId,
      pullRequestDetailId,
      openedAt,
      mergedAt,
      closedAt,
    });

    expect(persistBatchMock).toHaveBeenCalledWith(tx, {
      organizationId,
      records: [
        lifecycleRecord("opened", openedAt),
        lifecycleRecord("merged", mergedAt),
      ],
    });
  });

  it("uses closed only when merged evidence is absent", async () => {
    const tx = transactionMock();

    await persistPullRequestLifecycleActivityInTransaction(tx as never, {
      organizationId,
      branchArtifactId,
      pullRequestDetailId,
      openedAt,
      mergedAt: null,
      closedAt,
    });

    expect(persistBatchMock).toHaveBeenCalledWith(tx, {
      organizationId,
      records: [
        lifecycleRecord("opened", openedAt),
        lifecycleRecord("closed", closedAt),
      ],
    });
  });

  it("assigns each close occurrence a distinct immutable identity", async () => {
    const reopenedClosedAt = new Date("2026-08-12T13:00:00.000Z");

    await persistPullRequestLifecycleActivityInTransaction(
      transactionMock() as never,
      {
        organizationId,
        branchArtifactId,
        pullRequestDetailId,
        openedAt: null,
        mergedAt: null,
        closedAt: reopenedClosedAt,
      }
    );

    expect(persistBatchMock).toHaveBeenCalledWith(expect.anything(), {
      organizationId,
      records: [lifecycleRecord("closed", reopenedClosedAt)],
    });
    expect(lifecycleRecord("closed", closedAt).atom.sourceEventId).not.toBe(
      lifecycleRecord("closed", reopenedClosedAt).atom.sourceEventId
    );
  });

  it("replays matching legacy close evidence without duplicating it", async () => {
    const tx = transactionMock([persistedClosedAtom(closedAt)]);

    await persistPullRequestLifecycleActivityInTransaction(tx as never, {
      organizationId,
      branchArtifactId,
      pullRequestDetailId,
      openedAt: null,
      mergedAt: null,
      closedAt,
    });

    expect(persistBatchMock).toHaveBeenCalledWith(tx, {
      organizationId,
      records: [legacyLifecycleRecord("closed", closedAt)],
    });
  });

  it("does not reuse a legacy close identity for a later close occurrence", async () => {
    const tx = transactionMock([persistedClosedAtom(closedAt)]);
    const reopenedClosedAt = new Date("2026-08-12T13:00:00.000Z");

    await persistPullRequestLifecycleActivityInTransaction(tx as never, {
      organizationId,
      branchArtifactId,
      pullRequestDetailId,
      openedAt: null,
      mergedAt: null,
      closedAt: reopenedClosedAt,
    });

    expect(persistBatchMock).toHaveBeenCalledWith(tx, {
      organizationId,
      records: [lifecycleRecord("closed", reopenedClosedAt)],
    });
  });

  it("does not invent activity when authoritative timestamps are absent", async () => {
    const tx = { transaction: true };
    persistBatchMock.mockResolvedValueOnce([]);

    await persistPullRequestLifecycleActivityInTransaction(tx as never, {
      organizationId,
      branchArtifactId,
      pullRequestDetailId,
      openedAt: null,
      mergedAt: null,
      closedAt: null,
    });

    expect(persistBatchMock).toHaveBeenCalledWith(tx, {
      organizationId,
      records: [],
    });
  });

  it.each([
    BranchActivityPersistStatus.Conflict,
    BranchActivityPersistStatus.Invalid,
    BranchActivityPersistStatus.NotFound,
    BranchActivityPersistStatus.InvalidAttribution,
  ])("rejects the enclosing writer for %s", async (status) => {
    persistBatchMock.mockResolvedValueOnce([{ status }]);

    await expect(
      persistPullRequestLifecycleActivityInTransaction({} as never, {
        organizationId,
        branchArtifactId,
        pullRequestDetailId,
        openedAt,
        mergedAt: null,
        closedAt: null,
      })
    ).rejects.toMatchObject({
      name: PullRequestLifecycleActivityPersistenceError.name,
      statuses: [status],
    });
  });

  it("maps a concurrent canonical batch conflict to the lifecycle error", async () => {
    persistBatchMock.mockRejectedValueOnce(
      new BranchActivityBatchConflictError()
    );

    await expect(
      persistPullRequestLifecycleActivityInTransaction({} as never, {
        organizationId,
        branchArtifactId,
        pullRequestDetailId,
        openedAt,
        mergedAt: null,
        closedAt: null,
      })
    ).rejects.toMatchObject({
      name: PullRequestLifecycleActivityPersistenceError.name,
      statuses: [BranchActivityPersistStatus.Conflict],
    });
  });
});

function lifecycleRecord(
  suffix: "opened" | "merged" | "closed",
  occurredAt: Date
) {
  return {
    branchArtifactId,
    atom: {
      version: BranchActivityAtomVersion.V1,
      source: BranchActivitySource.PullRequestLifecycle,
      sourceEventId:
        suffix === "closed"
          ? `${pullRequestDetailId}:${suffix}:${occurredAt.toISOString()}`
          : `${pullRequestDetailId}:${suffix}`,
      occurredAt: occurredAt.toISOString(),
      attribution: {
        kind: BranchActivityAttributionKind.PullRequest,
        pullRequestId: pullRequestDetailId,
      },
      completeness: BranchActivityEvidenceCompleteness.Complete,
    },
  };
}

function legacyLifecycleRecord(
  suffix: "opened" | "merged" | "closed",
  occurredAt: Date
) {
  const record = lifecycleRecord(suffix, occurredAt);
  return {
    ...record,
    atom: {
      ...record.atom,
      sourceEventId: `${pullRequestDetailId}:${suffix}`,
    },
  };
}

function persistedClosedAtom(occurredAt: Date) {
  return {
    version: BranchActivityAtomVersion.V1,
    branchArtifactId,
    source: BranchActivitySource.PullRequestLifecycle,
    sourceEventId: `${pullRequestDetailId}:closed`,
    occurredAt,
    attributionKind: BranchActivityAttributionKind.PullRequest,
    pullRequestDetailId,
    completeness: BranchActivityEvidenceCompleteness.Complete,
  };
}

function transactionMock(persistedAtoms: unknown[] = []) {
  return {
    branchActivityAtom: {
      findMany: vi.fn().mockResolvedValue(persistedAtoms),
    },
  };
}
