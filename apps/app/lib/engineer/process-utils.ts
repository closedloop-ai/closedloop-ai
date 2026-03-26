import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read the PID from process.pid file if it exists.
 * Returns null if file doesn't exist or is invalid.
 * Legacy-aware: checks both .closedloop-ai/work and .claude/work.
 * When both exist, prefers the one with a live process to avoid
 * a stale PID at the new path masking a live legacy process.
 */
export async function readProcessPid(
  worktreeDir: string
): Promise<number | null> {
  const candidates = [
    join(worktreeDir, ".closedloop-ai", "work", "process.pid"),
    join(worktreeDir, ".claude", "work", "process.pid"),
  ];

  let fallbackPid: number | null = null;

  for (const pidPath of candidates) {
    if (!existsSync(pidPath)) {
      continue;
    }
    try {
      const pidContent = await readFile(pidPath, "utf-8");
      const pid = Number.parseInt(pidContent.trim(), 10);
      if (Number.isNaN(pid)) {
        continue;
      }
      // If the process is alive, return it immediately (live wins)
      if (isProcessRunning(pid)) {
        return pid;
      }
      // Track first stale PID as fallback
      fallbackPid ??= pid;
    } catch {
      // Can't read file — skip
    }
  }

  return fallbackPid;
}

/**
 * Check if a process is running by sending signal 0.
 * This doesn't kill the process, just checks if it exists.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type LaunchMetadata = {
  baseBranch?: string;
  parentTicketId?: string;
};

/**
 * Read launch metadata from {worktreeDir}/.closedloop-ai/work/launch-metadata.json.
 * Returns null if file missing or malformed.
 */
export function readLaunchMetadata(worktreeDir: string): LaunchMetadata | null {
  const newMetaPath = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "launch-metadata.json"
  );
  const oldMetaPath = join(
    worktreeDir,
    ".claude",
    "work",
    "launch-metadata.json"
  );
  const metaPath = findFirstExistingPath(newMetaPath, oldMetaPath);

  if (!metaPath) {
    return null;
  }

  try {
    const content = readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      baseBranch:
        typeof parsed.baseBranch === "string" ? parsed.baseBranch : undefined,
      parentTicketId:
        typeof parsed.parentTicketId === "string"
          ? parsed.parentTicketId
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Write launch metadata to {worktreeDir}/.closedloop-ai/work/launch-metadata.json.
 * Merges with existing metadata: new defined values override, undefined values
 * fall back to existing.
 * Called BEFORE process.pid is written (ordering guarantee).
 */
export function writeLaunchMetadata(
  worktreeDir: string,
  meta: LaunchMetadata
): void {
  const claudeWorkDir = join(worktreeDir, ".closedloop-ai", "work");
  mkdirSync(claudeWorkDir, { recursive: true });

  const metaPath = join(claudeWorkDir, "launch-metadata.json");

  // Read existing metadata for merge
  const existing = readLaunchMetadata(worktreeDir);

  const merged: LaunchMetadata = {
    baseBranch: meta.baseBranch ?? existing?.baseBranch,
    parentTicketId: meta.parentTicketId ?? existing?.parentTicketId,
  };

  writeFileSync(metaPath, JSON.stringify(merged, null, 2));
}

type LockInfo = {
  pid: number;
  timestamp: number;
};

/**
 * Acquire an atomic launch lock.
 * Uses O_CREAT | O_EXCL for atomicity — only one process can create the file.
 * Returns { fd } on success, null on EEXIST (contention).
 */
export function acquireLaunchLock(lockDir: string): { fd: number } | null {
  mkdirSync(lockDir, { recursive: true });

  const lockPath = join(lockDir, "launch.lock");

  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: file open flags require bitwise OR
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
    const fd = openSync(lockPath, flags);

    // Write through the fd (not by path) to avoid a window where the file
    // exists but is empty — cleanStaleLock could otherwise see the empty file,
    // treat it as corrupt, and delete it before we finish writing.
    const info: LockInfo = { pid: process.pid, timestamp: Date.now() };
    writeSync(fd, Buffer.from(JSON.stringify(info)));

    return { fd };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw err;
  }
}

/**
 * Release the launch lock: close the fd and remove the lock file.
 */
export function releaseLaunchLock(lockDir: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed
  }
  try {
    unlinkSync(join(lockDir, "launch.lock"));
  } catch {
    // Already removed
  }
}

/** Minimum age (ms) before a malformed lock is considered orphaned vs in-progress write */
const STALE_LOCK_AGE_MS = 5000;

/**
 * Clean up a stale lock whose owner process has died.
 * - If lock file exists and owner PID is dead → delete lock
 * - If lock file is corrupt/empty but recently created → leave it alone
 *   (another process may still be writing via fd)
 * - If lock file is corrupt/empty and old (>5s) → delete as orphaned
 * - If owner PID is alive → leave it alone
 * No absolute timeout for valid locks — PID liveness is the authoritative signal.
 */
export function cleanStaleLock(lockDir: string): void {
  const lockPath = join(lockDir, "launch.lock");

  if (!existsSync(lockPath)) {
    return;
  }

  try {
    const content = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const pid = parsed.pid;

    if (typeof pid !== "number" || !Number.isFinite(pid)) {
      // Corrupt lock — only remove if old enough to rule out in-progress write
      if (isLockFileOld(lockPath)) {
        unlinkSync(lockPath);
      }
      return;
    }

    if (!isProcessRunning(pid)) {
      // Owner is dead — re-read to avoid TOCTOU (another process may have
      // acquired a new lock between our read and this unlink)
      try {
        const recheck = readFileSync(lockPath, "utf-8");
        const reparsed = JSON.parse(recheck) as Record<string, unknown>;
        if (reparsed.pid === pid) {
          unlinkSync(lockPath);
        }
      } catch {
        // Lock was already removed or replaced — nothing to do
      }
    }
  } catch {
    // Malformed JSON or read error — only remove if old enough
    try {
      if (isLockFileOld(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      // Lock may have been removed by another process
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
 * Return the first path that exists on disk, or null if none exist.
 * Use this in read-only handlers to transparently support both legacy
 * (.claude/work) and new (.closedloop-ai/work) locations without renaming.
 */
export function findFirstExistingPath(...paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * One-time migration: if .claude/work exists but .closedloop-ai/work does not,
 * AND no live process is writing to the old path (caller must verify this),
 * rename the tree. Safe to call at both launch and write-first-access time.
 * Do NOT call from pure read handlers that accept raw caller-supplied paths.
 */
export function migrateWorkDirIfNeeded(worktreeDir: string): void {
  const oldDir = join(worktreeDir, ".claude", "work");
  const newDir = join(worktreeDir, ".closedloop-ai", "work");
  if (existsSync(oldDir) && !existsSync(newDir)) {
    mkdirSync(join(worktreeDir, ".closedloop-ai"), { recursive: true });
    renameSync(oldDir, newDir);
  }
}

/**
 * Write-handler preflight: check for a live legacy process before migrating.
 * Returns:
 * - "migrated" if .claude/work was renamed to .closedloop-ai/work
 * - "live-process-blocking" if a live process (symphony or codex review)
 *   is still writing to .claude/work
 * - "nothing-to-migrate" if .claude/work does not exist, OR if
 *   .closedloop-ai/work already exists (with no live legacy process)
 *
 * Checks process.pid AND codex-review-{claude,codex}.pid in .claude/work.
 * Even in split-root state (both dirs exist), still checks legacy PIDs.
 */
export function checkLegacyProcessAndMigrate(
  worktreeDir: string
): "migrated" | "live-process-blocking" | "nothing-to-migrate" {
  const newWorkDir = join(worktreeDir, ".closedloop-ai", "work");
  const oldWorkDir = join(worktreeDir, ".claude", "work");
  if (!existsSync(oldWorkDir)) {
    return "nothing-to-migrate";
  }
  // Even if both dirs exist (split-root), check for live legacy processes
  // before allowing writes. A legacy review may still be writing to .claude/work.
  // Check symphony PID
  const legacyPidPath = join(oldWorkDir, "process.pid");
  if (existsSync(legacyPidPath)) {
    try {
      const rawPid = readFileSync(legacyPidPath, "utf-8").trim();
      const legacyPid = Number.parseInt(rawPid, 10);
      if (!Number.isNaN(legacyPid) && isProcessRunning(legacyPid)) {
        return "live-process-blocking";
      }
    } catch {
      // Can't read PID file -- proceed with checks
    }
  }
  // Also check codex review PIDs (codex-review-claude.pid, codex-review-codex.pid)
  for (const provider of ["claude", "codex"]) {
    const codexPidPath = join(oldWorkDir, `codex-review-${provider}.pid`);
    if (existsSync(codexPidPath)) {
      try {
        const rawPid = readFileSync(codexPidPath, "utf-8").trim();
        const codexPid = Number.parseInt(rawPid, 10);
        if (!Number.isNaN(codexPid) && isProcessRunning(codexPid)) {
          return "live-process-blocking";
        }
      } catch {
        // Can't read PID file -- proceed
      }
    }
  }
  // No live legacy process -- safe to proceed.
  const alreadyMigrated = existsSync(newWorkDir);
  // migrateWorkDirIfNeeded is a no-op if new dir already exists.
  migrateWorkDirIfNeeded(worktreeDir);
  return alreadyMigrated ? "nothing-to-migrate" : "migrated";
}

type ReviewReadPaths = {
  winningRoot: string;
  statePath: string;
  logPath: string;
  pidPath: string;
  findingsPath: string;
};

/**
 * Resolve review file paths for reads across both work dirs.
 * Uses PID liveness as a tiebreaker when both roots have state files:
 * a stale "running" state with a dead PID loses to a live one.
 * All artifacts follow the winning root for consistency.
 */
export function resolveReviewReadPaths(
  worktreeDir: string,
  provider: string
): ReviewReadPaths {
  const newWorkDir = join(worktreeDir, ".closedloop-ai", "work");
  const oldWorkDir = join(worktreeDir, ".claude", "work");
  const stateFilename = `codex-review-${provider}.json`;
  const newStatePath = join(newWorkDir, stateFilename);
  const oldStatePath = join(oldWorkDir, stateFilename);

  let winningRoot = newWorkDir;
  if (existsSync(newStatePath) && existsSync(oldStatePath)) {
    try {
      const newState = JSON.parse(readFileSync(newStatePath, "utf-8"));
      const oldState = JSON.parse(readFileSync(oldStatePath, "utf-8"));
      const newLive =
        newState.status === "running" &&
        typeof newState.pid === "number" &&
        isProcessRunning(newState.pid);
      const oldLive =
        oldState.status === "running" &&
        typeof oldState.pid === "number" &&
        isProcessRunning(oldState.pid);
      if (oldLive && !newLive) {
        winningRoot = oldWorkDir;
      }
    } catch {
      // Parse error -- stick with new root
    }
  } else if (!existsSync(newStatePath) && existsSync(oldStatePath)) {
    winningRoot = oldWorkDir;
  }

  const fromRoot = (filename: string) => join(winningRoot, filename);
  return {
    winningRoot,
    statePath: fromRoot(stateFilename),
    logPath: fromRoot(`codex-review-${provider}.log`),
    pidPath: fromRoot(`codex-review-${provider}.pid`),
    findingsPath: fromRoot(`review-findings-${provider}.json`),
  };
}
