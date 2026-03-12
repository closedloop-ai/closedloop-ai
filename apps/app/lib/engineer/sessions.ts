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
import { homedir } from "node:os";
import { join } from "node:path";

export type PersistedSession = {
  ticketId: string;
  repoPath: string;
  worktreePath: string;
  pid?: number;
  contextRepoPaths?: string[];
  baseBranch?: string;
  parentTicketId?: string;
  startedAt: string;
  lastAccessedAt: string;
};

type SessionsConfig = {
  sessions: PersistedSession[];
};

const DEFAULT_DIR = join(homedir(), ".closedloop-ai");

/** Override for testing — redirects all paths to a temp directory */
let baseDirOverride: string | null = null;

/** @internal — test-only. Redirect session storage to a temp directory. */
export function _setBaseDirForTesting(dir: string | null): void {
  baseDirOverride = dir;
}

function getBaseDir(): string {
  return baseDirOverride ?? DEFAULT_DIR;
}

function getSessionsFile(): string {
  return join(getBaseDir(), "sessions.json");
}

function getSessionsLock(): string {
  return `${getSessionsFile()}.lock`;
}

/** Max age before a sessions lock is considered stale (owner crashed) */
const LOCK_STALE_MS = 5000;

/** Max attempts to acquire the sessions lock before throwing */
const LOCK_MAX_ATTEMPTS = 50;

/** Shared buffer for Atomics.wait — used as a synchronous sleep */
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function ensureDir() {
  if (!existsSync(getBaseDir())) {
    mkdirSync(getBaseDir(), { recursive: true });
  }
}

/**
 * Hold an exclusive file lock around a synchronous read-modify-write.
 * Uses O_CREAT | O_EXCL for atomicity. The critical section (small JSON
 * read + write) takes <1ms, so contention resolves with exponential backoff.
 * Throws if the lock cannot be acquired after LOCK_MAX_ATTEMPTS.
 */
function withSessionsLock<T>(fn: () => T): T {
  ensureDir();

  let lockFd: number | null = null;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      // biome-ignore lint/suspicious/noBitwiseOperators: file open flags require bitwise OR
      const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
      lockFd = openSync(getSessionsLock(), flags);
      writeSync(lockFd, Buffer.from(String(process.pid)));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }

      // Clean stale locks (>5s old — owner likely crashed)
      try {
        if (Date.now() - statSync(getSessionsLock()).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(getSessionsLock());
        }
      } catch {
        // Lock was already removed by another process
      }

      // Exponential backoff: 1ms, 2ms, 4ms, … capped at 50ms
      const backoffMs = Math.min(2 ** attempt, 50);
      Atomics.wait(waitBuffer, 0, 0, backoffMs);
    }
  }

  if (lockFd === null) {
    throw new Error(
      `Failed to acquire sessions lock after ${LOCK_MAX_ATTEMPTS} attempts`
    );
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(lockFd);
    } catch {
      // Already closed
    }
    try {
      unlinkSync(getSessionsLock());
    } catch {
      // Already removed
    }
  }
}

export function loadSessions(): SessionsConfig {
  ensureDir();
  if (!existsSync(getSessionsFile())) {
    return { sessions: [] };
  }
  try {
    const content = readFileSync(getSessionsFile(), "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessions: [] };
  }
}

export function saveSessions(config: SessionsConfig): void {
  ensureDir();
  writeFileSync(getSessionsFile(), JSON.stringify(config, null, 2));
}

/**
 * Upsert a session in the sessions file under an exclusive file lock.
 * Server-side counterpart of the client-side POST to /api/engineer/symphony/sessions.
 * Ensures the session is persisted even if the client dies before its POST completes.
 */
export function upsertSession(session: {
  ticketId: string;
  repoPath: string;
  worktreePath: string;
  pid?: number;
  contextRepoPaths?: string[];
  baseBranch?: string;
  parentTicketId?: string;
}): void {
  withSessionsLock(() => {
    const config = loadSessions();
    const now = new Date().toISOString();

    const existingIndex = config.sessions.findIndex(
      (s) => s.ticketId === session.ticketId
    );

    if (existingIndex >= 0) {
      config.sessions[existingIndex] = {
        ...config.sessions[existingIndex],
        repoPath: session.repoPath,
        worktreePath: session.worktreePath,
        ...(session.pid !== undefined && { pid: session.pid }),
        ...(session.contextRepoPaths !== undefined && {
          contextRepoPaths: session.contextRepoPaths,
        }),
        ...(session.baseBranch !== undefined && {
          baseBranch: session.baseBranch,
        }),
        ...(session.parentTicketId !== undefined && {
          parentTicketId: session.parentTicketId,
        }),
        lastAccessedAt: now,
      };
    } else {
      config.sessions.push({
        ticketId: session.ticketId,
        repoPath: session.repoPath,
        worktreePath: session.worktreePath,
        ...(session.pid !== undefined && { pid: session.pid }),
        ...(session.contextRepoPaths !== undefined && {
          contextRepoPaths: session.contextRepoPaths,
        }),
        ...(session.baseBranch !== undefined && {
          baseBranch: session.baseBranch,
        }),
        ...(session.parentTicketId !== undefined && {
          parentTicketId: session.parentTicketId,
        }),
        startedAt: now,
        lastAccessedAt: now,
      });
    }

    saveSessions(config);
  });
}

/**
 * Remove a session by ticketId under an exclusive file lock.
 */
export function deleteSession(ticketId: string): void {
  withSessionsLock(() => {
    const config = loadSessions();
    config.sessions = config.sessions.filter((s) => s.ticketId !== ticketId);
    saveSessions(config);
  });
}

/**
 * Remove sessions that fail the predicate, under an exclusive file lock.
 * Returns the valid sessions (for response building).
 */
export function pruneInvalidSessions(
  isValid: (session: PersistedSession) => boolean
): PersistedSession[] {
  return withSessionsLock(() => {
    const config = loadSessions();
    const validSessions = config.sessions.filter(isValid);

    if (validSessions.length !== config.sessions.length) {
      saveSessions({ sessions: validSessions });
    }

    return validSessions;
  });
}
