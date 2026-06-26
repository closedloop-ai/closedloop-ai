import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  resolveRepoFullName,
  resolveRepoFullNameAsync,
} from "../src/server/operations/git-helpers.js";
import { configureBinaryPathsResolver } from "../src/server/operations/symphony-loop.js";

/**
 * Regression tests for the PR #107 review: user-configurable git path must be
 * safe against paths containing spaces (legitimate, e.g. /Applications/.../git)
 * and against shell metacharacters (malicious, e.g. `/tmp/git;touch pwn`).
 *
 * These would both fail under `execSync(\`${gitPath} …\`)` interpolation.
 */
describe("git-helpers: git path override shell safety", () => {
  const tempPathsToClean: string[] = [];

  afterEach(() => {
    configureBinaryPathsResolver(() => ({}));
    for (const p of tempPathsToClean) {
      rmSync(p, { recursive: true, force: true });
    }
    tempPathsToClean.length = 0;
  });

  test("resolveRepoFullName honors a git binary path containing spaces", () => {
    // A directory name with a space must survive the full spawn pipeline.
    // Shell-string interpolation would split on the space and fail with ENOENT.
    const tmpRoot = path.join(os.tmpdir(), `cl git space ${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    tempPathsToClean.push(tmpRoot);

    const gitPath = path.join(tmpRoot, "git");
    writeFileSync(
      gitPath,
      '#!/bin/sh\necho "git@github.com:acme/widgets.git"\n',
      { mode: 0o755 }
    );
    const repoDir = path.join(tmpRoot, "repo");
    mkdirSync(repoDir);

    configureBinaryPathsResolver(() => ({ git: gitPath }));

    const result = resolveRepoFullName(repoDir);
    assert.equal(result, "acme/widgets");
  });

  test("resolveRepoFullNameAsync honors a git binary path containing spaces", async () => {
    const tmpRoot = path.join(os.tmpdir(), `cl git async ${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    tempPathsToClean.push(tmpRoot);

    const gitPath = path.join(tmpRoot, "git");
    writeFileSync(
      gitPath,
      '#!/bin/sh\necho "git@github.com:acme/widgets.git"\n',
      { mode: 0o755 }
    );
    const repoDir = path.join(tmpRoot, "repo");
    mkdirSync(repoDir);

    configureBinaryPathsResolver(() => ({ git: gitPath }));

    const result = await resolveRepoFullNameAsync(repoDir);
    assert.equal(result, "acme/widgets");
  });

  test("shell metacharacters in the git override cannot inject commands", () => {
    const tmpRoot = path.join(os.tmpdir(), `cl-git-inject-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    tempPathsToClean.push(tmpRoot);

    // Set up a real fake-git so the first segment of the injected string
    // actually runs (worst-case: the bug's reach is maximal).
    writeFileSync(
      path.join(tmpRoot, "git"),
      '#!/bin/sh\necho "passthrough"\n',
      { mode: 0o755 }
    );
    const repoDir = path.join(tmpRoot, "repo");
    mkdirSync(repoDir);

    const canary = path.join(tmpRoot, "pwn-canary");
    const injectedPath = `${path.join(tmpRoot, "git")};touch ${canary}`;
    configureBinaryPathsResolver(() => ({ git: injectedPath }));

    // Don't care about return value -- the point is the canary must not appear.
    try {
      resolveRepoFullName(repoDir);
    } catch {
      // ignore
    }

    assert.equal(
      existsSync(canary),
      false,
      "canary file exists -- shell injection via git binary path succeeded"
    );
  });

  test("shell metacharacters in the async git override cannot inject commands", async () => {
    const tmpRoot = path.join(os.tmpdir(), `cl-git-async-inject-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    tempPathsToClean.push(tmpRoot);

    writeFileSync(
      path.join(tmpRoot, "git"),
      '#!/bin/sh\necho "passthrough"\n',
      { mode: 0o755 }
    );
    const repoDir = path.join(tmpRoot, "repo");
    mkdirSync(repoDir);

    const canary = path.join(tmpRoot, "pwn-canary");
    const injectedPath = `${path.join(tmpRoot, "git")};touch ${canary}`;
    configureBinaryPathsResolver(() => ({ git: injectedPath }));

    await resolveRepoFullNameAsync(repoDir);

    assert.equal(
      existsSync(canary),
      false,
      "canary file exists -- shell injection via async git binary path succeeded"
    );
  });
});
