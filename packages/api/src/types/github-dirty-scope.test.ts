import { describe, expect, test } from "vitest";
import {
  GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO,
  GitHubDirtyFallbackReason,
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
  parseGitHubResyncNudgeBody,
} from "./github-dirty-scope";

describe("parseGitHubResyncNudgeBody", () => {
  test("keeps known scopes and omits absent optional fields", () => {
    const parsed = parseGitHubResyncNudgeBody({
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/symphony-alpha",
          branchName: "feat/nudge",
        },
      ],
      triggers: [GitHubDirtyTrigger.Push],
      pullRequestNumber: undefined,
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.body).toEqual({
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/symphony-alpha",
          branchName: "feat/nudge",
        },
      ],
      triggers: [GitHubDirtyTrigger.Push],
    });
    expect(JSON.stringify(parsed.body)).not.toContain("null");
  });

  test("maps malformed payloads to a generic refresh", () => {
    const parsed = parseGitHubResyncNudgeBody({
      scopes: [{ kind: "future_scope", branchName: "main" }],
      computeTargetId: "target-1",
      gatewayId: "gateway-1",
    });

    expect(parsed).toEqual({
      ok: false,
      reason: GitHubDirtyFallbackReason.MalformedPayload,
      body: {
        scopes: [{ kind: GitHubDirtyScopeKind.Generic }],
        fallbackReason: GitHubDirtyFallbackReason.MalformedPayload,
        computeTargetId: "target-1",
        gatewayId: "gateway-1",
      },
    });
  });

  test("maps oversized scope arrays to scope overflow", () => {
    const scopes = Array.from(
      { length: GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO + 1 },
      () => ({ kind: GitHubDirtyScopeKind.Repository })
    );
    const parsed = parseGitHubResyncNudgeBody({ scopes });

    expect(parsed).toEqual({
      ok: false,
      reason: GitHubDirtyFallbackReason.ScopeOverflow,
      body: {
        scopes: [{ kind: GitHubDirtyScopeKind.Generic }],
        fallbackReason: GitHubDirtyFallbackReason.ScopeOverflow,
      },
    });
  });
});
