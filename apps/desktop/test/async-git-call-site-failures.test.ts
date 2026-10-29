/**
 * ISS-11414: success and failure answers for converted git call sites that no
 * other suite pins. Each case drives the public entry point (a gateway route or
 * an exported helper) through a fake git, so the exact git exit decides the
 * branch taken, and asserts what the caller receives.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import { registerGitBranchWorktreeRoutes } from "../src/server/operations/git-branch-worktree.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  pinDefaultWorktreeParentDir,
} from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("async-git-site-failures-");

pinDefaultWorktreeParentDir();

afterEach(() => {
  configureBinaryPathsResolver(() => ({}));
});

type FakeGit = { calls: () => string[] };

/**
 * A git that logs its argv and answers from `body`, a POSIX sh `case "$1"`
 * body; anything the body does not match exits 1.
 */
function installFakeGit(root: string, body: string): FakeGit {
  const logPath = path.join(root, "git-calls.log");
  const gitPath = path.join(root, "bin", "git");
  mkdirSync(path.dirname(gitPath), { recursive: true });
  writeFileSync(
    gitPath,
    `#!/bin/sh\necho "$*" >> '${logPath}'\ncase "$1" in\n${body}\n  *) exit 1 ;;\nesac\n`
  );
  chmodSync(gitPath, 0o755);
  writeFileSync(logPath, "");
  configureBinaryPathsResolver(() => ({ git: gitPath }));
  return {
    calls: () =>
      readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((line) => line.length > 0),
  };
}

describe("GET /api/gateway/git/branch-worktree", () => {
  test("answers no worktree when the configured repo's origin cannot be read", async () => {
    const root = makeTempDir();
    const repoDir = path.join(root, "repo");
    mkdirSync(repoDir);
    const symphonyDir = path.join(root, ".symphony");
    mkdirSync(path.join(symphonyDir, "config"), { recursive: true });
    writeFileSync(
      path.join(symphonyDir, "config", "repos.json"),
      JSON.stringify({
        repos: [{ path: repoDir, addedAt: new Date(0).toISOString() }],
        settings: {},
      })
    );
    const git = installFakeGit(root, "");
    const dispatcher = new OperationDispatcher();
    registerGitBranchWorktreeRoutes(dispatcher, () => symphonyDir);

    const response = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/git/branch-worktree",
      query: { repoFullName: "acme/widgets", headBranch: "feature-x" },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { path: null, repoPath: null });
    assert.deepEqual(git.calls(), ["remote get-url origin"]);
  });
});
