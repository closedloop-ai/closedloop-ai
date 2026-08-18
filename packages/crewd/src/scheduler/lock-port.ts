/**
 * LockPort — the single-instance guard seam the daemon depends on.
 *
 * Extracted for FEA-3812 so the daemon core carries no `node:fs` coupling: the
 * CLI injects the file-backed `FileLock` (see file-lock.ts) for a long-running
 * `crewd start`, while the desktop host — where the OS/app already guarantees a
 * single process — can inject `noopLock` or its own coordinator. `start()`
 * acquires on launch and `stop()` releases; a no-op lock makes both harmless.
 */

export type LockPort = {
  /** Claim the lock. Throw if another live instance already holds it. */
  acquire(): void;
  /** Release the lock if held. Must be safe to call when not held. */
  release(): void;
};

/** A lock that never blocks — the default when no single-instance guard is needed. */
export const noopLock: LockPort = {
  acquire() {
    /* nothing to claim */
  },
  release() {
    /* nothing to release */
  },
};
