import { describe, expect, it } from "vitest";

import { LoopArtifactType } from "../src/artifacts";
import { LoopCommand } from "../src/commands";
import { ContextPackSchema } from "../src/context-pack";

const base = {
  command: LoopCommand.EvaluateCode,
  artifacts: [],
};

describe("ContextPackSchema — FEA-585 context fields", () => {
  it("accepts supporting artifacts and code evaluation context", () => {
    const result = ContextPackSchema.safeParse({
      ...base,
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
        detected: {
          branch: "feat/context",
          headSha: "abc123",
          gitDetectionError: null,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("keeps older primary-only context packs valid", () => {
    const result = ContextPackSchema.safeParse({
      command: LoopCommand.EvaluatePrd,
      artifacts: [
        {
          id: "prd-1",
          type: LoopArtifactType.Prd,
          title: "Primary PRD",
          content: "# PRD",
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("does not admit credential fields inside code evaluation context", () => {
    const result = ContextPackSchema.safeParse({
      ...base,
      codeEvaluationContext: {
        schemaVersion: 1,
        repo: {
          fullName: "closedloop/repo",
          branch: "main",
          githubToken: "repo-token",
        },
        pullRequest: {
          number: 12,
          url: "https://github.com/closedloop/repo/pull/12",
          accessToken: "pr-token",
        },
        detected: {
          branch: "main",
          headSha: "abc123",
          secret: "detected-secret",
        },
        token: "top-level-token",
        password: "top-level-password",
        secret: "top-level-secret",
      },
    });

    if (!result.success) {
      throw new Error("Expected context pack to parse successfully");
    }
    expect(JSON.stringify(result.data.codeEvaluationContext)).not.toContain(
      "token"
    );
    expect(JSON.stringify(result.data.codeEvaluationContext)).not.toContain(
      "secret"
    );
    expect(JSON.stringify(result.data.codeEvaluationContext)).not.toContain(
      "password"
    );
  });
});
