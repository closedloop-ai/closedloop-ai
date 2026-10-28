/**
 * Unit coverage for the git child-process failure classifiers (ISS-8639).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  isProcessTimeout,
  isPushAuthFailure,
} from "../src/server/operations/git-process-failure.js";

describe("isProcessTimeout / isPushAuthFailure", () => {
  test("isProcessTimeout is false for a plain Error and true for the ETIMEDOUT shape", () => {
    assert.equal(isProcessTimeout(new Error("boom")), false);
    assert.equal(isProcessTimeout({ code: "ETIMEDOUT" }), true);
  });

  test("isPushAuthFailure matches the auth signatures and nothing else", () => {
    assert.equal(isPushAuthFailure("fatal: Authentication failed"), true);
    assert.equal(isPushAuthFailure("Permission denied (publickey)"), true);
    assert.equal(isPushAuthFailure("fatal: early EOF"), false);
  });
});
