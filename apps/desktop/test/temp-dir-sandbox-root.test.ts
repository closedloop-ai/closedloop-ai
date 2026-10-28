// ISS-10655: the two constraints `makeSandboxRootTempDir` has to satisfy at
// once. Either alone is easy and wrong — a fixture under `os.tmpdir()`
// realpaths into `/private` on macOS and can never be persisted as a sandbox
// base, and a fixture under `os.homedir()` clears the policy but is stranded in
// the operator's real home when the lane's 900s whole-runner cap SIGTERMs the
// run before the manager's `afterEach` (the ISS-6128 rule). One case per
// constraint, so a regression names which half broke.

import assert from "node:assert/strict";
import os from "node:os";
import { describe, test } from "vitest";
import {
  isPathAtOrUnder,
  validateSandboxBaseDirectory,
} from "../src/shared/sandbox-policy.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const { makeSandboxRootTempDir } = createTempDirManager("temp-dir-helper-");

describe("makeSandboxRootTempDir", () => {
  test("mints nothing inside the operator's home directory", () => {
    const dir = makeSandboxRootTempDir("outside-home-");

    assert.equal(isPathAtOrUnder(dir, os.homedir()), false);
  });

  test("mints a root the sandbox policy persists unchanged", () => {
    const dir = makeSandboxRootTempDir("accepted-root-");

    assert.equal(validateSandboxBaseDirectory(dir), dir);
  });
});
