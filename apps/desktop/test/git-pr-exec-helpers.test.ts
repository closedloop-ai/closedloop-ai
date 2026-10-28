import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { asString } from "../src/server/operations/git-pr-exec.js";

/**
 * `git-pr-exec.ts` is the shared plumbing behind the PR gateway routes.
 * `runRead`, `run`, `withPathEnv` and `getRepoSlug` are covered by route tests
 * that resolve the operator's login shell and spawn real `git`.
 */

describe("asString", () => {
  test("accepts a non-blank string verbatim", () => {
    assert.equal(asString("value"), "value");
    assert.equal(asString("  padded  "), "  padded  ");
  });

  test("rejects blank, empty and non-string values", () => {
    for (const value of ["", "   ", 5, null, undefined, {}]) {
      assert.equal(asString(value), null, `expected null for ${String(value)}`);
    }
  });
});
