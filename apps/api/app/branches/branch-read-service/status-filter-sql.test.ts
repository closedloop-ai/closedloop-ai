import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import { branchCandidateStatusClause } from "./status-filter-sql";

const MERGED_NO_PR_FALLBACK_PATTERN = /a\.status = \?\s+AND NOT EXISTS/;

describe("branchCandidateStatusClause", () => {
  it("assembles selected-PR and no-PR local evidence for merged status", () => {
    const clause = branchCandidateStatusClause(BranchStatus.Merged);

    expect(clause.sql).toContain("pr.pr_state =");
    expect(clause.sql).toContain("pr.merged_at IS NOT NULL");
    expect(clause.sql).toMatch(MERGED_NO_PR_FALLBACK_PATTERN);
    expect(clause.values).toContain(GitHubPRState.Merged);
  });

  it("matches selected PR ownership by stable provider repository id", () => {
    const clause = branchCandidateStatusClause(BranchStatus.Merged);

    expect(clause.sql).toContain("resolved.repository_github_id IS NOT NULL");
    expect(clause.sql).toContain("owning_repository.github_repo_id");
    expect(clause.sql).toContain("selected_repository.github_repo_id");
    expect(clause.sql).toContain("resolved.repository_github_id =");
    expect(clause.sql).not.toContain(
      "resolved.repository_id = b.repository_id"
    );
  });
});
