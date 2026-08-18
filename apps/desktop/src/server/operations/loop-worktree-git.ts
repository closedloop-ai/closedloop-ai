/**
 * Non-blocking git primitives for the loop worktree lifecycle (ISS-6132).
 *
 * The desktop gateway's HTTP server is constructed inside the Electron **main
 * process** (`apps/desktop/src/main/app.ts` → `DesktopGatewayServer`), so every
 * gateway operation handler executes on the main thread. A synchronous child
 * process there (`execSync`/`execFileSync`/`spawnSync`) holds the event loop for
 * the child's entire lifetime, which freezes every window, all IPC, the menu and
 * the tray — not "slows", freezes.
 *
 * The worktree checkout the loop performs before launching a command was the
 * worst offender on that path: a synchronous `git fetch origin` (a network round
 * trip, capped at 30s) immediately followed by a synchronous `git worktree add`
 * (a full checkout of the target repository). The invariant that matters is not
 * a particular duration — it is that under `execSync` the event-loop stall
 * EQUALS the child's whole wall-clock lifetime, whereas under `execFile` it is a
 * few milliseconds regardless of how long the child runs. `git fetch` waiting on
 * a credential prompt therefore froze the app indefinitely, up to the timeout.
 *
 * These helpers therefore mirror the already-async `runGitForMaterialization`
 * pattern in `symphony-loop.ts` and are argv-based rather than shell-string
 * based, which also removes the shell from the invocation entirely.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Network-bound git calls (fetch). Matches the previous `execSync` timeout. */
export const LOOP_GIT_NETWORK_TIMEOUT_MS = 30_000;
/** Local ref resolution (rev-parse). Matches the previous `execSync` timeout. */
export const LOOP_GIT_LOCAL_TIMEOUT_MS = 10_000;
/** Worktree creation. Matches the previous `execSync` timeout. */
export const LOOP_GIT_WORKTREE_ADD_TIMEOUT_MS = 30_000;
/** Worktree removal. Matches the previous `execSync` timeout. */
export const LOOP_GIT_WORKTREE_REMOVE_TIMEOUT_MS = 15_000;
/** Worktree prune fallback. Matches the previous `execSync` timeout. */
export const LOOP_GIT_WORKTREE_PRUNE_TIMEOUT_MS = 10_000;

export type RunGitResult =
  | { ok: true; stdout: string }
  | { ok: false; error: unknown };

/**
 * Reject a ref that git would parse as an option rather than a commit-ish.
 *
 * Dropping the shell closes shell-metacharacter injection but not ARGUMENT
 * injection: `execFile` still hands git a literal string, and a positional ref
 * beginning with `-` (`--force`, `-D`, `--lock`) is read by git's option parser.
 * `body.repo.branch` and `additionalRepos[].branch` reach here as unconstrained
 * strings, and even the materialization regex admits an all-hyphen name. Mirrors
 * `validateRef` in `main/enrichment/git-exec.ts` and the branch guard in
 * `operations/git-action.ts`.
 */
function isOptionLikeRef(ref: string): boolean {
  return ref.startsWith("-");
}

/**
 * Serializes the mutating worktree lifecycle per worktree directory.
 *
 * The `execSync` implementation this module replaces held the Electron main
 * thread for the child's whole lifetime, which incidentally made the worktree
 * lifecycle mutually exclusive: no second gateway request could even be
 * dequeued while one was running. Going async removes that accidental lock, and
 * `runningLoops` in `symphony-loop.ts` does not replace it — that map is keyed
 * by `loopId`, while `worktreeDir` is keyed by `artifactSlug`, so PLAN and a
 * retried EXECUTE for the SAME slug are different loopIds targeting the SAME
 * directory. Without this queue they can interleave between the `existsSync`
 * probe and `git worktree add` (TOCTOU), or remove a directory another request
 * is still checking out.
 */
const worktreeLocks = new Map<string, Promise<void>>();
const repoRefLocks = new Map<string, Promise<void>>();

/** Run `operation` with exclusive access to `worktreeDir`. */
export async function withWorktreeLock<T>(
  worktreeDir: string,
  operation: () => Promise<T>
): Promise<T> {
  return await withKeyedLock(
    worktreeLocks,
    path.resolve(worktreeDir),
    operation
  );
}

/** Run `operation` with exclusive access to repository refs for `repoPath`. */
export async function withRepoRefLock<T>(
  repoPath: string,
  operation: () => Promise<T>
): Promise<T> {
  return await withKeyedLock(repoRefLocks, path.resolve(repoPath), operation);
}

/**
 * Number of worktree directories with a queued or in-flight operation.
 *
 * Observability seam for the bounded-growth requirement on this map: a leak is
 * otherwise invisible until the process is long-lived enough to matter.
 */
export function activeWorktreeLockCount(): number {
  return worktreeLocks.size;
}

/** Number of repositories with queued or in-flight ref operations. */
export function activeRepoRefLockCount(): number {
  return repoRefLocks.size;
}

export type CreateWorktreeCheckoutOptions = {
  gitBin: string;
  repoPath: string;
  worktreeDir: string;
  branchName: string;
  baseBranch: string;
};

export type RemoveWorktreeOptions = {
  gitBin: string;
  worktreeDir: string;
  repoPath: string;
  /** Invoked when `git worktree remove` fails and the fs.rm fallback is taken. */
  onRemoveFailed?: () => void;
};

export type ReplaceWorktreeCheckoutOptions = CreateWorktreeCheckoutOptions & {
  /** Invoked before an existing worktree is removed. */
  onStaleWorktree?: () => void;
  /** Invoked when `git worktree remove` needs the fs.rm fallback. */
  onRemoveFailed?: () => void;
  /** Work that must finish before another replacement can remove this tree. */
  afterCreate?: () => Promise<void>;
};

/**
 * Run a git command off the main thread, never throwing.
 *
 * Callers decide whether a failure is fatal, which keeps each call site's
 * previous `try`/`catch` semantics explicit rather than implied.
 */
export async function runGit(
  gitBin: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<RunGitResult> {
  try {
    const { stdout } = await execFileAsync(gitBin, [...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Create a worktree checkout at `worktreeDir`, resolving the base ref the same
 * way the previous synchronous implementation did.
 *
 * Returns `false` when the worktree directory already exists (nothing created).
 * Throws the underlying git error when `git worktree add` fails — the fetch and
 * the ref probe stay best-effort, exactly as before.
 */
export async function createWorktreeCheckout(
  options: CreateWorktreeCheckoutOptions
): Promise<boolean> {
  assertValidCheckoutRefs(options);

  return await withWorktreeLock(options.worktreeDir, async () =>
    createWorktreeCheckoutUnlocked(options)
  );
}

/**
 * Replace a stale worktree and finish its initial use under one directory lock.
 */
export async function replaceWorktreeCheckout(
  options: ReplaceWorktreeCheckoutOptions
): Promise<boolean> {
  assertValidCheckoutRefs(options);
  const {
    worktreeDir,
    onStaleWorktree,
    onRemoveFailed,
    afterCreate,
    ...checkoutOptions
  } = options;

  return await withWorktreeLock(worktreeDir, async () => {
    if (existsSync(worktreeDir)) {
      onStaleWorktree?.();
      await removeWorktreeUnlocked({
        gitBin: checkoutOptions.gitBin,
        repoPath: checkoutOptions.repoPath,
        worktreeDir,
        onRemoveFailed,
      });
    }

    const created = await createWorktreeCheckoutUnlocked({
      ...checkoutOptions,
      worktreeDir,
    });
    if (created) {
      await afterCreate?.();
    }
    return created;
  });
}

/**
 * Remove a worktree via `git worktree remove`, falling back to `fs.rm` plus
 * `git worktree prune` when git refuses.
 */
export async function removeWorktree(
  options: RemoveWorktreeOptions
): Promise<void> {
  // Same queue as the checkout: a removal must not land midway through a
  // concurrent `git worktree add` for the same directory.
  await withWorktreeLock(options.worktreeDir, async () =>
    removeWorktreeUnlocked(options)
  );
}

/**
 * Fetch latest refs from origin. No-op when offline.
 *
 * The async counterpart of `fetchOrigin` in `symphony-utils.ts`, for callers
 * already inside an async function. The synchronous one blocks the Electron
 * main thread for the whole network round trip.
 */
async function fetchOriginAsync(
  gitBin: string,
  repoPath: string
): Promise<void> {
  await runGit(
    gitBin,
    ["fetch", "origin"],
    repoPath,
    LOOP_GIT_NETWORK_TIMEOUT_MS
  );
}

/**
 * Resolve a branch name to a valid git ref, trying remote then local.
 * Returns the resolved ref string, or `null` if neither exists.
 *
 * The async counterpart of `resolveRef` in `symphony-utils.ts`.
 */
async function resolveRefAsync(
  gitBin: string,
  repoPath: string,
  branchName: string
): Promise<string | null> {
  // Unresolvable rather than thrown: this helper's contract is never-throw, and
  // its caller (`branchExistsImpl`) turns a null into the existing
  // "branch not found in additional repo" validation error.
  if (isOptionLikeRef(branchName)) {
    return null;
  }
  for (const candidate of [`origin/${branchName}`, branchName]) {
    const probe = await runGit(
      gitBin,
      ["rev-parse", "--verify", candidate],
      repoPath,
      LOOP_GIT_LOCAL_TIMEOUT_MS
    );
    if (probe.ok) {
      return candidate;
    }
  }
  return null;
}

/** Fetch and resolve a branch while excluding ref mutation in the same repo. */
export async function branchExistsAsync(
  gitBin: string,
  repoPath: string,
  branchName: string
): Promise<boolean> {
  if (isOptionLikeRef(branchName)) {
    return false;
  }
  return await withRepoRefLock(repoPath, async () => {
    await fetchOriginAsync(gitBin, repoPath);
    return (await resolveRefAsync(gitBin, repoPath, branchName)) !== null;
  });
}

async function createWorktreeCheckoutUnlocked(
  options: CreateWorktreeCheckoutOptions
): Promise<boolean> {
  const { gitBin, repoPath, worktreeDir, branchName, baseBranch } = options;
  if (existsSync(worktreeDir)) {
    return false;
  }

  await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

  const baseRef = await withRepoRefLock(repoPath, async () => {
    await fetchOriginAsync(gitBin, repoPath);
    const remoteRef = `origin/${baseBranch}`;
    const remoteProbe = await runGit(
      gitBin,
      ["rev-parse", "--verify", remoteRef],
      repoPath,
      LOOP_GIT_LOCAL_TIMEOUT_MS
    );
    return remoteProbe.ok ? remoteRef : baseBranch;
  });

  const added = await runGit(
    gitBin,
    ["worktree", "add", "-B", branchName, worktreeDir, baseRef],
    repoPath,
    LOOP_GIT_WORKTREE_ADD_TIMEOUT_MS
  );
  if (!added.ok) {
    throw added.error;
  }
  return true;
}

async function removeWorktreeUnlocked(
  options: RemoveWorktreeOptions
): Promise<void> {
  const { gitBin, worktreeDir, repoPath, onRemoveFailed } = options;
  const removed = await runGit(
    gitBin,
    ["worktree", "remove", "--force", worktreeDir],
    repoPath,
    LOOP_GIT_WORKTREE_REMOVE_TIMEOUT_MS
  );
  if (removed.ok) {
    return;
  }

  onRemoveFailed?.();
  await fs.rm(worktreeDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await runGit(
    gitBin,
    ["worktree", "prune"],
    repoPath,
    LOOP_GIT_WORKTREE_PRUNE_TIMEOUT_MS
  );
}

function assertValidCheckoutRefs(options: CreateWorktreeCheckoutOptions): void {
  for (const ref of [options.branchName, options.baseBranch]) {
    if (isOptionLikeRef(ref)) {
      throw new Error(`Ref starts with dash (arg-injection risk): ${ref}`);
    }
  }
}

async function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const predecessor = locks.get(key) ?? Promise.resolve();
  const result = predecessor.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  locks.set(key, settled);
  try {
    return await result;
  } finally {
    if (locks.get(key) === settled) {
      locks.delete(key);
    }
  }
}
