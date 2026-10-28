import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { isValidBranchName } from "../src/main/enrichment/branch-validation.js";

describe("isValidBranchName", () => {
  describe("valid branch names", () => {
    const valid = [
      "main",
      "develop",
      "feat/fea-2177",
      "fix/bar-123",
      "release/v1.0.0",
      "pr-1234",
      "pr-1234-review",
      "abc",
      "fix",
      "a1b2c3d",
    ];
    for (const name of valid) {
      test(`accepts '${name}'`, () => {
        assert.equal(isValidBranchName(name), true);
      });
    }
  });

  describe("git internal refs", () => {
    const internals = [
      "FETCH_HEAD",
      "HEAD",
      "ORIG_HEAD",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REBASE_HEAD",
    ];
    for (const name of internals) {
      test(`rejects '${name}'`, () => {
        assert.equal(isValidBranchName(name), false);
      });
    }
  });

  describe("remote tracking refs", () => {
    const remotes = ["origin/main", "origin/feat/foo", "origin/HEAD"];
    for (const name of remotes) {
      test(`rejects '${name}'`, () => {
        assert.equal(isValidBranchName(name), false);
      });
    }
  });

  describe("git ref paths", () => {
    const refs = ["refs/pr/123", "refs/heads/main", "refs/remotes/origin/main"];
    for (const name of refs) {
      test(`rejects '${name}'`, () => {
        assert.equal(isValidBranchName(name), false);
      });
    }
  });

  describe("ISS-8751: git check-ref-format slash rules", () => {
    // A ref can neither begin nor end with `/`, nor hold consecutive slashes.
    // Only the trailing case was covered, so an absolute path passed as a branch
    // name and `git worktree add --detach /tmp/x` minted `branch::/tmp/x`.
    const invalid = [
      "/tmp/nrev-emergent-emma-1-93305",
      "/main",
      "feat//double-slash",
      "//leading-double",
    ];
    for (const name of invalid) {
      test(`rejects '${name}'`, () => {
        assert.equal(isValidBranchName(name), false);
      });
    }

    test("still accepts an ordinary single-slash branch", () => {
      assert.equal(isValidBranchName("feat/iss-8751"), true);
    });
  });

  describe("bare SHA hashes (>=8 hex chars)", () => {
    const shas = [
      "a1b2c3d4e5f6a7b8",
      "deadbeef",
      "0123456789abcdef0123456789abcdef01234567",
      "abcdef01",
    ];
    for (const name of shas) {
      test(`rejects '${name}'`, () => {
        assert.equal(isValidBranchName(name), false);
      });
    }
  });

  describe("short strings that look like hex but are valid branches", () => {
    const shortHex = ["abc", "abc1234", "dead", "cafe"];
    for (const name of shortHex) {
      test(`accepts '${name}' (< 8 chars)`, () => {
        assert.equal(isValidBranchName(name), true);
      });
    }
  });

  describe("FEA-2531 hardening: shell/quoting debris and git-invalid names", () => {
    // The first three are literal phantom branches minted from real desktop
    // data before the quote-aware extractor fix; validation is the backstop.
    const debris = [
      "feat/x'",
      "feat/x','git",
      "feat/x:',",
      'feat/x"',
      "feat/`x`",
      "feat/x,y",
      "a b",
      "feat/(x)",
      "feat/x;rm",
      "feat/x|y",
      "feat/$x",
      "x..y",
      "x@{1}",
      "-flag",
      ".hidden",
      "x.lock",
      "x.",
      "x/",
      "",
    ];
    for (const name of debris) {
      test(`rejects '${name}'`, () => {
        assert.equal(isValidBranchName(name), false);
      });
    }

    const stillValid = [
      "feat/fea-2531",
      "release/v1.0.0",
      "user.name/branch_2",
      "hotfix-2024.01",
      "feat/UPPER-Case",
    ];
    for (const name of stillValid) {
      test(`still accepts '${name}'`, () => {
        assert.equal(isValidBranchName(name), true);
      });
    }
  });

  describe("ISS-8529: branch name length bound", () => {
    test("rejects a 400-character branch name", () => {
      assert.equal(isValidBranchName(`feat/${"z".repeat(400)}`), false);
    });

    test("accepts a 250-character branch name", () => {
      assert.equal(isValidBranchName(`feat/${"z".repeat(245)}`), true);
    });

    test("rejects a name at exactly the bound + 1", () => {
      assert.equal(isValidBranchName("a".repeat(257)), false);
    });

    test("accepts a name at exactly the bound", () => {
      assert.equal(isValidBranchName("a".repeat(256)), true);
    });
  });
});
