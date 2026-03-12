import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
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
 */
export async function readProcessPid(
  worktreeDir: string
): Promise<number | null> {
  const pidPath = join(worktreeDir, ".claude", "work", "process.pid");

  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const pidContent = await readFile(pidPath, "utf-8");
    const pid = Number.parseInt(pidContent.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
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
 * Read launch metadata from {worktreeDir}/.claude/work/launch-metadata.json.
 * Returns null if file missing or malformed.
 */
export function readLaunchMetadata(worktreeDir: string): LaunchMetadata | null {
  const metaPath = join(worktreeDir, ".claude", "work", "launch-metadata.json");

  if (!existsSync(metaPath)) {
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
 * Write launch metadata to {worktreeDir}/.claude/work/launch-metadata.json.
 * Merges with existing metadata: new defined values override, undefined values
 * fall back to existing.
 * Called BEFORE process.pid is written (ordering guarantee).
 */
export function writeLaunchMetadata(
  worktreeDir: string,
  meta: LaunchMetadata
): void {
  const claudeWorkDir = join(worktreeDir, ".claude", "work");
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
