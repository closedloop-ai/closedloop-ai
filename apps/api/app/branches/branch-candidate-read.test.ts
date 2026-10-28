import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { describe, expect, it, vi } from "vitest";
import { renderSql } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  BRANCH_CANDIDATE_READ_BATCH_SIZE,
  BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX,
  getAllBranchCandidateSnapshots,
  getBranchCandidatePage,
  getBranchCandidateSnapshots,
  getGlobalBranchMetricDivisorCandidates,
} from "./branch-candidate-read";

describe("getBranchCandidatePage", () => {
  it("classifies a later-today timestamp against the operation clock, not end-of-day", async () => {
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const laterToday = new Date("2026-08-18T18:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow("future", "acme/repo", "future", laterToday, 1, 1),
      ]);

    const page = await getBranchCandidatePage(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      {
        limit: 20,
        offset: 0,
        startDate: new Date("2026-08-11T00:00:00.000Z"),
        endDate: new Date("2026-08-18T23:59:59.999Z"),
      },
      20,
      0,
      evaluationNow
    );

    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain(`canonical_occurred_at > ${evaluationNow}`);
    expect(page).toMatchObject({
      total: 1,
      retainedUnavailableCount: 1,
      evaluationNow,
    });
  });

  it("returns ordered ids and their canonical atom from one snapshot", async () => {
    const occurredAt = new Date("2026-08-01T00:00:00.000Z");
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow("branch-2", "acme/repo", "alpha", occurredAt, 3, 1),
        candidateRow("branch-3", "acme/repo", "beta", null, 3, 1),
      ]);

    const page = await getBranchCandidatePage(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 2, offset: 1 },
      2,
      1,
      evaluationNow
    );

    expect(queryRaw).toHaveBeenCalledOnce();
    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("WITH candidates AS");
    expect(sql).toContain("facts AS MATERIALIZED");
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain("FROM branch_activity_atoms atom");
    expect(sql).toContain("atom.version = 1");
    expect(sql).toContain("atom.source_event_id = btrim(atom.source_event_id)");
    expect(sql).toContain("length(atom.source_event_id) BETWEEN 1 AND 512");
    expect(sql).toContain("isfinite(atom.occurred_at)");
    expect(sql).toContain("atom.occurred_at <= atom.created_at");
    expect(sql).toContain("FROM pull_request_detail activity_pr");
    expect(sql).toContain(
      "ORDER BY atom.occurred_at DESC, atom.source ASC, atom.source_event_id ASC"
    );
    expect(sql).toContain("latest_activity_atom.occurred_at");
    expect(sql).toContain("AS canonical_occurred_at");
    expect(sql).toContain("candidate.canonical_occurred_at >");
    // ISS-11915: the only last-activity column read is the linked sessions'
    // own fallback, and only for a branch with no eligible atom.
    expect(sql).toContain("MAX(sd.last_activity_at)");
    expect(sql).toContain("WHERE latest_activity_atom.occurred_at IS NULL");
    expect(sql).toContain('candidate."repositorySortKey" ASC');
    expect(sql).toContain('candidate."branchSortKey" ASC');
    expect(sql).toContain("candidate.id ASC");
    expect(sql).toContain("regexp_replace");
    expect(sql).not.toContain("b.last_activity_at");
    expect(sql).toContain("COUNT(*)::bigint AS count");
    expect(sql).toContain("retained_unavailable_count");
    expect(page).toEqual({
      candidates: [
        {
          id: "branch-2",
          repositorySortKey: "acme/repo",
          branchSortKey: "alpha",
          activityAtom: {
            version: BranchActivityAtomVersion.V1,
            source: BranchActivitySource.GitHead,
            sourceEventId: "event-branch-2",
            occurredAt,
            activityKind: null,
            attributionKind: BranchActivityAttributionKind.Branch,
            pullRequestDetailId: null,
            completeness: BranchActivityEvidenceCompleteness.Complete,
            createdAt: occurredAt,
          },
        },
        {
          id: "branch-3",
          repositorySortKey: "acme/repo",
          branchSortKey: "beta",
          activityAtom: null,
        },
      ],
      ids: ["branch-2", "branch-3"],
      total: 3,
      hasMore: false,
      retainedUnavailableCount: 1,
      evaluationNow,
    });
  });

  it("does not exclude a branch on deleted_at: deletion decides only whether it is active (ISS-11589)", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await getBranchCandidatePage(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 20, offset: 0 },
      20,
      0,
      new Date("2026-08-18T12:00:00.000Z")
    );

    expect(renderSql(queryRaw.mock.calls[0]?.[0])).not.toContain("deleted_at");
  });
});

describe("getAllBranchCandidateSnapshots", () => {
  it("reads a full corpus with bounded keyset pages instead of offset paging", async () => {
    const fullCorpusBatchSize = 5000;
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: fullCorpusBatchSize }, (_, index) =>
          candidateRow(
            candidateId(index),
            "acme/repo",
            `branch-${index.toString().padStart(4, "0")}`,
            null,
            fullCorpusBatchSize + 2
          )
        )
      )
      .mockResolvedValueOnce([
        candidateRow(candidateId(5000), "acme/repo", "branch-5000", null, 0),
        candidateRow(candidateId(5001), "acme/repo", "branch-5001", null, 0),
      ]);

    const candidates = await getAllBranchCandidateSnapshots(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 }
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      ...Array.from({ length: fullCorpusBatchSize }, (_, index) =>
        candidateId(index)
      ),
      candidateId(5000),
      candidateId(5001),
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("ORDER BY CASE");
    expect(sql).not.toContain("OFFSET");
    expect(sql).toContain(`LIMIT ${fullCorpusBatchSize}`);
    const secondSql = renderSql(queryRaw.mock.calls[1]?.[0]);
    expect(secondSql).not.toContain("OFFSET");
    expect(secondSql).toContain(`${candidateId(4999)}::uuid`);
    expect(secondSql).toContain("a.id >");
  });

  it("keeps requested-id chunks on the smaller bind-safe batch size", async () => {
    const requestedIds = Array.from(
      { length: BRANCH_CANDIDATE_READ_BATCH_SIZE + 1 },
      (_, index) => `branch-${index}`
    );
    const queryRaw = vi.fn().mockResolvedValue([]);

    await getBranchCandidateSnapshots(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      requestedIds
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("getGlobalBranchMetricDivisorCandidates", () => {
  it("selects only bounded ids while preserving non-date denominator authority", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ id: "branch-a" }, { id: "branch-b" }]);

    const result = await getGlobalBranchMetricDivisorCandidates(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      {
        limit: 50,
        offset: 0,
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        endDate: new Date("2026-08-08T00:00:00.000Z"),
      }
    );

    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("SELECT a.id");
    expect(sql).toContain("FROM artifacts a");
    expect(sql).toContain("FROM artifact_links al");
    expect(sql).toContain("facts AS MATERIALIZED");
    expect(sql).toContain("ORDER BY a.id ASC");
    expect(sql).toContain(
      `LIMIT ${BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX + 1}`
    );
    expect(sql).not.toContain("LEFT JOIN LATERAL");
    expect(sql).not.toContain("branch_activity_atoms atom");
    expect(sql).not.toContain("canonical_occurred_at");
    expect(sql).not.toContain("2026-08-01");
    expect(sql).not.toContain("2026-08-08");
    expect(sql).not.toContain("OFFSET");
    expect(result).toEqual({
      ids: ["branch-a", "branch-b"],
      coverageComplete: true,
    });
  });

  it("caps global divisors before usage hydration", async () => {
    const rows = Array.from(
      { length: BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX + 1 },
      (_, index) => ({ id: `branch-${index}` })
    );
    const queryRaw = vi.fn().mockResolvedValue(rows);

    const result = await getGlobalBranchMetricDivisorCandidates(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 }
    );

    expect(result.ids).toHaveLength(BRANCH_METRIC_DENOMINATOR_CANDIDATE_MAX);
    expect(result.coverageComplete).toBe(false);
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});

function candidateRow(
  id: string,
  repositorySortKey: string,
  branchSortKey: string,
  occurredAt: Date | null,
  count: number,
  retainedUnavailableCount = 0
) {
  return {
    id,
    repositorySortKey,
    branchSortKey,
    atomVersion: occurredAt ? BranchActivityAtomVersion.V1 : null,
    atomSource: occurredAt ? BranchActivitySource.GitHead : null,
    atomSourceEventId: occurredAt ? `event-${id}` : null,
    atomOccurredAt: occurredAt,
    atomActivityKind: null,
    atomAttributionKind: occurredAt
      ? BranchActivityAttributionKind.Branch
      : null,
    atomPullRequestDetailId: null,
    atomCompleteness: occurredAt
      ? BranchActivityEvidenceCompleteness.Complete
      : null,
    atomCreatedAt: occurredAt,
    count: BigInt(count),
    retainedUnavailableCount: BigInt(retainedUnavailableCount),
  };
}

function candidateId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
