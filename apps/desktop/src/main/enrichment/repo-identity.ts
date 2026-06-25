import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { Repo } from "../database/generated/client.js";
import type { DesktopPrisma } from "../database/prisma-client.js";

const execFileAsync = promisify(execFile);

import {
  getAbsoluteGitCommonDir,
  getAbsoluteGitDir,
  getDefaultBranch,
  getRemoteUrl,
  isInsideWorkTree,
  listRemotes,
  normalizeRepoFullName,
} from "./git-exec.js";

export type RepoRow = {
  id: string;
  git_dir: string;
  remote_url: string | null;
  repo_full_name: string | null;
  default_branch: string | null;
  last_seen_at: string;
  created_at: string;
};

export type IdentityCaptureResult = {
  repoId: string | null;
  gitDir: string | null;
  repoFullName: string | null;
  isWorktree: boolean;
};

/** Map the Prisma-generated `Repo` model row to the snake_case `RepoRow`. */
function toRepoRow(row: Repo): RepoRow {
  return {
    id: row.id,
    git_dir: row.gitDir,
    remote_url: row.remoteUrl,
    repo_full_name: row.repoFullName,
    default_branch: row.defaultBranch,
    last_seen_at: row.lastSeenAt,
    created_at: row.createdAt,
  };
}

export async function captureRepoIdentity(
  gitPath: string,
  cwd: string,
  prisma: DesktopPrisma,
  now: string
): Promise<IdentityCaptureResult> {
  const empty: IdentityCaptureResult = {
    repoId: null,
    gitDir: null,
    repoFullName: null,
    isWorktree: false,
  };

  const isGit = await isInsideWorkTree(gitPath, cwd);
  if (!isGit) {
    return empty;
  }

  const gitDir = await getAbsoluteGitDir(gitPath, cwd);
  const commonDir = await getAbsoluteGitCommonDir(gitPath, cwd);
  if (!(gitDir && commonDir)) {
    return empty;
  }

  const primaryGitDir = commonDir;
  const isWorktree = gitDir !== commonDir;

  let remoteUrl: string | null = null;
  let repoFullName: string | null = null;

  remoteUrl = await getRemoteUrl(gitPath, cwd);
  if (!remoteUrl) {
    const remotes = await listRemotes(gitPath, cwd);
    const upstream = remotes.find((r) => r.name === "upstream");
    const any = remotes[0];
    remoteUrl = upstream?.url ?? any?.url ?? null;
  }
  if (remoteUrl) {
    repoFullName = normalizeRepoFullName(remoteUrl);
  }

  let defaultBranch: string | null = null;
  try {
    defaultBranch = await getDefaultBranch(gitPath, cwd);
  } catch {
    // non-critical
  }

  const repoId = await upsertRepo(
    prisma,
    primaryGitDir,
    remoteUrl,
    repoFullName,
    defaultBranch,
    now
  );

  if (isWorktree) {
    let branchName: string | null = null;
    try {
      const { stdout } = await execFileAsync(
        gitPath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, env: { ...process.env, LC_ALL: "C" }, timeout: 5000 }
      );
      branchName = stdout.trim() || null;
    } catch {
      // non-critical
    }
    await upsertWorktree(prisma, repoId, cwd, branchName, now);
  }

  return { repoId, gitDir: primaryGitDir, repoFullName, isWorktree };
}

async function upsertRepo(
  prisma: DesktopPrisma,
  gitDir: string,
  remoteUrl: string | null,
  repoFullName: string | null,
  defaultBranch: string | null,
  now: string
): Promise<string> {
  // RAW (named blocker: COALESCE-preserve upsert + `RETURNING`): the DO UPDATE
  // sets each metadata column only when currently null (`COALESCE(existing,
  // excluded)`), and the statement RETURNs the row id (the new uuid on insert,
  // or the EXISTING row's id on conflict) — neither expressible via Prisma
  // `upsert`. `$queryRawUnsafe` (not `$executeRawUnsafe`) so RETURNING yields the
  // row; runs on the one client via `write`.
  const rows = await prisma.write((client) =>
    client.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO repos (id, git_dir, remote_url, repo_full_name, default_branch, last_seen_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT(git_dir) DO UPDATE SET
         remote_url = COALESCE(repos.remote_url, EXCLUDED.remote_url),
         repo_full_name = COALESCE(repos.repo_full_name, EXCLUDED.repo_full_name),
         default_branch = COALESCE(EXCLUDED.default_branch, repos.default_branch),
         last_seen_at = EXCLUDED.last_seen_at
       RETURNING id`,
      randomUUID(),
      gitDir,
      remoteUrl,
      repoFullName,
      defaultBranch,
      now
    )
  );
  return rows[0]!.id;
}

async function upsertWorktree(
  prisma: DesktopPrisma,
  repoId: string,
  worktreePath: string,
  branchName: string | null,
  now: string
): Promise<void> {
  // RAW (named blocker: COALESCE-preserve upsert): branch_name is set only when
  // currently null (`COALESCE(EXCLUDED.branch_name, repo_worktrees.branch_name)`)
  // — no typed `upsert` update form. Runs on the one client via `write`.
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO repo_worktrees (id, repo_id, worktree_path, branch_name, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(worktree_path) DO UPDATE SET
         repo_id = EXCLUDED.repo_id,
         branch_name = COALESCE(EXCLUDED.branch_name, repo_worktrees.branch_name),
         last_seen_at = EXCLUDED.last_seen_at`,
      randomUUID(),
      repoId,
      worktreePath,
      branchName,
      now
    )
  );
}

export async function resolveRepoForCwd(
  prisma: DesktopPrisma,
  cwd: string
): Promise<RepoRow | null> {
  const wt = await prisma.client.repoWorktree.findFirst({
    where: { worktreePath: cwd },
    select: { repoId: true },
  });
  if (wt) {
    const repo = await prisma.client.repo.findUnique({
      where: { id: wt.repoId },
    });
    return repo ? toRepoRow(repo) : null;
  }

  const parts = cwd.split("/");
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join("/");
    const gitDirCandidate = `${candidate}/.git`;
    const repo = await prisma.client.repo.findFirst({
      where: { gitDir: gitDirCandidate },
    });
    if (repo) {
      return toRepoRow(repo);
    }
  }

  return null;
}

export async function resolveRepoByFullName(
  prisma: DesktopPrisma,
  repoFullName: string
): Promise<RepoRow | null> {
  const repo = await prisma.client.repo.findFirst({
    where: { repoFullName: repoFullName.toLowerCase() },
  });
  return repo ? toRepoRow(repo) : null;
}

export async function cwdExists(cwd: string): Promise<boolean> {
  try {
    await access(cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `path` is already a registered repo or worktree (matched against
 * `repos.git_dir` / its working-tree root, or `repo_worktrees.worktree_path`).
 * Backfill path heuristics gate on this so a crafted/stale session cwd cannot
 * make Desktop run git against an unrelated local repo it has never tracked.
 */
export async function isKnownRepoPath(
  prisma: DesktopPrisma,
  path: string
): Promise<boolean> {
  // Typed existence check: the prior `UNION ALL … LIMIT 1` across two tables
  // becomes two point `count`s (both columns are unique/indexed). The repos arm
  // matches the path as either the git_dir itself or its working-tree root
  // (`${path}/.git`); the worktrees arm matches the registered worktree_path.
  const repoCount = await prisma.client.repo.count({
    where: { gitDir: { in: [path, `${path}/.git`] } },
  });
  if (repoCount > 0) {
    return true;
  }
  const worktreeCount = await prisma.client.repoWorktree.count({
    where: { worktreePath: path },
  });
  return worktreeCount > 0;
}
