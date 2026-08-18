/**
 * File-backed single-instance lock — the fs half of the daemon's LockPort.
 *
 * This lives OUTSIDE the exported core (the daemon depends only on `LockPort`)
 * so `import { Daemon } from "@repo/crewd"` never pulls in `node:fs`. The CLI
 * wires this in for a long-running `crewd start`; the lock file holds the owner
 * pid and a stale lock (dead pid) is reclaimed. Ported verbatim from the daemon's
 * former inline lock.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LockPort } from "./lock-port.js";

export function defaultLockPath(): string {
  return `${process.env.TMPDIR ?? "/tmp"}/crewd.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A `LockPort` backed by a pid file. Reclaims a stale lock from a dead owner. */
export class FileLock implements LockPort {
  readonly path: string;
  private held = false;

  constructor(path: string = defaultLockPath()) {
    this.path = path;
  }

  acquire(): void {
    if (existsSync(this.path)) {
      const pid = Number(readFileSync(this.path, "utf8").trim());
      if (pid && pidAlive(pid)) {
        throw new Error(
          `crewd already running (pid ${pid}); lock ${this.path}`
        );
      }
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, String(process.pid), "utf8");
    this.held = true;
  }

  release(): void {
    if (!this.held) {
      return;
    }
    try {
      rmSync(this.path, { force: true });
    } catch {
      /* ignore */
    }
    this.held = false;
  }
}
