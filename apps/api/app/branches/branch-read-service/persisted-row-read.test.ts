import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findBranchArtifact } from "./persisted-row-read";

/**
 * ISS-9111: `findBranchArtifact` reads the candidate snapshot, reads the artifact
 * row, then reads the snapshot again to CONFIRM it. The confirmation is what
 * fails closed on an interleaving write — `branchWhere` proves only that the row
 * still exists and is owned, so eligibility revoked, or a canonical atom
 * superseded, while the artifact read ran would otherwise be served as admitted
 * state.
 *
 * Both reads are pinned to ONE `evaluationNow`. Left to default their own, the
 * confirmation would evaluate the candidate against a later instant than the read
 * that admitted it, and a disagreement between them could mean either revocation
 * or merely a moved clock.
 *
 * The counts below are literals for what ONE detail read may issue, written from
 * that contract rather than derived from the implementation: two candidate
 * snapshot reads and one artifact read.
 */

const ORGANIZATION_ID = "org-1";
const BRANCH_ID = "branch-1";
const OCCURRED_AT = new Date("2026-08-20T12:00:00.000Z");
const SUPERSEDING_OCCURRED_AT = new Date("2026-08-20T13:00:00.000Z");
const EVALUATION_START = new Date("2026-08-20T14:00:00.000Z");
const READ_ELAPSED_MS = 60_000;

describe("findBranchArtifact", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms the candidate after the artifact read, under one pinned clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVALUATION_START);
    // Time moves while the reads run, so a call that mints its own clock cannot
    // land on the same instant as the one that admitted the candidate.
    const queryRaw = vi.fn().mockImplementation(() => {
      vi.advanceTimersByTime(READ_ELAPSED_MS);
      return Promise.resolve([candidateRawRow()]);
    });
    const findFirst = vi.fn().mockResolvedValue(branchRow());

    const row = await findBranchArtifact(
      detailReadClient(queryRaw, findFirst),
      ORGANIZATION_ID,
      BRANCH_ID
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(evaluationInstantsOf(queryRaw)).toEqual([
      EVALUATION_START.toISOString(),
      EVALUATION_START.toISOString(),
    ]);
    expect(row?.branch.activityAtoms.map((atom) => atom.occurredAt)).toEqual([
      OCCURRED_AT,
    ]);
  });

  it("serves the CONFIRMED atom when the canonical one is superseded mid-read", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([candidateRawRow()])
      .mockResolvedValueOnce([
        candidateRawRow({ atomOccurredAt: SUPERSEDING_OCCURRED_AT }),
      ]);
    const findFirst = vi.fn().mockResolvedValue(branchRow());

    const row = await findBranchArtifact(
      detailReadClient(queryRaw, findFirst),
      ORGANIZATION_ID,
      BRANCH_ID
    );

    expect(row?.branch.activityAtoms.map((atom) => atom.occurredAt)).toEqual([
      SUPERSEDING_OCCURRED_AT,
    ]);
  });

  it("serves nothing when eligibility is revoked while the artifact read runs", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([candidateRawRow()])
      .mockResolvedValueOnce([]);
    const findFirst = vi.fn().mockResolvedValue(branchRow());

    const row = await findBranchArtifact(
      detailReadClient(queryRaw, findFirst),
      ORGANIZATION_ID,
      BRANCH_ID
    );

    expect(row).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("serves nothing when the branch is not an eligible candidate", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn().mockResolvedValue(branchRow());

    const row = await findBranchArtifact(
      detailReadClient(queryRaw, findFirst),
      ORGANIZATION_ID,
      BRANCH_ID
    );

    expect(row).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("serves nothing when the artifact row belongs to another organization", async () => {
    const queryRaw = vi.fn().mockResolvedValue([candidateRawRow()]);
    const findFirst = vi
      .fn()
      .mockResolvedValue(branchRow({ organizationId: "org-2" }));

    const row = await findBranchArtifact(
      detailReadClient(queryRaw, findFirst),
      ORGANIZATION_ID,
      BRANCH_ID
    );

    expect(row).toBeNull();
  });

  // ISS-10298: the detail row's LOC no longer comes out of the artifact read —
  // `getBranchFileChangeTotals` is its only source. Without this, deleting that
  // attach leaves the whole branches suite green while every branch detail
  // reports unknown LOC and the Value-per-$ card silently falls back.
  it("carries the folded file-cache totals, which its own select cannot return", async () => {
    const queryRaw = vi.fn().mockResolvedValue([candidateRawRow()]);
    const findFirst = vi.fn().mockResolvedValue(branchRow());
    const groupBy = vi.fn().mockResolvedValue([
      {
        branchArtifactId: BRANCH_ID,
        headSha: "head-sha-1",
        _sum: { additions: 30, deletions: 4 },
        _count: { _all: 2, additions: 2, deletions: 2 },
      },
    ]);

    const row = await findBranchArtifact(
      {
        $queryRaw: queryRaw,
        artifact: { findFirst },
        branchFileChange: { groupBy },
      } as never,
      ORGANIZATION_ID,
      BRANCH_ID
    );

    expect(
      findFirst.mock.calls[0]?.[0]?.select?.branch?.select
    ).not.toHaveProperty("fileChanges");
    expect(row?.branch.fileChangeTotals).toEqual({
      additions: 30,
      deletions: 4,
      fileCount: 2,
      headSha: "head-sha-1",
    });
  });
});

/**
 * The distinct `evaluationNow` each candidate read interpolated, one entry per
 * read. `Prisma.sql` carries its interpolations on `values`, and the evaluation
 * clock is the only Date this statement binds.
 */
function evaluationInstantsOf(queryRaw: ReturnType<typeof vi.fn>): string[] {
  return queryRaw.mock.calls.map(([statement]) => {
    const dates = (statement as { values: unknown[] }).values.filter(
      (value): value is Date => value instanceof Date
    );
    return [...new Set(dates.map((date) => date.toISOString()))].join("|");
  });
}

function candidateRawRow(overrides: { atomOccurredAt?: Date } = {}) {
  const occurredAt = overrides.atomOccurredAt ?? OCCURRED_AT;
  return {
    id: BRANCH_ID,
    repositorySortKey: "closedloop-ai/closedloop-ai",
    branchSortKey: "feature",
    atomVersion: BranchActivityAtomVersion.V1,
    atomSource: BranchActivitySource.GitHead,
    atomSourceEventId: `event-${BRANCH_ID}`,
    atomOccurredAt: occurredAt,
    atomActivityKind: null,
    atomAttributionKind: BranchActivityAttributionKind.Branch,
    atomPullRequestDetailId: null,
    atomCompleteness: BranchActivityEvidenceCompleteness.Complete,
    atomCreatedAt: occurredAt,
    count: 1n,
    retainedUnavailableCount: 0n,
  };
}

function branchRow(overrides: { organizationId?: string } = {}) {
  return {
    id: BRANCH_ID,
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    name: "feature",
    branch: { artifactId: BRANCH_ID, branchName: "feature" },
  };
}

/**
 * The detail read's client. ISS-10298 added the grouped file-change fold that
 * replaced the per-file relation this select used to load, so the stub answers
 * it too — with no group, which is the no-cached-files case every fixture here
 * already modelled.
 */
function detailReadClient(
  queryRaw: ReturnType<typeof vi.fn>,
  findFirst: ReturnType<typeof vi.fn>
) {
  return {
    $queryRaw: queryRaw,
    artifact: { findFirst },
    branchFileChange: { groupBy: vi.fn().mockResolvedValue([]) },
  } as never;
}
