import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import { captureRepoIdentity } from "../../src/main/enrichment/repo-identity.js";
import { hermeticGitEnv } from "../hermetic-git-env.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORIES = ["acme-web", "agent-toolkit"] as const;
const WORK_BRANCH = "feature/workspace";

/**
 * Register profile-owned Acme repositories through Desktop's real identity
 * capture. Git ignores host config through the shared fixture environment;
 * ordinary empty fixture commits preserve normal hooks and let older Git
 * versions create named linked worktrees. Nothing fetches or pushes, and
 * interrupted fixture setup is repaired before its rows are counted.
 */
export async function seedRepositories(
  db: SqliteAgentDatabase,
  profileDir: string,
  now: Date
): Promise<{ repositories: number; worktrees: number }> {
  const capturedRepositories = new Set<string>();
  const capturedWorktrees = new Set<string>();
  for (const name of REPOSITORIES) {
    const root = path.join(profileDir, "repositories", name);
    const worktree = path.join(profileDir, "worktrees", name);
    const fullName = `acme-co/${name}`;
    await prepareRepository(root, name, fullName);
    await prepareWorktree(root, worktree, name);
    for (const cwd of [root, worktree]) {
      const result = await captureRepoIdentity(
        "git",
        cwd,
        db.prisma,
        now.toISOString()
      );
      if (
        result.repoId === null ||
        result.repoFullName !== fullName ||
        result.gitDir !== (await realpath(path.join(root, ".git")))
      ) {
        throw new Error(
          `could not capture expected identity for seeded repository ${name}`
        );
      }
      const row = await db.prisma.client.repo.findUniqueOrThrow({
        where: { id: result.repoId },
      });
      if (row.repoFullName !== fullName || row.defaultBranch !== "main") {
        throw new Error(
          `seeded repository ${name} has incomplete stored identity`
        );
      }
      capturedRepositories.add(result.repoId);
      if (cwd === worktree) {
        const row = await db.prisma.client.repoWorktree.findUniqueOrThrow({
          where: { worktreePath: cwd },
        });
        if (row.repoId !== result.repoId || row.branchName !== WORK_BRANCH) {
          throw new Error(
            `seeded worktree ${name} has incomplete stored identity`
          );
        }
        capturedWorktrees.add(row.id);
      }
    }
  }
  return {
    repositories: capturedRepositories.size,
    worktrees: capturedWorktrees.size,
  };
}

/** Share fixture isolation across initialization and interrupted-run repair. */
function git(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    timeout: 5000,
    env: hermeticGitEnv(),
  });
}

/** Ensure the fixture owns its default branch and canonical Acme remote. */
async function prepareRepository(
  root: string,
  name: string,
  fullName: string
): Promise<void> {
  await mkdir(root, { recursive: true });
  if (!existsSync(path.join(root, ".git"))) {
    await git(root, ["init", "--initial-branch=main"]);
  }
  const branch = await git(root, ["symbolic-ref", "--short", "HEAD"]);
  if (branch.stdout.trim() !== "main") {
    throw new Error(
      `seeded repository ${name} must have its main branch checked out`
    );
  }
  const remotes = await git(root, ["remote"]);
  await git(root, [
    "remote",
    remotes.stdout.split("\n").includes("origin") ? "set-url" : "add",
    "origin",
    `https://github.com/${fullName}.git`,
  ]);
  await git(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  // A previous prepare may have stopped after init or left an unborn branch.
  const hasMain = await git(root, [
    "rev-parse",
    "--verify",
    "refs/heads/main",
  ]).then(
    () => true,
    () => false
  );
  if (!hasMain) {
    await git(root, [
      "-c",
      "user.name=Acme Co",
      "-c",
      "user.email=workspace@acme-co.example",
      "commit",
      "--allow-empty",
      "-m",
      "Initialize Acme workspace",
    ]);
  }
}

/** Recover only a linked fixture whose repository and branch were verified. */
async function prepareWorktree(
  root: string,
  worktree: string,
  name: string
): Promise<void> {
  if (existsSync(path.join(worktree, ".git"))) {
    const common = await git(worktree, ["rev-parse", "--git-common-dir"]);
    const workBranch = await git(worktree, ["symbolic-ref", "--short", "HEAD"]);
    if (
      (await realpath(path.resolve(worktree, common.stdout.trim()))) !==
        (await realpath(path.join(root, ".git"))) ||
      workBranch.stdout.trim() !== WORK_BRANCH
    ) {
      throw new Error(
        `seeded worktree ${name} does not belong to its expected repository and branch`
      );
    }
    const hasHead = await git(worktree, ["rev-parse", "--verify", "HEAD"]).then(
      () => true,
      () => false
    );
    if (!hasHead) {
      await git(worktree, ["reset", "--hard", "main"]);
    }
  } else {
    await git(root, ["worktree", "add", "-b", WORK_BRANCH, worktree, "main"]);
  }
}
