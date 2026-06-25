import { describe, expect, it } from "vitest";

import { LoopArtifactType } from "../src/artifacts";
import { LoopCommand } from "../src/commands";
import { LoopHarness, LoopRequestBodySchema } from "../src/desktop-request";

const base = {
  loopId: "loop-1",
  command: LoopCommand.Execute,
  closedLoopAuthToken: "tok",
  artifacts: [],
};

describe("LoopRequestBodySchema — additionalRepos", () => {
  it("valid entry with both localRepoPath and fullName — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [
        { localRepoPath: "/repo", fullName: "org/repo", branch: "main" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("entry with neither localRepoPath nor fullName — must fail with localRepoPath error path", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ branch: "main" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const path = result.error.issues[0].path;
      expect(path.at(-2)).toBe(0);
      expect(path.at(-1)).toBe("localRepoPath");
    }
  });

  it("entry missing branch — must fail", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ localRepoPath: "/repo" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("LoopRequestBodySchema — primaryArtifactId", () => {
  it("accepts a string value", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      primaryArtifactId: "artifact-123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts omitted field (undefined)", () => {
    const result = LoopRequestBodySchema.safeParse({ ...base });
    expect(result.success).toBe(true);
  });

  it("rejects null — z.string().optional() does not accept null", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      primaryArtifactId: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain("primaryArtifactId");
    }
  });
});

describe("LoopRequestBodySchema — implementation plan raw state", () => {
  it("accepts implementation plan artifacts with raw plan state", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      artifacts: [
        {
          id: "plan-1",
          type: LoopArtifactType.ImplementationPlan,
          title: "Plan",
          content: "Latest markdown",
          raw: {
            content: "Previous markdown",
            pendingTasks: ["task-1"],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("keeps raw plan state optional for older content-only payloads", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      artifacts: [
        {
          id: "plan-1",
          type: LoopArtifactType.ImplementationPlan,
          title: "Plan",
          content: "Latest markdown",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("LoopRequestBodySchema — FEA-585 additive fields", () => {
  it("accepts optional supportingArtifacts and codeEvaluationContext", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      command: LoopCommand.EvaluateCode,
      supportingArtifacts: [
        {
          id: "prd-1",
          type: LoopArtifactType.Prd,
          title: "Supporting PRD",
          content: "# PRD",
        },
      ],
      codeEvaluationContext: {
        schemaVersion: 1,
        repo: { fullName: "closedloop/repo", branch: "main" },
        localRepoPath: "/workspace/repo",
        parentBranchName: "feat/parent",
        parentSessionId: "019e1fbd-65eb-71ef-a7ac-59e2eba5b70d",
        artifactSlug: "fea-585",
        pullRequest: {
          number: 12,
          url: "https://github.com/closedloop/repo/pull/12",
          headBranch: "feat/context",
          baseBranch: "main",
          headSha: "abc123",
          repositoryFullName: "closedloop/repo",
        },
        detected: null,
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts null codeEvaluationContext for local normalizers", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      codeEvaluationContext: null,
    });

    expect(result.success).toBe(true);
  });
});

describe("LoopRequestBodySchema — harness field", () => {
  it('accepts "claude" as a valid harness value', () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      harness: LoopHarness.Claude,
    });
    expect(result.success).toBe(true);
  });

  it('accepts "codex" as a valid harness value', () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      harness: LoopHarness.Codex,
    });
    expect(result.success).toBe(true);
  });

  it('accepts "cursor" as a valid harness value', () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      harness: LoopHarness.Cursor,
    });
    expect(result.success).toBe(true);
  });

  it('accepts "opencode" as a valid harness value', () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      harness: LoopHarness.OpenCode,
    });
    expect(result.success).toBe(true);
  });

  it("defaults unknown harness values to claude", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      harness: "gemini",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.harness).toBe(LoopHarness.Claude);
    }
  });

  it("treats harness as optional (undefined is valid)", () => {
    const result = LoopRequestBodySchema.safeParse({ ...base });
    expect(result.success).toBe(true);
  });
});
