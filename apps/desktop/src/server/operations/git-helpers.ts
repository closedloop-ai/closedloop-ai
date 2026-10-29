import { execFile, execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { isTccProtectedPath } from "../../shared/sandbox-policy.js";
import { execFileNonBlocking } from "../non-blocking-exec.js";
import {
  getResolvedGitPath,
  getResolvedGitPathAsync,
} from "./binary-path-overrides.js";

/**
 * Resolve the git remote full name (org/repo) from a local repo path.
 * Returns null if the remote origin URL cannot be parsed.
 *
 * Synchronous on purpose, and only for the db-host session import
 * (`resolveSessionAttribution` from `buildImportSessionContext`), which runs
 * inside `importSessionWithTx`'s caller-supplied transaction. Main-process
 * callers use {@link resolveRepoFullNameAsync} (ISS-11414).
 *
 * ISS-11914: never spawns `git` in a TCC-protected folder, where it would read
 * `.git/config` and raise a macOS permission prompt.
 */
export function resolveRepoFullName(repoPath: string): string | null {
  if (isTccProtectedPath(repoPath)) {
    return null;
  }
  // Resolved outside the try (ISS-10194): these catches return `null`/`[]`, so
  // an absorbed strict-override refusal would read as "this path has no
  // origin" — a plausible negative, not a failure.
  const gitPath = getResolvedGitPath();
  try {
    const remoteUrl = execFileSync(gitPath, ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    }).trim();

    const sshMatch = ORIGIN_REMOTE_FULL_NAME_PATTERN.exec(remoteUrl);
    if (sshMatch) {
      return sshMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Async variant for UI-sensitive paths. It preserves `resolveRepoFullName`
 * parsing and failure semantics while avoiding a blocking git subprocess on the
 * Electron main thread.
 */
export async function resolveRepoFullNameAsync(
  repoPath: string
): Promise<string | null> {
  return (await resolveRepoFullNameOutcomeAsync(repoPath)).repoFullName;
}

/** Find existing worktree for a branch name. Returns null when not checked out. */
export async function findWorktreeForBranch(
  expandedRepoPath: string,
  branchName: string
): Promise<string | null> {
  const gitPath = await getResolvedGitPathAsync();
  try {
    const output = await execFileNonBlocking(
      gitPath,
      ["worktree", "list", "--porcelain"],
      {
        cwd: expandedRepoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    );

    let currentWorktree: string | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentWorktree = line.slice("worktree ".length);
      }
      if (line.startsWith("branch ") && line.endsWith(`/${branchName}`)) {
        return currentWorktree;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function execFileText(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}

/** `org/repo` extracted from an SSH or HTTPS `origin` remote URL. */
const ORIGIN_REMOTE_FULL_NAME_PATTERN = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/;

/**
 * ISS-5272 (C2): why a `git remote get-url origin` produced no `org/repo`.
 *
 * `NoOrigin` means git RAN and answered — a clean stdout that carried no
 * parseable remote, or a non-zero EXIT code (no such remote, not a repository).
 * `SpawnFailed` means git never answered: the binary could not be spawned
 * (ENOENT), the process table/descriptors were exhausted (EAGAIN/EMFILE), or the
 * 10s timeout killed it. Only `NoOrigin` is a fact about the path and therefore
 * safe to memoize; caching a `SpawnFailed` would suppress live resolution of
 * that path for every caller until the negative TTL expired.
 */
export const RepoFullNameStatus = {
  Resolved: "resolved",
  NoOrigin: "no_origin",
  SpawnFailed: "spawn_failed",
} as const;
export type RepoFullNameStatus =
  (typeof RepoFullNameStatus)[keyof typeof RepoFullNameStatus];

export type RepoFullNameOutcome =
  | { status: typeof RepoFullNameStatus.Resolved; repoFullName: string }
  | { status: typeof RepoFullNameStatus.NoOrigin; repoFullName: null }
  | { status: typeof RepoFullNameStatus.SpawnFailed; repoFullName: null };

/**
 * ISS-5272: the classifying variant of {@link resolveRepoFullNameAsync}. Same
 * command, same parsing — it only reports WHY a null happened so a caller that
 * memoizes can tell a durable "this path has no origin" from a transient
 * process failure.
 *
 * It does NOT never-throw. That clause stopped being true when the git
 * resolution moved out of the try (ISS-10194): under the desktop test lane's
 * strict var an unusable EXPLICIT override rejects here instead of degrading to
 * the host git, and `resolveAttributionRepoFullName` passes that rejection
 * straight through to its caller. A packaged build never sets the var, so in
 * production this still only ever returns.
 */
export async function resolveRepoFullNameOutcomeAsync(
  repoPath: string
): Promise<RepoFullNameOutcome> {
  // A path that is not there has no origin, and that is a fact about the path,
  // not a process failure — without this probe a deleted worktree (the FEA-3555
  // population) would surface as a bare `spawn ENOENT`, indistinguishable from a
  // missing git binary, and so could never be memoized.
  if (!(await pathExists(repoPath))) {
    return { status: RepoFullNameStatus.NoOrigin, repoFullName: null };
  }
  // The ASYNC resolver: the sync one bottoms out in `getShellPathSync`, which on
  // a cold cache runs `execFileSync($SHELL, "-ilc", …)` twice at 5s each, and
  // this function's only caller is `attribution-path-memo`, which runs off the
  // main thread. Same override semantics and the same ISS-10194 refusal.
  const gitPath = await getResolvedGitPathAsync();
  let stdout: string;
  try {
    stdout = await execFileText(gitPath, ["remote", "get-url", "origin"], {
      cwd: repoPath,
      timeout: 10_000,
    });
  } catch (error) {
    return classifyExecFileFailure(error);
  }
  const sshMatch = ORIGIN_REMOTE_FULL_NAME_PATTERN.exec(stdout.trim());
  if (sshMatch) {
    return {
      status: RepoFullNameStatus.Resolved,
      repoFullName: sshMatch[1],
    };
  }
  return { status: RepoFullNameStatus.NoOrigin, repoFullName: null };
}

/**
 * Split a rejected `execFile` into "git answered non-zero" vs "git never ran".
 * Node reports a spawn-level failure with a STRING `code` (ENOENT, EAGAIN,
 * EMFILE) and a timeout kill with `killed`/`signal`; a plain non-zero exit
 * carries a NUMERIC `code`, which for `git remote get-url origin` means "no such
 * remote" (2) or "not a git repository" (128) — a real answer about this path.
 * Anything unrecognized falls back to `SpawnFailed`, the fail-safe side: an
 * un-memoized path only costs a re-resolution.
 */
function classifyExecFileFailure(error: unknown): RepoFullNameOutcome {
  const failed = {
    status: RepoFullNameStatus.SpawnFailed,
    repoFullName: null,
  } as const;
  if (typeof error !== "object" || error === null) {
    return failed;
  }
  if ("killed" in error && error.killed === true) {
    return failed;
  }
  if (
    "signal" in error &&
    error.signal !== null &&
    error.signal !== undefined
  ) {
    return failed;
  }
  if ("code" in error && typeof error.code === "number") {
    return { status: RepoFullNameStatus.NoOrigin, repoFullName: null };
  }
  return failed;
}

/** Does `target` exist? Async so the db-host hydration walk never blocks. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
