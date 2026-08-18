/**
 * @file audit-workspace.ts
 * @description PRD-556 — disposable-checkout isolation for an audit run, shared
 * by every surface that drives {@link runAuditPass} (the desktop `AuditService`
 * and the `crewd` CLI's review orchestrator).
 *
 * SECURITY: the crewd harness cascade spawns each engine with its dangerous
 * bypass flags (`codex … --dangerously-bypass-approvals-and-sandbox`,
 * `claude --dangerously-skip-permissions`), so the "read-only" character prompt
 * is NOT an enforcement boundary — a prompt-injected or misbehaving audit could
 * modify the checked-out repo or run commands without approval. To keep an audit
 * run genuinely read-only against the operator's real checkout, we never point
 * the cascade at `repoDir` directly. Instead we materialize a throwaway copy of
 * the repo in a temp directory, run the audit there, and remove it afterward.
 * Any write the harness performs lands in the disposable copy and is discarded.
 *
 * A git repo is copied with `git worktree add --detach` (cheap — it hardlinks
 * the object store and only checks out the tree); a non-git directory falls back
 * to a recursive filesystem copy. Both leave the operator's working tree
 * untouched. Node-only (`node:child_process`/`node:fs`) — must not reach a
 * renderer graph.
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A prepared disposable audit checkout plus its teardown. */
export type AuditWorkspace = {
  /** Absolute path the cascade should treat as the repo (a throwaway copy). */
  dir: string;
  /** True when the copy is a linked git worktree (vs. a plain fs copy). */
  isGitWorktree: boolean;
  /** Remove the disposable copy. Best-effort; never throws. */
  dispose: () => Promise<void>;
};

/** Extra env handed to the child git process (e.g. the resolved login PATH). */
export type AuditWorkspaceEnv = Record<string, string> | undefined;

/**
 * Materialize a disposable read-through copy of `repoDir` so a harness spawned
 * with bypass flags can only ever mutate the throwaway copy, never the
 * operator's checkout. Prefers a detached git worktree; falls back to a
 * recursive filesystem copy for a non-git directory.
 */
export async function prepareAuditWorkspace(
  repoDir: string,
  env: AuditWorkspaceEnv
): Promise<AuditWorkspace> {
  const base = mkdtempSync(path.join(tmpdir(), "crewd-audit-workspace-"));
  const dir = path.join(base, "repo");

  if (await isGitRepo(repoDir, env)) {
    try {
      // Detached worktree at the current HEAD: hardlinks the object store and
      // checks out the tree into `dir`. Writes in `dir` never touch the source
      // working tree; `dispose` prunes the worktree registration too.
      await runGit(repoDir, ["worktree", "add", "--detach", dir, "HEAD"], env);
      return {
        dir,
        isGitWorktree: true,
        dispose: () => disposeGitWorktree(repoDir, dir, base, env),
      };
    } catch {
      // A worktree can fail (detached HEAD already checked out elsewhere, a
      // bare repo, a git version quirk). Fall through to a plain copy so the
      // isolation guarantee still holds.
    }
  }

  copyDirectory(repoDir, dir);
  return {
    dir,
    isGitWorktree: false,
    dispose: () => disposePlainCopy(base),
  };
}

async function isGitRepo(
  repoDir: string,
  env: AuditWorkspaceEnv
): Promise<boolean> {
  try {
    const out = await runGit(
      repoDir,
      ["rev-parse", "--is-inside-work-tree"],
      env
    );
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function copyDirectory(from: string, to: string): void {
  // Preserve symlinks as-is rather than dereferencing them into real files.
  // NOTE: a symlink in the source that points OUTSIDE the repo is copied
  // verbatim, so a harness that writes *through* it could still reach the link
  // target. That residual only affects the non-git fallback (a git worktree
  // checks out tracked blobs, not arbitrary symlinks); the operator's own
  // checkout — the boundary this isolation protects — is never the write
  // target either way. Tightening the fallback to drop escaping symlinks is a
  // follow-up if non-git audit targets become common.
  cpSync(from, to, {
    recursive: true,
    dereference: false,
    // Never abort the whole copy on one unreadable entry.
    force: true,
    errorOnExist: false,
  });
}

async function disposeGitWorktree(
  repoDir: string,
  worktreeDir: string,
  base: string,
  env: AuditWorkspaceEnv
): Promise<void> {
  try {
    await runGit(repoDir, ["worktree", "remove", "--force", worktreeDir], env);
  } catch {
    // If git can't remove it (already gone, lock), fall back to rm + prune so
    // no disposable copy or stale registration leaks.
    removeTree(worktreeDir);
    await runGit(repoDir, ["worktree", "prune"], env).catch(() => {
      // Best-effort prune; a stale registration must never fail an audit run.
    });
  }
  removeTree(base);
}

function disposePlainCopy(base: string): Promise<void> {
  removeTree(base);
  return Promise.resolve();
}

function removeTree(target: string): void {
  if (!existsSync(target)) {
    return;
  }
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover temp dir must never fail an audit run.
  }
}

function runGit(
  cwd: string,
  args: string[],
  env: AuditWorkspaceEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`)
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}
