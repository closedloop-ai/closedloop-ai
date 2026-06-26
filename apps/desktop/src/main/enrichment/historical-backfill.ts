import type { DesktopPrisma } from "../database/prisma-client.js";
import { writePersistentLog } from "../persistent-log.js";
import { isInsideWorkTree } from "./git-exec.js";
import {
  captureRepoIdentity,
  cwdExists,
  type IdentityCaptureResult,
  isKnownRepoPath,
  resolveRepoByFullName,
  resolveRepoForCwd,
} from "./repo-identity.js";

type BackfillCandidate = {
  sessionId: string;
  cwd: string | null;
  harness: string | null;
  metadata: string | null;
  startedAt: string;
};

const REPO_FULL_NAME_PATTERNS = [
  /prRepository["']?\s*:\s*["']([^"']+\/[^"']+)["']/,
  /--repo\s+(\S+\/\S+)/,
  /origin\s+(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s.]+)/,
  /fatal:.*'https:\/\/github\.com\/([^/]+\/[^/'.]+)/,
  /repoFullName["']?\s*:\s*["']([^"']+\/[^"']+)["']/,
  /github\.com\/([^/\s]+\/[^/\s]+?)(?:\/(?:pull|issues|actions|commit)|\.git|\s|$)/,
];

const GIT_SUFFIX_RE = /\.git$/;
const WORKTREE_SUFFIX_RE = /^(.+)-(?:fea|feat|fix|bug|feature|hotfix)-\d+$/;
const DASH_SUFFIX_RE = /^(.+)-[^/]+$/;

export async function runHistoricalBackfill(
  gitPath: string,
  prisma: DesktopPrisma,
  batchSize: number,
  now: string
): Promise<number> {
  // RAW (named blocker: cross-table anti-join on a COMPUTED value): the two
  // `NOT EXISTS` arms exclude sessions whose cwd already maps to a worktree
  // (`repo_worktrees.worktree_path = s.cwd`) or a repo (`repos.git_dir = s.cwd ||
  // '/.git'`). `sessions` has no relation to either table, and the second arm
  // joins on a string-concatenated key — neither expressible via Prisma, and
  // pulling all three tables to anti-join in JS would be a real regression. Stays
  // a single server-side query, now on the one client via `$queryRawUnsafe`.
  const candidates = await prisma.client.$queryRawUnsafe<BackfillCandidate[]>(
    `SELECT s.id AS session_id, s.cwd, s.harness, s.metadata, s.started_at
     FROM sessions s
     WHERE s.cwd IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM repo_worktrees rw
         WHERE rw.worktree_path = s.cwd
       )
       AND NOT EXISTS (
         SELECT 1 FROM repos r2
         WHERE r2.git_dir = s.cwd || '/.git'
       )
     ORDER BY s.started_at DESC
     LIMIT $1`,
    batchSize
  );

  let resolved = 0;
  for (const c of candidates) {
    const result = await resolveSessionRepo(gitPath, prisma, c, now);
    if (result) {
      resolved++;
    }
  }
  return resolved;
}

async function resolveSessionRepo(
  gitPath: string,
  prisma: DesktopPrisma,
  candidate: BackfillCandidate,
  now: string
): Promise<IdentityCaptureResult | null> {
  const { cwd, metadata } = candidate;
  if (!cwd) {
    return null;
  }

  if (await cwdExists(cwd)) {
    try {
      return await captureRepoIdentity(gitPath, cwd, prisma, now);
    } catch {
      // path exists but git ops failed
    }
  }

  const minedFullName = mineRepoFullName(metadata);
  if (minedFullName) {
    const repo = await resolveRepoByFullName(prisma, minedFullName);
    if (repo) {
      return {
        repoId: repo.id,
        gitDir: repo.git_dir,
        repoFullName: repo.repo_full_name,
        isWorktree: false,
      };
    }
  }

  const ancestorRepo = await walkAncestors(gitPath, prisma, cwd, now);
  if (ancestorRepo) {
    return ancestorRepo;
  }

  const siblingRepo = await trySiblingHeuristic(gitPath, prisma, cwd, now);
  if (siblingRepo) {
    return siblingRepo;
  }

  return null;
}

function mineRepoFullName(metadata: string | null): string | null {
  if (!metadata) {
    return null;
  }
  for (const pattern of REPO_FULL_NAME_PATTERNS) {
    const m = pattern.exec(metadata);
    if (m?.[1]) {
      return m[1].replace(GIT_SUFFIX_RE, "").toLowerCase();
    }
  }
  return null;
}

async function walkAncestors(
  gitPath: string,
  prisma: DesktopPrisma,
  cwd: string,
  now: string
): Promise<IdentityCaptureResult | null> {
  const parts = cwd.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const ancestor = parts.slice(0, i).join("/");
    if (!(await cwdExists(ancestor))) {
      continue;
    }

    const existingRepo = await resolveRepoForCwd(prisma, ancestor);
    if (existingRepo) {
      return {
        repoId: existingRepo.id,
        gitDir: existingRepo.git_dir,
        repoFullName: existingRepo.repo_full_name,
        isWorktree: false,
      };
    }

    // Only run git against ancestors Desktop already tracks. A crafted/stale
    // session cwd must not let us probe (and register) an unrelated local repo.
    if (!(await isKnownRepoPath(prisma, ancestor))) {
      continue;
    }

    let isGit: boolean;
    try {
      isGit = await isInsideWorkTree(gitPath, ancestor);
    } catch (error) {
      // isKnownRepoPath already confirmed this ancestor is a repo Desktop
      // tracks, so a git failure here is unexpected. Surface it and stop the
      // walk rather than silently falling through to a parent ancestor, which
      // could be a different repo and yield an incorrect identity association.
      writePersistentLog(
        "warn",
        "backfill",
        `walkAncestors: isInsideWorkTree failed for known repo ${ancestor}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
    if (isGit) {
      return captureRepoIdentity(gitPath, ancestor, prisma, now);
    }
  }
  return null;
}

async function trySiblingHeuristic(
  gitPath: string,
  prisma: DesktopPrisma,
  cwd: string,
  now: string
): Promise<IdentityCaptureResult | null> {
  const suffixMatch = WORKTREE_SUFFIX_RE.exec(cwd);
  const dashMatch = suffixMatch ?? DASH_SUFFIX_RE.exec(cwd);
  if (!dashMatch) {
    return null;
  }

  const basePath = dashMatch[1]!;
  if (!(await cwdExists(basePath))) {
    return null;
  }

  // Only run git against a sibling Desktop already tracks. A crafted/stale
  // session cwd must not let us probe (and register) an unrelated local repo.
  if (!(await isKnownRepoPath(prisma, basePath))) {
    return null;
  }

  let isGit: boolean;
  try {
    isGit = await isInsideWorkTree(gitPath, basePath);
  } catch (error) {
    // isKnownRepoPath already confirmed this sibling is a repo Desktop tracks,
    // so a git failure here is unexpected rather than a "not a git repo"
    // signal. Surface it instead of silently swallowing it.
    writePersistentLog(
      "warn",
      "backfill",
      `trySiblingHeuristic: isInsideWorkTree failed for known repo ${basePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  if (isGit) {
    return captureRepoIdentity(gitPath, basePath, prisma, now);
  }
  return null;
}
