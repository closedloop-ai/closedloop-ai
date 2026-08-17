/**
 * @file zombie-db-holder-os.ts
 * @description FEA-3625 — the real OS primitives that back
 * {@link reapZombieDatabaseHolders}: `lsof` to find DB holders, `ps` to read a
 * pid's state + command, and `process.kill` to SIGKILL a reaped holder. Kept in
 * its own module so the reaper's selection/orchestration logic stays free of
 * `child_process` and is unit-testable with injected fakes.
 *
 * Only active on macOS/Linux — `lsof`/`ps` with these flags are POSIX. On other
 * platforms {@link buildZombieDbHolderOsDeps} returns null so the caller skips
 * the reap entirely (no-op).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReapZombieDbHoldersDeps } from "./zombie-db-holder-reaper.js";

const execFileAsync = promisify(execFile);

const WHITESPACE_RE = /\s+/;

/**
 * Run `lsof -t -- <paths...>` and return the unique holder pids. `-t` prints
 * bare pids (one per line); missing files are simply skipped by lsof. A
 * non-zero exit is normal when NO process holds any of the files (lsof exits 1),
 * so that case yields []. A genuinely absent `lsof` binary (ENOENT) rethrows so
 * the reaper's catch treats the platform as unsupported and skips cleanup.
 */
async function lsofHolderPids(paths: string[]): Promise<number[]> {
  if (paths.length === 0) {
    return [];
  }
  let stdout = "";
  try {
    const result = await execFileAsync("lsof", ["-t", "--", ...paths], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    stdout = result.stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string };
    if (e.code === "ENOENT") {
      // No lsof on this host — unsupported; let the reaper skip cleanup.
      throw error;
    }
    // Non-zero exit (no holders, or a partially-missing path set): lsof still
    // prints any pids it did find on stdout before exiting 1. Use that.
    stdout = e.stdout ?? "";
  }
  const pids = new Set<number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/**
 * Read a single pid's `{ stat, command }` via `ps -o stat= -o command= -p <pid>`.
 * Returns null when the pid is gone (ps exits non-zero / prints nothing). The
 * first whitespace-delimited token is the STAT field; the remainder is the
 * command line.
 */
async function psDescribe(
  pid: number
): Promise<{ stat: string; command: string } | null> {
  let stdout = "";
  try {
    const result = await execFileAsync(
      "ps",
      ["-o", "stat=", "-o", "command=", "-p", String(pid)],
      {
        timeout: 5000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      }
    );
    stdout = result.stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string };
    if (e.code === "ENOENT") {
      throw error;
    }
    // ps exits 1 when the pid no longer exists → treat as "already gone".
    stdout = e.stdout ?? "";
  }
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) {
    return null;
  }
  const trimmed = line.trim();
  const firstSpace = trimmed.search(WHITESPACE_RE);
  if (firstSpace === -1) {
    // STAT with no command (defunct/zombie can print just the state).
    return { stat: trimmed, command: "" };
  }
  return {
    stat: trimmed.slice(0, firstSpace),
    command: trimmed.slice(firstSpace + 1).trim(),
  };
}

/**
 * SIGKILL a pid. `process.kill` throws ESRCH if the pid is already gone (treat
 * as success — the goal is that it is no longer holding the lock) and EPERM if
 * we lack permission (failure). Returns whether the process is confirmed gone.
 */
function sigkill(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGKILL");
    return Promise.resolve(true);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    // Already dead → the lock is released, which is the outcome we wanted.
    return Promise.resolve(e.code === "ESRCH");
  }
}

/**
 * Build the OS-backed deps for {@link reapZombieDatabaseHolders}, or null on an
 * unsupported platform (Windows), where the caller skips the reap. `currentPid`
 * defaults to `process.pid`.
 */
export function buildZombieDbHolderOsDeps(
  platform: NodeJS.Platform,
  log: (message: string) => void,
  currentPid: number = process.pid
): Pick<
  ReapZombieDbHoldersDeps,
  | "listHolderPids"
  | "describeProcess"
  | "killProcess"
  | "currentPid"
  | "delay"
  | "log"
> | null {
  if (platform !== "darwin" && platform !== "linux") {
    return null;
  }
  return {
    listHolderPids: lsofHolderPids,
    describeProcess: psDescribe,
    killProcess: sigkill,
    currentPid,
    delay: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log,
  };
}
