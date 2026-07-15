import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isValidBranchName } from "../src/main/enrichment/branch-validation.js";
import {
  defaultBranchSqlList,
  isDefaultBranchName,
} from "../src/main/enrichment/default-branch-names.js";

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
});

describe("isDefaultBranchName (FEA-2260)", () => {
  const defaults = ["main", "master", "develop", "HEAD"];
  for (const name of defaults) {
    test(`'${name}' is a default branch`, () => {
      assert.equal(isDefaultBranchName(name), true);
    });
  }

  const nonDefaults = [
    "feat/fea-2260",
    "fix/bug",
    "release/v1",
    "Main",
    "MAIN",
    "trunk",
  ];
  for (const name of nonDefaults) {
    test(`'${name}' is NOT a default branch`, () => {
      assert.equal(isDefaultBranchName(name), false);
    });
  }

  test("defaultBranchSqlList returns quoted SQL list", () => {
    const list = defaultBranchSqlList();
    assert.ok(list.includes("'main'"));
    assert.ok(list.includes("'master'"));
    assert.ok(list.includes("'develop'"));
    assert.ok(list.includes("'HEAD'"));
  });
});
