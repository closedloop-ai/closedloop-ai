import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { resolveOperationId } from "../src/main/approval-operations.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitBranchWorktreeRoutes } from "../src/server/operations/git-branch-worktree.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "git-branch-worktree-test-")
  );
  tempDirs.push(dir);
  // Resolve symlinks (macOS /var → /private/var) so paths match git's own
  // canonicalised paths returned from `git worktree list`.
  return fs.realpath(dir);
}

function gitInit(repoPath: string, remoteUrl: string): void {
  execSync("git init -q -b main", { cwd: repoPath, stdio: "pipe" });
  execSync("git config user.email test@example.com", {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync("git config user.name Test", { cwd: repoPath, stdio: "pipe" });
  execSync("git config commit.gpgsign false", { cwd: repoPath, stdio: "pipe" });
  execSync(`git remote add origin ${remoteUrl}`, {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync("git commit -q --allow-empty -m initial", {
    cwd: repoPath,
    stdio: "pipe",
  });
}

async function writeReposConfig(
  symphonyDir: string,
  repoPaths: string[]
): Promise<void> {
  const configDir = path.join(symphonyDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({
      repos: repoPaths.map((p) => ({
        path: p,
        addedAt: "2024-01-01T00:00:00Z",
      })),
      settings: {},
    }),
    "utf-8"
  );
}

async function dispatchBranchWorktree(
  symphonyDir: string,
  query: Record<string, string>
): Promise<{
  statusCode: number;
  body: { path: string | null; repoPath: string | null };
}> {
  const dispatcher = new OperationDispatcher();
  registerGitBranchWorktreeRoutes(dispatcher, () => symphonyDir);

  let responseBody = "";
  let statusCode = 0;
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    setHeader() {},
    end(body?: string) {
      responseBody = body ?? "";
    },
  } as unknown as ServerResponse;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    params.set(k, v);
  }

  const handled = await dispatcher.dispatch({
    method: "GET",
    pathname: "/api/gateway/git/branch-worktree",
    params: {},
    query: params,
    rawBody: Buffer.alloc(0),
    body: "",
    request: {} as IncomingMessage,
    response,
  });

  assert.equal(handled, true);

  return {
    statusCode,
    body: JSON.parse(responseBody) as {
      path: string | null;
      repoPath: string | null;
    },
  };
}

describe("registerGitBranchWorktreeRoutes GET /api/gateway/git/branch-worktree", () => {
  test("returns worktree path when repo matched and branch checked out", async () => {
    const root = await makeTempDir();
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath);
    gitInit(repoPath, "git@github.com:acme/widget.git");

    const worktreePath = path.join(root, "widget-feature");
    execSync(`git worktree add -q -B feature ${worktreePath}`, {
      cwd: repoPath,
      stdio: "pipe",
    });

    const symphonyDir = path.join(root, ".closedloop-ai");
    await writeReposConfig(symphonyDir, [repoPath]);

    const response = await dispatchBranchWorktree(symphonyDir, {
      repoFullName: "acme/widget",
      headBranch: "feature",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.path, worktreePath);
    assert.equal(response.body.repoPath, repoPath);
  });

  test("returns null path when repo matched but branch not checked out", async () => {
    const root = await makeTempDir();
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath);
    gitInit(repoPath, "git@github.com:acme/widget.git");

    const symphonyDir = path.join(root, ".closedloop-ai");
    await writeReposConfig(symphonyDir, [repoPath]);

    const expectedWorktreeDir = path.join(root, "widget-missing");

    const response = await dispatchBranchWorktree(symphonyDir, {
      repoFullName: "acme/widget",
      headBranch: "missing",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.path, null);
    assert.equal(response.body.repoPath, repoPath);
    assert.equal(
      existsSync(expectedWorktreeDir),
      false,
      "no worktree directory should be provisioned"
    );
  });

  test("returns null repoPath when no configured repo matches the full name", async () => {
    const root = await makeTempDir();
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath);
    gitInit(repoPath, "git@github.com:acme/widget.git");

    const symphonyDir = path.join(root, ".closedloop-ai");
    await writeReposConfig(symphonyDir, [repoPath]);

    const response = await dispatchBranchWorktree(symphonyDir, {
      repoFullName: "other/repo",
      headBranch: "main",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.path, null);
    assert.equal(response.body.repoPath, null);
  });

  test("resolveOperationId maps the gateway path to git_branch_worktree", () => {
    assert.equal(
      resolveOperationId("/api/gateway/git/branch-worktree"),
      "git_branch_worktree"
    );
  });
});
