import {
  GitHubDirtyFallbackReason,
  GitHubDirtyScopeKind,
} from "@repo/api/src/types/github-dirty-scope";
import { describe, expect, it } from "vitest";
import { refreshGitHubResyncBranches } from "../src/main/dashboard/agent-dashboard-github-resync.js";

const BRANCH_SCOPE = {
  kind: GitHubDirtyScopeKind.Branch,
  repositoryId: "repo-1",
  repositoryFullName: "closedloop-ai/closedloop-ai",
  branchName: "feat/nudge",
};

describe("refreshGitHubResyncBranches", () => {
  it("returns the parsed body and names no branch for a valid nudge", async () => {
    const result = await refreshGitHubResyncBranches({
      scopes: [BRANCH_SCOPE],
      computeTargetId: "target-1",
      unknownFromANewerCloud: true,
    });

    expect(result.branchIds).toStrictEqual([]);
    expect(result.body.scopes).toStrictEqual([BRANCH_SCOPE]);
    expect(result.body.computeTargetId).toBe("target-1");
    expect(result.body).not.toHaveProperty("unknownFromANewerCloud");
  });

  it("degrades a malformed nudge to the generic scope instead of rejecting", async () => {
    const result = await refreshGitHubResyncBranches({
      scopes: "not-an-array",
      computeTargetId: "target-1",
    });

    expect(result.branchIds).toStrictEqual([]);
    expect(result.body.scopes).toStrictEqual([
      { kind: GitHubDirtyScopeKind.Generic },
    ]);
    expect(result.body.fallbackReason).toBe(
      GitHubDirtyFallbackReason.MalformedPayload
    );
    expect(result.body.computeTargetId).toBe("target-1");
  });
});
