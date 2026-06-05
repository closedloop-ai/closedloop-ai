import { describe, expect, it } from "vitest";

import { parseExecutionResultFile } from "../src/execution-result";

describe("parseExecutionResultFile", () => {
  it("normalizes ECS sentinel values to null", () => {
    const result = parseExecutionResultFile({
      has_changes: false,
      pr_url: "",
      pr_number: 0,
      branch_name: "",
      base_ref: "main",
      commit_sha: null,
    });
    expect(result).toEqual({
      hasChanges: false,
      prUrl: null,
      prNumber: null,
      prTitle: null,
      branchName: null,
      baseRef: "main",
      baseBranch: null,
      commitSha: null,
      githubId: null,
    });
  });

  it("parses string pr_number", () => {
    const result = parseExecutionResultFile({
      has_changes: true,
      pr_url: "https://github.com/org/repo/pull/42",
      pr_number: "42",
      branch_name: "feat/login",
      base_ref: "main",
      commit_sha: "abc123",
    });
    expect(result?.prNumber).toBe(42);
  });

  it("maps pr_title, base_branch, and github_id when present", () => {
    const result = parseExecutionResultFile({
      has_changes: true,
      pr_url: "https://github.com/org/repo/pull/42",
      pr_number: 42,
      pr_title: "Symphony: feature",
      branch_name: "feat/login",
      base_ref: "main",
      base_branch: "develop",
      commit_sha: "abc123",
      github_id: 999,
    });
    expect(result?.prTitle).toBe("Symphony: feature");
    expect(result?.baseBranch).toBe("develop");
    expect(result?.githubId).toBe(999);
  });

  it("returns null for invalid input", () => {
    expect(parseExecutionResultFile({})).toBeNull();
    expect(parseExecutionResultFile(null)).toBeNull();
    expect(parseExecutionResultFile("string")).toBeNull();
  });

  it("returns null for NaN pr_number string", () => {
    const result = parseExecutionResultFile({
      has_changes: true,
      pr_url: "https://github.com/org/repo/pull/42",
      pr_number: "not-a-number",
      branch_name: "feat/login",
      base_ref: "main",
      commit_sha: "abc123",
    });
    expect(result?.prNumber).toBeNull();
  });
});
