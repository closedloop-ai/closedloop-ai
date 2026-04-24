import { describe, expect, it } from "vitest";
import { LoopEventSchema } from "../src/events";
import {
  createRepoExecutionResultsSchema,
  ExecutionResultV2Schema,
  getPrimaryRepoResult,
  normalizeV1ExecutionResult,
  parseExecutionResultFile,
  RepoExecutionResultSchema,
} from "../src/execution-result";

describe("parseExecutionResultFile", () => {
  it("normalizes ECS sentinel values to null (v1)", () => {
    const result = parseExecutionResultFile(
      {
        has_changes: false,
        pr_url: "",
        pr_number: 0,
        branch_name: "",
        base_ref: "main",
        commit_sha: null,
      },
      "owner/repo"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schemaVersion).toBe(1);
      expect(result.repoCount).toBe(1);
      expect(result.results[0].status).toBe("skipped");
    }
  });

  it("parses string pr_number (v1)", () => {
    const result = parseExecutionResultFile(
      {
        has_changes: true,
        pr_url: "https://github.com/owner/repo/pull/42",
        pr_number: "42",
        branch_name: "feat/login",
        base_ref: "main",
        commit_sha: "abc123",
      },
      "owner/repo"
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.results[0].status === "success") {
      expect(result.results[0].prNumber).toBe(42);
    }
  });

  it("maps pr_title, base_branch, and github_id when present (v1)", () => {
    const result = parseExecutionResultFile(
      {
        has_changes: true,
        pr_url: "https://github.com/owner/repo/pull/42",
        pr_number: 42,
        pr_title: "Symphony: feature",
        branch_name: "feat/login",
        base_ref: "main",
        base_branch: "develop",
        commit_sha: "abc123",
        github_id: 999,
      },
      "owner/repo"
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.results[0].status === "success") {
      expect(result.results[0].prTitle).toBe("Symphony: feature");
      expect(result.results[0].baseBranch).toBe("develop");
      expect(result.results[0].githubId).toBe(999);
    }
  });

  it("returns failure for invalid v1 input", () => {
    expect(parseExecutionResultFile({}, "owner/repo").ok).toBe(false);
    expect(parseExecutionResultFile(null, "owner/repo").ok).toBe(false);
    expect(parseExecutionResultFile("string", "owner/repo").ok).toBe(false);
  });

  it("returns failure when fullName is absent for v1 payload", () => {
    const result = parseExecutionResultFile({
      has_changes: false,
      pr_url: "",
      pr_number: 0,
      branch_name: "",
      base_ref: "main",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("fullName is required");
    }
  });

  it("returns failure for NaN pr_number string with changes (v1 hasChanges:true missing fields)", () => {
    const result = parseExecutionResultFile(
      {
        has_changes: true,
        pr_url: "https://github.com/owner/repo/pull/42",
        pr_number: "not-a-number",
        branch_name: "feat/login",
        base_ref: "main",
        commit_sha: "abc123",
      },
      "owner/repo"
    );
    // prNumber normalizes to null → normalizeV1ExecutionResult returns failed
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0].status).toBe("failed");
    }
  });

  it("dispatches to v2 path when schemaVersion is 2", () => {
    const result = parseExecutionResultFile({
      schemaVersion: 2,
      results: [
        {
          status: "skipped",
          fullName: "owner/repo",
          reason: "no_changes",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schemaVersion).toBe(2);
      expect(result.repoCount).toBe(1);
      expect(result.results[0].status).toBe("skipped");
    }
  });

  it("returns failure for unsupported schemaVersion", () => {
    const result = parseExecutionResultFile({ schemaVersion: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.schemaVersion).toBe(3);
      expect(result.error).toContain("Unsupported schemaVersion");
    }
  });

  it("returns failure for invalid v2 envelope content", () => {
    const result = parseExecutionResultFile({
      schemaVersion: 2,
      results: "not-an-array",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.schemaVersion).toBe(2);
    }
  });
});

describe("RepoExecutionResult v2", () => {
  const validSuccessEntry = {
    status: "success" as const,
    fullName: "owner/repo",
    prUrl: "https://github.com/owner/repo/pull/42",
    prNumber: 42,
    branchName: "feat/feature-branch",
    baseBranch: "main",
    hasChanges: true,
  };

  it("parses valid success entry", () => {
    expect(RepoExecutionResultSchema.safeParse(validSuccessEntry).success).toBe(
      true
    );
  });

  it("parses valid skipped entry", () => {
    const input = {
      status: "skipped",
      fullName: "owner/repo",
      reason: "no_changes",
    };
    expect(RepoExecutionResultSchema.safeParse(input).success).toBe(true);
  });

  it("parses valid failed entry", () => {
    const input = {
      status: "failed",
      fullName: "owner/repo",
      error: "something broke",
    };
    expect(RepoExecutionResultSchema.safeParse(input).success).toBe(true);
  });

  it("rejects success entry with mismatched prUrl", () => {
    const input = {
      ...validSuccessEntry,
      prUrl: "https://github.com/owner/repo/pull/999",
    };
    expect(RepoExecutionResultSchema.safeParse(input).success).toBe(false);
  });

  it("rejects success entry with invalid branchName", () => {
    const input = { ...validSuccessEntry, branchName: "branch with spaces" };
    expect(RepoExecutionResultSchema.safeParse(input).success).toBe(false);
  });

  it("authorized-repo validation rejects unknown fullName", () => {
    const schema = createRepoExecutionResultsSchema(new Set(["allowed/repo"]));
    const input = [
      {
        ...validSuccessEntry,
        fullName: "other/repo",
        prUrl: "https://github.com/other/repo/pull/42",
      },
    ];
    expect(schema.safeParse(input).success).toBe(false);
  });

  it("authorized-repo validation accepts authorized fullName", () => {
    const schema = createRepoExecutionResultsSchema(new Set(["allowed/repo"]));
    const input = [
      {
        ...validSuccessEntry,
        fullName: "allowed/repo",
        prUrl: "https://github.com/allowed/repo/pull/42",
      },
    ];
    expect(schema.safeParse(input).success).toBe(true);
  });

  it("v2 envelope parses correctly", () => {
    const input = {
      schemaVersion: 2,
      results: [validSuccessEntry],
    };
    expect(ExecutionResultV2Schema.safeParse(input).success).toBe(true);
  });

  it("v2 envelope with empty results array yields ok:true, repoCount:0, results:[]", () => {
    const result = parseExecutionResultFile({ schemaVersion: 2, results: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repoCount).toBe(0);
      expect(result.results).toEqual([]);
    }
  });

  it("normalizeV1ExecutionResult converts hasChanges:true to success", () => {
    const executionResult = {
      hasChanges: true,
      prUrl: "https://github.com/owner/repo/pull/42",
      prNumber: 42,
      prTitle: "Add feature",
      branchName: "feat/feature-branch",
      baseRef: "main",
      baseBranch: "main",
      commitSha: "abc123",
      githubId: null,
    };
    const result = normalizeV1ExecutionResult(executionResult, "owner/repo");
    expect(result[0].status).toBe("success");
    if (result[0].status === "success") {
      expect(result[0].prTitle).toBe("Add feature");
      expect(result[0].baseBranch).toBe("main");
    }
  });

  it("normalizeV1ExecutionResult converts hasChanges:false to skipped", () => {
    const executionResult = {
      hasChanges: false,
      prUrl: null,
      prNumber: null,
      prTitle: null,
      branchName: null,
      baseRef: "main",
      baseBranch: null,
      commitSha: null,
      githubId: null,
    };
    const result = normalizeV1ExecutionResult(executionResult, "owner/repo");
    expect(result[0].status).toBe("skipped");
    if (result[0].status === "skipped") {
      expect(result[0].reason).toBe("no_changes");
    }
  });

  it("normalizeV1ExecutionResult prefers error over hasChanges:false", () => {
    const executionResult = {
      hasChanges: false,
      prUrl: null,
      prNumber: null,
      prTitle: null,
      branchName: null,
      baseRef: "main",
      baseBranch: null,
      commitSha: null,
      githubId: null,
      error: "executor crashed",
    };
    const result = normalizeV1ExecutionResult(executionResult, "owner/repo");
    expect(result[0].status).toBe("failed");
    if (result[0].status === "failed") {
      expect(result[0].error).toBe("executor crashed");
    }
  });

  it("normalizeV1ExecutionResult returns failed when hasChanges:true but PR fields missing", () => {
    const executionResult = {
      hasChanges: true,
      prUrl: null,
      prNumber: null,
      prTitle: null,
      branchName: null,
      baseRef: null,
      baseBranch: null,
      commitSha: null,
      githubId: null,
    };
    const result = normalizeV1ExecutionResult(executionResult, "owner/repo");
    expect(result[0].status).toBe("failed");
    expect(RepoExecutionResultSchema.safeParse(result[0]).success).toBe(true);
  });

  it("normalizeV1ExecutionResult returns failed when prNumber is null even with real prUrl", () => {
    const executionResult = {
      hasChanges: true,
      prUrl: "https://github.com/owner/repo/pull/42",
      prNumber: null,
      prTitle: null,
      branchName: "feat/feature-branch",
      baseRef: "main",
      baseBranch: "main",
      commitSha: null,
      githubId: null,
    };
    const result = normalizeV1ExecutionResult(executionResult, "owner/repo");
    expect(result[0].status).toBe("failed");
    expect(RepoExecutionResultSchema.safeParse(result[0]).success).toBe(true);
  });

  it("normalizeV1ExecutionResult success entries pass RepoExecutionResultSchema", () => {
    const executionResult = {
      hasChanges: true,
      prUrl: "https://github.com/owner/repo/pull/42",
      prNumber: 42,
      prTitle: "Add feature",
      branchName: "feat/feature-branch",
      baseRef: "main",
      baseBranch: "main",
      commitSha: "abc123",
      githubId: null,
    };
    const result = normalizeV1ExecutionResult(executionResult, "owner/repo");
    expect(RepoExecutionResultSchema.safeParse(result[0]).success).toBe(true);
  });

  it("getPrimaryRepoResult returns matching entry", () => {
    const entries = [
      {
        status: "skipped" as const,
        fullName: "owner/repo-a",
        reason: "no_changes",
      },
      {
        status: "skipped" as const,
        fullName: "owner/repo-b",
        reason: "no_changes",
      },
    ];
    const found = getPrimaryRepoResult(entries, "owner/repo-b");
    expect(found?.fullName).toBe("owner/repo-b");
  });

  it("getPrimaryRepoResult returns null when not found", () => {
    const entries = [
      {
        status: "skipped" as const,
        fullName: "owner/repo-a",
        reason: "no_changes",
      },
    ];
    const found = getPrimaryRepoResult(entries, "owner/nonexistent");
    expect(found).toBeNull();
  });

  it("LoopEventSchema rejects success entry with malformed prUrl in results", () => {
    const event = {
      type: "completed",
      result: {},
      tokensUsed: { input: 100, output: 50 },
      timestamp: "2024-01-01T00:00:00Z",
      results: [
        {
          status: "success",
          fullName: "owner/repo",
          prUrl: "https://github.com/owner/repo/pull/999",
          prNumber: 42,
          branchName: "feat/feature-branch",
          baseBranch: "main",
          hasChanges: true,
        },
      ],
    };
    expect(LoopEventSchema.safeParse(event).success).toBe(false);
  });

  it("LoopEventCompleted with results parses through LoopEventSchema", () => {
    const event = {
      type: "completed",
      result: {},
      tokensUsed: { input: 100, output: 50 },
      timestamp: "2024-01-01T00:00:00Z",
      results: [
        { status: "skipped", fullName: "owner/repo", reason: "no_changes" },
      ],
    };
    expect(LoopEventSchema.safeParse(event).success).toBe(true);
  });
});
