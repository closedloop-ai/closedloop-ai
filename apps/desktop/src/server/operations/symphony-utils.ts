import { execFile, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { gatewayLog } from "../../main/gateway-logger.js";
import { expandHomePath } from "../../shared/path-utils.js";
import {
  type ClaudeCodeShellEnvProvider,
  getClaudeCodeShellEnv,
} from "../otel/claude-code-env.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { getShellEnv } from "../shell-path.js";
import { isPluginInstalled } from "./plugin-cache.js";
import { getResolvedClaudePath, getResolvedGitPath } from "./symphony-loop.js";

const execFileAsync = promisify(execFile);
const BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;
const BOOTSTRAP_OUTPUT_TAIL_BYTES = 4096;

export type BootstrapRunResult =
  | { status: "skipped-artifacts" }
  | { status: "skipped-plugin-missing" }
  | { status: "completed" }
  | {
      status: "failed";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdoutTail: string;
      stderrTail: string;
    }
  | {
      status: "timed-out";
      timeoutMs: number;
      stdoutTail: string;
      stderrTail: string;
    };

/** Timeout for local-only git commands (rev-parse, checkout, diff, worktree list/prune). */
const LOCAL_GIT_TIMEOUT = 10_000;

/** Timeout for network-touching git commands (fetch, pull, rebase) and worktree add. */
const NETWORK_GIT_TIMEOUT = 30_000;

/** Timeout for git clone operations (may download large repositories). */
export const CLONE_GIT_TIMEOUT = 300_000;

// ---------------------------------------------------------------------------
// Logging helpers (shared with symphony-loop.ts)
// ---------------------------------------------------------------------------

export function loopLog(loopId: string, ...args: unknown[]): void {
  const short = loopId.slice(0, 8);
  gatewayLog.info("symphony-loop", `[${short}] ${formatLoopLogArgs(args)}`);
}

export function loopError(loopId: string, ...args: unknown[]): void {
  const short = loopId.slice(0, 8);
  gatewayLog.error("symphony-loop", `[${short}] ${formatLoopLogArgs(args)}`);
}

function formatLoopLogArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : inspect(arg, { depth: 4, breakLength: 120 })
    )
    .join(" ");
}

export class SymphonyDirNotConfiguredError extends Error {
  constructor() {
    super("Symphony directory not configured — complete onboarding");
    this.name = "SymphonyDirNotConfiguredError";
  }
}

export function computeSymphonyDir(sandboxBaseDirectory: string): string {
  return path.join(sandboxBaseDirectory, ".closedloop-ai");
}

export function expandHome(inputPath: string): string {
  return expandHomePath(inputPath);
}

export function resolveWorktreeParentDir(expandedRepoPath: string): string {
  const configuredParent = process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  if (configuredParent?.trim()) {
    return expandHome(configuredParent);
  }

  return path.dirname(expandedRepoPath);
}

export function sanitizeTicketId(ticketId: string): string {
  return ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
}

export function resolveWorktreeDir(
  expandedRepoPath: string,
  ticketId: string
): string {
  const sanitizedTicket = sanitizeTicketId(ticketId);
  const repoName = path.basename(expandedRepoPath);
  return path.join(
    resolveWorktreeParentDir(expandedRepoPath),
    `${repoName}-${sanitizedTicket}`
  );
}

export function assertRepoAllowed(
  repoPath: string,
  allowedDirectories: string[]
): string {
  const expandedRepoPath = expandHome(repoPath);
  try {
    assertPathAllowed(expandedRepoPath, allowedDirectories);
    return expandedRepoPath;
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      throw error;
    }
    throw error;
  }
}

// --- Worktree management for reviews ---

/**
 * Recursively find all .env and .env.local files in a directory.
 * Skips node_modules and hidden directories.
 */
function findEnvFiles(dir: string, results: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        findEnvFiles(fullPath, results);
      } else if (entry.name === ".env" || entry.name === ".env.local") {
        results.push(fullPath);
      }
    }
  } catch {
    // Can't read directory
  }
  return results;
}

/**
 * Copy .env and .env.local files from base repo to worktree.
 * Git worktrees don't include ignored files, so we need to copy them manually.
 */
function copyEnvLocalFiles(repoPath: string, worktreePath: string): void {
  const envFiles = findEnvFiles(repoPath);
  for (const absPath of envFiles) {
    const relativePath = absPath.slice(repoPath.length + 1);
    const destPath = path.join(worktreePath, relativePath);
    try {
      copyFileSync(absPath, destPath);
    } catch {
      // Can't copy file (dest dir may not exist in worktree, permission issue, etc.)
    }
  }
}

/**
 * Run the customer's `.closedloop-ai/loops-setup.sh` bootstrap script if it
 * exists in the worktree.  Non-fatal: failures are logged but never block the
 * loop from proceeding.
 *
 * Async to avoid blocking the Node event loop during long-running setup scripts
 * (e.g. dependency installs).  Uses getShellEnv() so that the script inherits
 * the user's full PATH (Electron strips it on launch).
 */
export async function runLoopsSetupScript(
  worktreeDir: string,
  loopId: string
): Promise<void> {
  const scriptPath = path.join(worktreeDir, ".closedloop-ai", "loops-setup.sh");
  if (!existsSync(scriptPath)) {
    return;
  }

  loopLog(loopId, `Running loops-setup.sh in ${worktreeDir}`);
  try {
    const env = await getShellEnv();
    await execFileAsync("bash", [scriptPath], {
      cwd: worktreeDir,
      timeout: 600_000, // 10 minutes — enough for dependency installs
      env,
    });
    loopLog(loopId, "loops-setup.sh completed successfully");
  } catch (err) {
    loopError(
      loopId,
      `loops-setup.sh failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Fetch latest refs from origin. No-op if offline. */
export function fetchOrigin(repoPath: string): void {
  try {
    execFileSync(getResolvedGitPath(), ["fetch", "origin"], {
      cwd: repoPath,
      stdio: "pipe",
      timeout: NETWORK_GIT_TIMEOUT,
    });
  } catch {
    // Offline — continue with local state
  }
}

type SavedWorktreeState = {
  savedClaudeAgentsDir: string | null;
  savedClosedloopDir: string | null;
};

/**
 * Save accepted worktree state to temp locations.
 * - Preserve .claude/agents/ (project agents still live there)
 * - Preserve .closedloop-ai/
 */
export function saveWorktreeState(worktreeDir: string): SavedWorktreeState {
  const claudeAgentsDir = path.join(worktreeDir, ".claude", "agents");
  const closedloopDir = path.join(worktreeDir, ".closedloop-ai");
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let savedClaudeAgentsDir: string | null = null;
  if (existsSync(claudeAgentsDir)) {
    savedClaudeAgentsDir = path.join(
      os.tmpdir(),
      `worktree-claude-agents-${ts}`
    );
    renameSync(claudeAgentsDir, savedClaudeAgentsDir);
  }

  let savedClosedloopDir: string | null = null;
  if (existsSync(closedloopDir)) {
    savedClosedloopDir = path.join(os.tmpdir(), `worktree-closedloop-${ts}`);
    renameSync(closedloopDir, savedClosedloopDir);
  }

  return { savedClaudeAgentsDir, savedClosedloopDir };
}

/**
 * Restore previously saved .claude/agents/ and .closedloop-ai/ state into worktreeDir.
 */
export function restoreWorktreeState(
  saved: SavedWorktreeState,
  worktreeDir: string
): void {
  const { savedClaudeAgentsDir, savedClosedloopDir } = saved;

  if (savedClaudeAgentsDir) {
    const destClaudeAgents = path.join(worktreeDir, ".claude", "agents");
    try {
      mkdirSync(destClaudeAgents, { recursive: true });
      for (const child of readdirSync(savedClaudeAgentsDir)) {
        const destChild = path.join(destClaudeAgents, child);
        if (!existsSync(destChild)) {
          cpSync(path.join(savedClaudeAgentsDir, child), destChild, {
            recursive: true,
            force: false,
          });
        }
      }
      rmSync(savedClaudeAgentsDir, { recursive: true, force: true });
    } catch {
      // Best effort -- backup preserved if restore failed
    }
  }

  if (savedClosedloopDir) {
    const destClosedloop = path.join(worktreeDir, ".closedloop-ai");
    try {
      mkdirSync(destClosedloop, { recursive: true });
      cpSync(savedClosedloopDir, destClosedloop, { recursive: true });
      rmSync(savedClosedloopDir, { recursive: true, force: true });
    } catch {
      // Best effort -- backup preserved if restore failed
    }
  }
}

/**
 * Create a new git worktree at worktreeDir checked out to ref,
 * then copy .env/.env.local files from the base repo.
 */
function addWorktree(repoPath: string, worktreeDir: string, ref: string): void {
  // If the directory exists but isn't a git worktree (e.g. state files were
  // written there by a "use base repo" review), remove it so git worktree add
  // can create it cleanly. Preserve .claude/agents/ and .closedloop-ai/.
  let savedState: ReturnType<typeof saveWorktreeState> | null = null;
  if (existsSync(worktreeDir) && !existsSync(path.join(worktreeDir, ".git"))) {
    savedState = saveWorktreeState(worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  // Prune stale worktree entries (directory was removed but git still tracks it)
  try {
    execFileSync(getResolvedGitPath(), ["worktree", "prune"], {
      cwd: repoPath,
      stdio: "pipe",
      timeout: LOCAL_GIT_TIMEOUT,
    });
  } catch {
    // Best effort
  }

  try {
    execFileSync(getResolvedGitPath(), ["worktree", "add", worktreeDir, ref], {
      cwd: repoPath,
      stdio: "pipe",
      timeout: NETWORK_GIT_TIMEOUT,
    });
  } catch (err) {
    // Restore saved state before propagating -- prevents stranding in /tmp
    if (savedState) {
      mkdirSync(worktreeDir, { recursive: true });
      restoreWorktreeState(savedState, worktreeDir);
    }
    throw err;
  }

  if (savedState) {
    restoreWorktreeState(savedState, worktreeDir);
  }

  copyEnvLocalFiles(repoPath, worktreeDir);
}

/** Check out a branch in an existing worktree, trying multiple fallback strategies. */
function checkoutBranch(worktreeDir: string, branchName: string): void {
  try {
    execFileSync(getResolvedGitPath(), ["checkout", branchName], {
      cwd: worktreeDir,
      stdio: "pipe",
      timeout: LOCAL_GIT_TIMEOUT,
    });
    return;
  } catch {
    // Branch may not exist locally yet
  }
  try {
    execFileSync(
      getResolvedGitPath(),
      ["checkout", "-B", branchName, `origin/${branchName}`],
      {
        cwd: worktreeDir,
        stdio: "pipe",
        timeout: LOCAL_GIT_TIMEOUT,
      }
    );
    return;
  } catch {
    // Branch may be checked out in another worktree
  }
  try {
    execFileSync(
      getResolvedGitPath(),
      ["checkout", "--detach", `origin/${branchName}`],
      {
        cwd: worktreeDir,
        stdio: "pipe",
        timeout: LOCAL_GIT_TIMEOUT,
      }
    );
  } catch {
    // Best effort — continue with whatever is checked out
  }
}

/** Fast-forward or rebase an existing worktree to the latest remote branch. */
function fastForwardBranch(worktreeDir: string, branchName: string): void {
  try {
    execFileSync(
      getResolvedGitPath(),
      ["pull", "--ff-only", "origin", branchName],
      {
        cwd: worktreeDir,
        stdio: "pipe",
        timeout: NETWORK_GIT_TIMEOUT,
      }
    );
    return;
  } catch {
    // ff-only failed (diverged) — try rebase if working tree is clean
  }
  try {
    execFileSync(getResolvedGitPath(), ["diff", "--quiet"], {
      cwd: worktreeDir,
      stdio: "pipe",
      timeout: LOCAL_GIT_TIMEOUT,
    });
    execFileSync(getResolvedGitPath(), ["diff", "--cached", "--quiet"], {
      cwd: worktreeDir,
      stdio: "pipe",
      timeout: LOCAL_GIT_TIMEOUT,
    });
    execFileSync(getResolvedGitPath(), ["rebase", `origin/${branchName}`], {
      cwd: worktreeDir,
      stdio: "pipe",
      timeout: NETWORK_GIT_TIMEOUT,
    });
  } catch {
    // Dirty working tree or rebase failed — continue with current state
  }
}

/**
 * Resolve a branch name to a valid git ref, trying remote then local.
 * Returns the resolved ref string, or null if neither exists.
 */
export function resolveRef(
  repoPath: string,
  branchName: string
): string | null {
  for (const candidate of [`origin/${branchName}`, branchName]) {
    try {
      execFileSync(getResolvedGitPath(), ["rev-parse", "--verify", candidate], {
        cwd: repoPath,
        stdio: "pipe",
        timeout: LOCAL_GIT_TIMEOUT,
      });
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/**
 * Ensure a worktree exists at worktreeDir on the given branch, fast-forwarded to latest.
 * Creates a new worktree if none exists, or checks out the branch and pulls if it does.
 *
 * When the branch ref no longer exists (e.g. deleted after merge), falls back to a
 * detached worktree on `origin/${baseBranch}` so that merged-PR reviews can still run.
 */
function ensureWorktree(
  repoPath: string,
  worktreeDir: string,
  branchName?: string,
  baseBranch?: string
): void {
  fetchOrigin(repoPath);

  const hasGit = existsSync(path.join(worktreeDir, ".git"));

  if (!hasGit && branchName) {
    const ref = resolveRef(repoPath, branchName);
    if (ref) {
      addWorktree(repoPath, worktreeDir, ref);
    } else {
      // Branch was deleted (e.g. after PR merge) — fall back to base branch
      const fallbackRef = resolveRef(repoPath, baseBranch ?? "main");
      if (!fallbackRef) {
        throw new Error(
          `Branch '${branchName}' not found (may have been deleted after merge) and base branch '${baseBranch ?? "main"}' also not found`
        );
      }
      addWorktree(repoPath, worktreeDir, fallbackRef);
    }
  } else if (hasGit && branchName) {
    checkoutBranch(worktreeDir, branchName);
    fastForwardBranch(worktreeDir, branchName);
  }
}

/**
 * Ensure a worktree is ready for a review session.
 *
 * - No-ops when `useBaseRepo` is true (review runs in the base repo).
 * - Returns an error object when `branchName` is missing and no worktree exists.
 * - Otherwise creates or updates the worktree via `ensureWorktree`.
 *
 * Returns `null` on success, or `{ status, message }` on error.
 */
export function ensureWorktreeForReview(
  expandedRepoPath: string,
  worktreeDir: string,
  branchName: string | undefined,
  useBaseRepo: boolean,
  baseBranch?: string
): { status: number; message: string } | null {
  if (useBaseRepo) {
    return null;
  }

  if (!(branchName || existsSync(path.join(worktreeDir, ".git")))) {
    return {
      status: 400,
      message: "branchName is required to create a worktree",
    };
  }

  try {
    ensureWorktree(expandedRepoPath, worktreeDir, branchName, baseBranch);
  } catch (err) {
    // A concurrent request may have won the race — if the worktree now exists, use it
    if (!existsSync(path.join(worktreeDir, ".git"))) {
      return {
        status: 500,
        message: `Failed to create worktree: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
  }

  return null;
}

export function tryAssertRepoAllowed(
  repoPath: string,
  allowedDirs: string[]
): { path: string } | { error: string; status: 403 } {
  try {
    return { path: assertRepoAllowed(repoPath, allowedDirs) };
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      return { error: "directory not allowed", status: 403 };
    }
    throw error;
  }
}

export function tryAssertPathAllowed(
  dirPath: string,
  allowedDirs: string[]
): true | { error: string; status: 403 } {
  try {
    assertPathAllowed(dirPath, allowedDirs);
    return true;
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      return { error: "directory not allowed", status: 403 };
    }
    throw error;
  }
}

export const VALID_PROVIDERS = new Set(["claude", "codex"]);

export function chatHistoryFilename(provider?: string | null): string {
  return provider && VALID_PROVIDERS.has(provider)
    ? `chat-history-${provider}.json`
    : "chat-history.json";
}

// --- Launch idempotency utilities ---

/**
 * Read the PID from .closedloop-ai/work/process.pid if it exists.
 * Returns null if file doesn't exist or is invalid.
 */
export function readProcessPidSync(worktreeDir: string): number | null {
  const pidPath = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "process.pid"
  );

  try {
    const pidContent = readFileSync(pidPath, "utf-8");
    const pid = Number.parseInt(pidContent.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if a process is running by sending signal 0.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type LaunchMetadata = {
  issueId?: string;
  ticketTitle?: string;
  artifactId?: string;
  loopId?: string;
  baseBranch?: string;
  parentTicketId?: string;
};

/**
 * Read launch metadata from {worktreeDir}/.closedloop-ai/work/launch-metadata.json.
 */
export function readLaunchMetadata(worktreeDir: string): LaunchMetadata | null {
  const metaPath = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "launch-metadata.json"
  );

  try {
    const content = readFileSync(metaPath, "utf-8");
    return parseLaunchMetadataContent(content);
  } catch {
    return null;
  }
}

/**
 * Async launch metadata reader for UI-sensitive paths. It mirrors
 * `readLaunchMetadata` while avoiding a blocking file read on Electron's main
 * thread.
 */
export async function readLaunchMetadataAsync(
  worktreeDir: string
): Promise<LaunchMetadata | null> {
  const metaPath = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "launch-metadata.json"
  );

  try {
    const content = await readFile(metaPath, "utf-8");
    return parseLaunchMetadataContent(content);
  } catch {
    return null;
  }
}

function parseLaunchMetadataContent(content: string): LaunchMetadata {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    issueId: typeof parsed.issueId === "string" ? parsed.issueId : undefined,
    ticketTitle:
      typeof parsed.ticketTitle === "string" ? parsed.ticketTitle : undefined,
    artifactId:
      typeof parsed.artifactId === "string" ? parsed.artifactId : undefined,
    loopId: typeof parsed.loopId === "string" ? parsed.loopId : undefined,
    baseBranch:
      typeof parsed.baseBranch === "string" ? parsed.baseBranch : undefined,
    parentTicketId:
      typeof parsed.parentTicketId === "string"
        ? parsed.parentTicketId
        : undefined,
  };
}

/**
 * Write launch metadata, merging with existing values.
 */
export function writeLaunchMetadata(
  worktreeDir: string,
  meta: LaunchMetadata
): void {
  const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
  mkdirSync(claudeWorkDir, { recursive: true });

  const metaPath = path.join(claudeWorkDir, "launch-metadata.json");
  const existing = readLaunchMetadata(worktreeDir);

  const merged: LaunchMetadata = {
    issueId: meta.issueId ?? existing?.issueId,
    ticketTitle: meta.ticketTitle ?? existing?.ticketTitle,
    artifactId: meta.artifactId ?? existing?.artifactId,
    loopId: meta.loopId ?? existing?.loopId,
    baseBranch: meta.baseBranch ?? existing?.baseBranch,
    parentTicketId: meta.parentTicketId ?? existing?.parentTicketId,
  };

  writeFileSync(metaPath, JSON.stringify(merged, null, 2));
}

/**
 * Acquire an atomic launch lock via O_CREAT | O_EXCL.
 * Returns { fd } on success, null on EEXIST (contention).
 */
export function acquireLaunchLock(lockDir: string): { fd: number } | null {
  mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, "launch.lock");

  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: file open flags require bitwise OR
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
    const fd = openSync(lockPath, flags);
    try {
      // Write through the fd to avoid a window where the file exists but is empty
      writeSync(
        fd,
        Buffer.from(JSON.stringify({ pid: process.pid, timestamp: Date.now() }))
      );
    } catch (writeErr) {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(lockPath);
      } catch {}
      throw writeErr;
    }
    return { fd };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw err;
  }
}

/**
 * Release the launch lock.
 */
export function releaseLaunchLock(lockDir: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
  try {
    unlinkSync(path.join(lockDir, "launch.lock"));
  } catch {
    /* already removed */
  }
}

/** Minimum age (ms) before a malformed lock is considered orphaned vs in-progress write */
const STALE_LOCK_AGE_MS = 5000;

/**
 * Clean up a stale lock whose owner process has died.
 * Malformed/empty locks are only removed if older than STALE_LOCK_AGE_MS
 * to avoid racing with a concurrent acquireLaunchLock fd write.
 */
export function cleanStaleLock(lockDir: string): void {
  const lockPath = path.join(lockDir, "launch.lock");

  if (!existsSync(lockPath)) {
    return;
  }

  try {
    const content = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const pid = parsed.pid;

    if (typeof pid !== "number" || !Number.isFinite(pid)) {
      if (isLockFileOld(lockPath)) {
        unlinkSync(lockPath);
      }
      return;
    }

    if (!isProcessRunning(pid)) {
      unlinkSync(lockPath);
    }
  } catch {
    try {
      if (isLockFileOld(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* concurrent removal */
    }
  }
}

function isLockFileOld(lockPath: string): boolean {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    return age > STALE_LOCK_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Compute the lock directory for a given ticket/repo combination.
 */
export function getLockDir(
  worktreeParentDir: string,
  repoName: string,
  sanitizedTicket: string
): string {
  return path.join(
    worktreeParentDir,
    ".closedloop-ai",
    "locks",
    `${repoName}-${sanitizedTicket}`
  );
}

// ---------------------------------------------------------------------------
// Auto-bootstrap gate (FEA-652 Part B)
// ---------------------------------------------------------------------------

export function hasBootstrapArtifacts(dir: string): boolean {
  const metadataPath = path.join(
    dir,
    ".closedloop-ai",
    "bootstrap-metadata.json"
  );
  if (existsSync(metadataPath)) {
    return true;
  }

  const agentsDir = path.join(dir, ".claude", "agents");
  try {
    const files = readdirSync(agentsDir);
    return files.some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}

export function resolveBootstrapTimeoutMs(): number {
  const raw = process.env.CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS;
  if (!raw) {
    return BOOTSTRAP_TIMEOUT_MS;
  }

  if (!/^\d+$/.test(raw)) {
    return BOOTSTRAP_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BOOTSTRAP_TIMEOUT_MS;
}

function appendBoundedTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf-8");
  return next.length > BOOTSTRAP_OUTPUT_TAIL_BYTES
    ? next.slice(next.length - BOOTSTRAP_OUTPUT_TAIL_BYTES)
    : next;
}

export function redactBootstrapDiagnosticTail(
  text: string,
  worktreeDir: string
): string {
  let redacted = text;
  const pathsToRedact = [
    worktreeDir,
    path.dirname(worktreeDir),
    os.homedir(),
  ].filter((value) => value.length > 1);

  for (const sensitivePath of pathsToRedact) {
    redacted = redacted.split(sensitivePath).join("[redacted-path]");
  }

  return redacted
    .replaceAll(
      /\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
      "[redacted-token]"
    )
    .replaceAll(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|AUTH)[A-Z0-9_]*)=([^\s"'`]+)/gi,
      "$1=[redacted-secret]"
    );
}

async function runBootstrapProcess(
  worktreeDir: string,
  loopId: string,
  timeoutMs: number,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider
): Promise<BootstrapRunResult> {
  const claudePath = getResolvedClaudePath();
  const env = await getClaudeShellEnv();

  return await new Promise<BootstrapRunResult>((resolve) => {
    let settled = false;
    let stdoutTail = "";
    let stderrTail = "";

    const child = spawn(claudePath, ["-p", "/bootstrap:agent-bootstrap"], {
      cwd: worktreeDir,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (groupErr) {
          try {
            child.kill("SIGKILL");
          } catch (childErr) {
            loopError(
              loopId,
              `Bootstrap timeout cleanup failed: group=${String(groupErr)} child=${String(childErr)}`
            );
          }
        }
      }
      settle({
        status: "timed-out",
        timeoutMs,
        stdoutTail: redactBootstrapDiagnosticTail(stdoutTail, worktreeDir),
        stderrTail: redactBootstrapDiagnosticTail(stderrTail, worktreeDir),
      });
    }, timeoutMs);
    timer.unref();

    const settle = (result: BootstrapRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTail = appendBoundedTail(stdoutTail, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = appendBoundedTail(stderrTail, chunk);
    });

    child.on("error", (err) => {
      stderrTail = appendBoundedTail(stderrTail, Buffer.from(String(err)));
      settle({
        status: "failed",
        exitCode: null,
        signal: null,
        stdoutTail: redactBootstrapDiagnosticTail(stdoutTail, worktreeDir),
        stderrTail: redactBootstrapDiagnosticTail(stderrTail, worktreeDir),
      });
    });

    child.on("exit", (exitCode, signal) => {
      setImmediate(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();

        if (exitCode === 0) {
          settle({ status: "completed" });
          return;
        }

        settle({
          status: "failed",
          exitCode,
          signal,
          stdoutTail: redactBootstrapDiagnosticTail(stdoutTail, worktreeDir),
          stderrTail: redactBootstrapDiagnosticTail(stderrTail, worktreeDir),
        });
      });
    });

    child.on("close", (exitCode, signal) => {
      if (exitCode === 0) {
        settle({ status: "completed" });
        return;
      }

      settle({
        status: "failed",
        exitCode,
        signal,
        stdoutTail: redactBootstrapDiagnosticTail(stdoutTail, worktreeDir),
        stderrTail: redactBootstrapDiagnosticTail(stderrTail, worktreeDir),
      });
    });
  });
}

export async function runBootstrapIfNeeded(
  worktreeDir: string,
  loopId: string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
): Promise<BootstrapRunResult> {
  if (hasBootstrapArtifacts(worktreeDir)) {
    loopLog(loopId, "Bootstrap skipped — artifacts already present");
    return { status: "skipped-artifacts" };
  }

  if (!isPluginInstalled("bootstrap")) {
    loopLog(loopId, "Bootstrap skipped — plugin not installed");
    return { status: "skipped-plugin-missing" };
  }

  try {
    loopLog(loopId, "Running bootstrap (no artifacts detected)...");
    const result = await runBootstrapProcess(
      worktreeDir,
      loopId,
      resolveBootstrapTimeoutMs(),
      getClaudeShellEnv
    );
    if (result.status === "completed") {
      loopLog(loopId, "Bootstrap completed");
    } else if (result.status === "timed-out") {
      loopError(
        loopId,
        `Bootstrap timed out after ${result.timeoutMs}ms (continuing) stdout=${result.stdoutTail} stderr=${result.stderrTail}`
      );
    } else if (result.status === "failed") {
      loopError(
        loopId,
        `Bootstrap failed (continuing) exitCode=${result.exitCode ?? "null"} signal=${result.signal ?? "null"} stdout=${result.stdoutTail} stderr=${result.stderrTail}`
      );
    }
    return result;
  } catch (err) {
    loopError(
      loopId,
      `Bootstrap failed (continuing): ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      status: "failed",
      exitCode: null,
      signal: null,
      stdoutTail: "",
      stderrTail: redactBootstrapDiagnosticTail(
        err instanceof Error ? err.message : String(err),
        worktreeDir
      ),
    };
  }
}
