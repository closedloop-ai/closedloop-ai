/**
 * These schemas are the shared constraint for every repo-input surface (e.g.
 * document creation's `repositorySelection`), so a drift here silently makes
 * two surfaces disagree about what round-trips.
 * Error messages are hardcoded rather than imported from the module under test
 * so the assertion cannot rewrite its own oracle.
 */

import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { describe, expect, it } from "vitest";
import {
  BRANCH_NAME_ERROR,
  REPO_FULL_NAME_ERROR,
  REPO_FULL_NAME_MAX_LENGTH,
  repoBranchSchema,
  repoFullNameSchema,
} from "./repo-validator-helpers";

describe("repo input length limits", () => {
  it("caps a repository full name at 256 characters", () => {
    expect(REPO_FULL_NAME_MAX_LENGTH).toBe(256);
  });

  it("reuses the canonical branch-name limit", () => {
    expect(BRANCH_NAME_MAX_LENGTH).toBe(256);
  });
});

describe("repoFullNameSchema", () => {
  it.each([
    ["a plain owner/repo pair", "closedloop-ai/closedloop-ai"],
    ["dots, dashes and underscores", "own.er/re-po_1"],
    ["digits only", "1/2"],
    [
      "a name at the length limit",
      `${"a".repeat(REPO_FULL_NAME_MAX_LENGTH - 2)}/b`,
    ],
  ])("accepts %s", (_label, value) => {
    expect(repoFullNameSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["no slash", "ownerrepo"],
    ["two slashes", "owner/repo/extra"],
    ["an empty owner", "/repo"],
    ["an empty repo", "owner/"],
    ["a space in the owner", "own er/repo"],
    ["a trailing space", "closedloop-ai/closedloop-ai "],
    ["an empty string", ""],
    ["a scheme-prefixed URL", "https://github.com/owner/repo"],
    ["a forbidden character in a well-formed pair", "owner/re;po"],
    ["a forbidden character in the owner", "ow;ner/repo"],
  ])("rejects %s with the owner/repo format message", (_label, value) => {
    const result = repoFullNameSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) =>
          candidate.path.length === 0 && candidate.code === "invalid_format"
      );
      expect(issue?.message).toBe("Must be in 'owner/repo' format");
      expect(REPO_FULL_NAME_ERROR).toBe("Must be in 'owner/repo' format");
    }
  });

  it("rejects a name one character past the limit as too big", () => {
    const oneOverLimit = `${"a".repeat(REPO_FULL_NAME_MAX_LENGTH - 1)}/b`;
    expect(oneOverLimit).toHaveLength(REPO_FULL_NAME_MAX_LENGTH + 1);
    const result = repoFullNameSchema.safeParse(oneOverLimit);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) => candidate.code === "too_big"
      );
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual([]);
    }
  });
});

describe("repoBranchSchema", () => {
  it.each([
    ["a slashed feature branch", "feat/iss-7550"],
    ["the full permitted character set", "A_b+c.d/e-f"],
    ["a bare branch name", "main"],
    ["a branch at the length limit", "a".repeat(BRANCH_NAME_MAX_LENGTH)],
  ])("accepts %s", (_label, value) => {
    expect(repoBranchSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["a space", "bad branch"],
    ["a tilde", "bad~branch"],
    ["a caret", "bad^branch"],
    ["a colon", "bad:branch"],
    ["a question mark", "bad?branch"],
    ["an asterisk", "bad*branch"],
    ["an open bracket", "bad[branch"],
    ["a backslash", "bad\\branch"],
    ["an empty string", ""],
  ])("rejects %s with the branch-name message", (_label, value) => {
    const result = repoBranchSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) =>
          candidate.path.length === 0 && candidate.code === "invalid_format"
      );
      expect(issue?.message).toBe("Branch name contains invalid characters");
      expect(BRANCH_NAME_ERROR).toBe("Branch name contains invalid characters");
    }
  });

  it("rejects a branch one character past the limit as too big", () => {
    const result = repoBranchSchema.safeParse(
      "a".repeat(BRANCH_NAME_MAX_LENGTH + 1)
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) => candidate.code === "too_big"
      );
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual([]);
    }
  });
});
