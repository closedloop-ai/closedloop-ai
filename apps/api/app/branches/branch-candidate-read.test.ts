import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { describe, expect, it, vi } from "vitest";
import { renderSql } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { getBranchCandidatePage } from "./branch-candidate-read";

describe("getBranchCandidatePage", () => {
  it("returns ordered ids and their canonical atom from one snapshot", async () => {
    const occurredAt = new Date("2026-08-01T00:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow("branch-2", "acme/repo", "alpha", occurredAt, 3),
        candidateRow("branch-3", "acme/repo", "beta", null, 3),
      ]);

    const page = await getBranchCandidatePage(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 2, offset: 1 },
      2,
      1
    );

    expect(queryRaw).toHaveBeenCalledOnce();
    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("WITH candidates AS");
    expect(sql).toContain("repository_default_authorities");
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain("FROM branch_activity_atoms atom");
    expect(sql).toContain("atom.version = 1");
    expect(sql).toContain("atom.source_event_id = btrim(atom.source_event_id)");
    expect(sql).toContain("length(atom.source_event_id) <= 512");
    expect(sql).toContain("isfinite(atom.occurred_at)");
    expect(sql).toContain("FROM pull_request_detail activity_pr");
    expect(sql).toContain(
      "ORDER BY atom.occurred_at DESC, atom.source ASC, atom.source_event_id ASC"
    );
    expect(sql).toContain("latest_activity_atom.occurred_at");
    expect(sql).toContain('candidate."repositorySortKey" ASC');
    expect(sql).toContain('candidate."branchSortKey" ASC');
    expect(sql).toContain("candidate.id ASC");
    expect(sql).toContain("regexp_replace");
    expect(sql).not.toContain("b.last_activity_at");
    expect(sql).toContain("SELECT COUNT(*)::bigint AS count FROM candidates");
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
            attributionKind: BranchActivityAttributionKind.Branch,
            pullRequestDetailId: null,
            completeness: BranchActivityEvidenceCompleteness.Complete,
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
    });
  });
});

function candidateRow(
  id: string,
  repositorySortKey: string,
  branchSortKey: string,
  occurredAt: Date | null,
  count: number
) {
  return {
    id,
    repositorySortKey,
    branchSortKey,
    atomVersion: occurredAt ? BranchActivityAtomVersion.V1 : null,
    atomSource: occurredAt ? BranchActivitySource.GitHead : null,
    atomSourceEventId: occurredAt ? `event-${id}` : null,
    atomOccurredAt: occurredAt,
    atomAttributionKind: occurredAt
      ? BranchActivityAttributionKind.Branch
      : null,
    atomPullRequestDetailId: null,
    atomCompleteness: occurredAt
      ? BranchActivityEvidenceCompleteness.Complete
      : null,
    count: BigInt(count),
  };
}
