import { describe, expect, it } from "vitest";
import { LoopEventSchema } from "../src/events";
import {
  createRepoExecutionResultsSchema,
  ExecutionResultV2Schema,
  getPrimaryRepoResult,
  normalizeV1ExecutionResult,
  normalizeV2ExecutionResult,
  parseExecutionResultFile,
  RepoExecutionResultSchema,
  RepoExecutionResultsSchema,
} from "../src/execution-result";

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

  it("rejects success entry with invalid baseBranch", () => {
    const input = {
      ...validSuccessEntry,
      baseBranch: "base branch with spaces",
    };
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

  it("pre-built RepoExecutionResultsSchema accepts any fullName", () => {
    expect(
      RepoExecutionResultsSchema.safeParse([validSuccessEntry]).success
    ).toBe(true);
  });

  it("v2 envelope parses correctly", () => {
    const input = {
      schemaVersion: 2,
      results: [validSuccessEntry],
    };
    expect(ExecutionResultV2Schema.safeParse(input).success).toBe(true);
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

  it("normalizeV1ExecutionResult coerces string prNumber to number", () => {
    const parsed = parseExecutionResultFile({
      has_changes: true,
      pr_url: "https://github.com/org/repo/pull/7",
      pr_number: "7",
      branch_name: "feat/login",
      base_ref: "main",
      commit_sha: "abc123",
    });
    if (!parsed) {
      throw new Error("parseExecutionResultFile returned null unexpectedly");
    }
    const result = normalizeV1ExecutionResult(parsed, "org/repo");
    if (result[0].status === "success") {
      expect(result[0].prNumber).toBe(7);
    }
  });

  it("normalizeV2ExecutionResult returns envelope results by reference", () => {
    const envelope = {
      schemaVersion: 2 as const,
      results: [validSuccessEntry],
    };
    const result = normalizeV2ExecutionResult(envelope);
    expect(result).toBe(envelope.results);
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
