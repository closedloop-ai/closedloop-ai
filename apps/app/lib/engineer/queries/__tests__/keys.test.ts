import { describe, expect, test } from "vitest";
import { queryKeys } from "../keys";

describe("queryKeys.branchWorktree (U4 routing identity)", () => {
  const repo = "acme/repo";
  const branch = "feat/x";
  const pr = 42;

  test("returns a 5-element key including the routing identity", () => {
    const key = queryKeys.branchWorktree(repo, branch, pr, "CloudRelay:none");
    expect(key).toEqual([
      "branch-worktree",
      repo,
      branch,
      pr,
      "CloudRelay:none",
    ]);
  });

  test("differs by routing mode when computeTargetId is absent", () => {
    const cloudRelay = queryKeys.branchWorktree(
      repo,
      branch,
      pr,
      "CloudRelay:none"
    );
    const localElectron = queryKeys.branchWorktree(
      repo,
      branch,
      pr,
      "LocalElectron:none"
    );
    expect(cloudRelay).not.toEqual(localElectron);
  });

  test("differs by computeTargetId within the same routing mode", () => {
    const none = queryKeys.branchWorktree(repo, branch, pr, "CloudRelay:none");
    const target = queryKeys.branchWorktree(
      repo,
      branch,
      pr,
      "CloudRelay:target-123"
    );
    expect(none).not.toEqual(target);
  });

  test("keys with matching routing identities are deeply equal", () => {
    const a = queryKeys.branchWorktree(repo, branch, pr, "CloudRelay:ct-1");
    const b = queryKeys.branchWorktree(repo, branch, pr, "CloudRelay:ct-1");
    expect(a).toEqual(b);
  });
});
