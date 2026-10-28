/**
 * ISS-11282 — branch coverage for git-worktree.ts: an allow-list provider
 * that fails with an ordinary error, a failed remove that only wrote stdout,
 * and the stale-cleanup parent-directory resolution from repos.json when the
 * env override is unset, including its failure modes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitWorktreeRoutes } from "../src/server/operations/git-worktree.js";
import { SymphonyDirNotConfiguredError } from "../src/server/operations/symphony-utils.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
  pinDefaultWorktreeParentDir,
} from "./helpers/git-gateway-op-harness.js";

const WORKTREE_PATH = "/api/gateway/git/worktree";

const { makeTempDir } = createGitOpTempDirs("iss11282-gwt-");
pinDefaultWorktreeParentDir();

function makeDispatcher(input: {
  pm: FakeProcessManager;
  getAllowedDirectories: () => string[];
  getSymphonyDir: () => string;
}): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitWorktreeRoutes(
    dispatcher,
    input.pm.asProcessManager(),
    input.getAllowedDirectories,
    input.getSymphonyDir
  );
  return dispatcher;
}

function writeReposConfig(
  symphonyDir: string,
  settings: Record<string, unknown>
): void {
  const configDir = path.join(symphonyDir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "repos.json"),
    JSON.stringify({ repos: [], settings })
  );
}

function cleanup(dispatcher: OperationDispatcher) {
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: WORKTREE_PATH,
  });
}

describe("DELETE worktree", () => {
  test("an allow-list provider that throws an ordinary error propagates out of the dispatcher", async () => {
    const dispatcher = makeDispatcher({
      pm: new FakeProcessManager(),
      getAllowedDirectories: () => {
        throw new Error("allowed directories unavailable");
      },
      getSymphonyDir: () => makeTempDir(),
    });

    await expect(
      dispatchOperation({
        dispatcher,
        method: "DELETE",
        pathname: WORKTREE_PATH,
        body: JSON.stringify({ worktreePath: makeTempDir() }),
      })
    ).rejects.toThrow("allowed directories unavailable");
  });

  test("a failed remove with empty stderr reports its stdout", async () => {
    const worktree = makeTempDir();
    const pm = new FakeProcessManager([
      { stdout: "fatal: from stdout", stderr: "", exitCode: 128 },
    ]);
    const dispatcher = makeDispatcher({
      pm,
      getAllowedDirectories: () => [worktree],
      getSymphonyDir: () => makeTempDir(),
    });

    const response = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: WORKTREE_PATH,
      body: JSON.stringify({ worktreePath: worktree }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "Failed to remove worktree: fatal: from stdout",
    });
  });
});

describe("POST worktree stale cleanup — parent directory resolution", () => {
  test("with no env override the parent directory comes from repos.json settings", async () => {
    const symphonyDir = makeTempDir();
    const parentDir = makeTempDir();
    const prDir = path.join(parentDir, "widget-pr-7");
    mkdirSync(prDir);
    mkdirSync(path.join(parentDir, "widget-pr-8-old"));
    writeReposConfig(symphonyDir, { worktreeParentDir: parentDir });
    const pm = new FakeProcessManager([
      { stdout: "", stderr: "not a repo", exitCode: 128 },
    ]);
    const dispatcher = makeDispatcher({
      pm,
      getAllowedDirectories: () => [parentDir],
      getSymphonyDir: () => symphonyDir,
    });

    const response = await cleanup(dispatcher);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ removed: [], kept: [], errors: [prDir] });
    expect(pm.calls.map((call) => call.cwd)).toEqual([prDir]);
  });

  test("with no env override and no configured parent directory the cleanup fails with 500", async () => {
    const symphonyDir = makeTempDir();
    writeReposConfig(symphonyDir, {});
    const pm = new FakeProcessManager();
    const dispatcher = makeDispatcher({
      pm,
      getAllowedDirectories: () => [symphonyDir],
      getSymphonyDir: () => symphonyDir,
    });

    const response = await cleanup(dispatcher);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error:
        "Worktree cleanup failed: Worktree parent directory not configured",
    });
    expect(pm.calls).toHaveLength(0);
  });

  test("an unconfigured symphony dir is rethrown and answered 503 by the dispatcher", async () => {
    const dispatcher = makeDispatcher({
      pm: new FakeProcessManager(),
      getAllowedDirectories: () => [],
      getSymphonyDir: () => {
        throw new SymphonyDirNotConfiguredError();
      },
    });

    const response = await cleanup(dispatcher);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      error: "Server not configured — complete onboarding",
    });
  });

  test("a non-Error thrown during cleanup is reported as an unknown error", async () => {
    const thrown: unknown = { reason: "not an Error instance" };
    const dispatcher = makeDispatcher({
      pm: new FakeProcessManager(),
      getAllowedDirectories: () => [],
      getSymphonyDir: () => {
        throw thrown;
      },
    });

    const response = await cleanup(dispatcher);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "Worktree cleanup failed: Unknown error",
    });
  });
});

describe("POST worktree stale cleanup — candidate loop", () => {
  function setup(prDirNames: string[], allowParent = true) {
    const symphonyDir = makeTempDir();
    const parentDir = makeTempDir();
    const prDirs = prDirNames.map((name) => path.join(parentDir, name));
    for (const dir of prDirs) {
      mkdirSync(dir);
    }
    writeReposConfig(symphonyDir, { worktreeParentDir: parentDir });
    return {
      prDirs,
      getAllowedDirectories: () => (allowParent ? [parentDir] : [symphonyDir]),
      getSymphonyDir: () => symphonyDir,
    };
  }

  test("a candidate outside the allowed directories is skipped without running git", async () => {
    const { getAllowedDirectories, getSymphonyDir } = setup(
      ["widget-pr-1"],
      false
    );
    const pm = new FakeProcessManager();

    const response = await cleanup(
      makeDispatcher({ pm, getAllowedDirectories, getSymphonyDir })
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ removed: [], kept: [], errors: [] });
    expect(pm.calls).toHaveLength(0);
  });

  test("a whitespace-only ls-remote answer means the branch is gone and the worktree is removed", async () => {
    const { prDirs, getAllowedDirectories, getSymphonyDir } = setup([
      "widget-pr-2",
    ]);
    const pm = new FakeProcessManager([
      { stdout: "feature/gone\n", stderr: "", exitCode: 0 },
      { stdout: "\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const response = await cleanup(
      makeDispatcher({ pm, getAllowedDirectories, getSymphonyDir })
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ removed: prDirs, kept: [], errors: [] });
    expect(pm.calls[2]?.args).toEqual(["worktree", "remove", prDirs[0]]);
  });

  test("at most ten candidates are processed per call", async () => {
    const names = Array.from(
      { length: 11 },
      (_unused, index) => `w-pr-${index}`
    );
    const { getAllowedDirectories, getSymphonyDir } = setup(names);
    const failed = { stdout: "", stderr: "not a repo", exitCode: 128 };
    const pm = new FakeProcessManager(names.map(() => failed));

    const response = await cleanup(
      makeDispatcher({ pm, getAllowedDirectories, getSymphonyDir })
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.errors).toHaveLength(10);
    expect(pm.calls).toHaveLength(10);
  });
});
