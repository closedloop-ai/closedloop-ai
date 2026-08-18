/**
 * @file zombie-db-holder-reaper.ts
 * @description FEA-3625 — startup auto-cleanup of zombie/suspended processes
 * that still hold the desktop SQLite database (`agent-dashboard.sqlite`) open.
 *
 * Root cause: an unclean shutdown (OOM-kill / `Killed: 9`, or a `pnpm dev`
 * terminal Ctrl-Z'd → SIGTSTP) can leave a prior Electron process alive in a
 * suspended (state `T`) or zombie (state `Z`) state. A stopped process keeps its
 * file locks, so it holds the WAL lock on the SQLite file hostage; the fresh
 * launch's db-host then stalls or fails to open the DB, and the app hangs on
 * start-up. The manual workaround was the `kill-desktop-zombies` operator skill
 * (lsof the DB → `kill -9` the state-`T` holders). This makes start-up perform
 * that reap automatically, BEFORE the db-host opens the file.
 *
 * SAFETY (this is the whole point of the feature):
 *   - Only processes holding THIS EXACT DB file (or its `-wal`/`-shm` sidecars)
 *     are considered — resolved from the running instance's userData path, so a
 *     different profile's DB is never touched.
 *   - Only holders in a NON-RUNNABLE state (`T` suspended / `Z` zombie) are
 *     reaped. A live, runnable holder is a legitimately-running instance and is
 *     LEFT ALONE — the single-instance lock's second-instance/focus semantics
 *     stay authoritative, so we never kill the app the user actually wants.
 *   - The current process is always excluded.
 *   - Each holder's command line must match the app's own identifier
 *     (`isOwnProcessCommand`), so an unrelated program that happens to have the
 *     file open (a backup tool, an editor) is never in scope. No broad `pkill`.
 *
 * Non-macOS/Linux platforms have no `lsof`/`ps` state model here, so the reaper
 * is a no-op there (Windows file locking differs and is out of scope for this
 * fix). All OS primitives are injected so the selection + orchestration logic is
 * unit-testable without touching real processes.
 */

/** A process holding the DB file open, as observed by `lsof` + `ps`. */
export type DbHolder = {
  pid: number;
  /**
   * The `ps` STAT letter(s). The leading char is the state: `T` suspended,
   * `Z` zombie/defunct, `R` running, `S` sleeping, etc.
   */
  stat: string;
  /** The holder's command line (`ps -o command=`), for own-process scoping. */
  command: string;
};

/**
 * A holder is reapable iff it is a DIFFERENT process than us, is in a
 * non-runnable state that cannot release the lock on its own (`T` suspended or
 * `Z` zombie), AND its command line is recognizably one of THIS app's own
 * processes. Everything else — a live/running holder, an unrelated program, or
 * ourselves — is left alone.
 */
export function isReapableHolder(
  holder: DbHolder,
  currentPid: number,
  isOwnProcessCommand: (command: string) => boolean
): boolean {
  if (holder.pid === currentPid) {
    return false;
  }
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) {
    return false;
  }
  const state = holder.stat.trim().charAt(0).toUpperCase();
  if (state !== "T" && state !== "Z") {
    return false;
  }
  return isOwnProcessCommand(holder.command);
}

/**
 * Pure selection: from the observed holders, return the sorted unique PIDs that
 * should be killed. Kept separate from the async orchestration so it can be
 * exhaustively unit-tested with plain records.
 */
export function selectZombieDbHolders(
  holders: DbHolder[],
  currentPid: number,
  isOwnProcessCommand: (command: string) => boolean
): number[] {
  const pids = new Set<number>();
  for (const holder of holders) {
    if (isReapableHolder(holder, currentPid, isOwnProcessCommand)) {
      pids.add(holder.pid);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * Default own-process matcher: an own Electron process's command line carries one
 * of these signals. In a PACKAGED build the executable path is
 * `/Applications/Closedloop.app/...` ("closedloop"); in `pnpm dev` the main
 * process is launched with a `--closedloop-renderer-url=` arg, and the db-host
 * utilityProcess entry is `db-host-worker.js` under our build output. Matching
 * any of these (plus a direct reference to the DB file) scopes the reap to our
 * app across dev + packaged while excluding unrelated programs. Case-insensitive.
 */
export function isClosedloopDesktopCommand(command: string): boolean {
  const haystack = command.toLowerCase();
  return (
    haystack.includes("closedloop") ||
    haystack.includes("db-host-worker") ||
    haystack.includes("agent-dashboard.sqlite")
  );
}

/**
 * Build an own-process matcher additionally scoped to a specific DB directory:
 * a holder whose command references our exact userData/DB directory is
 * unambiguously ours even if its executable path does not carry a recognizable
 * product name (e.g. the dev-mode Electron binary under `node_modules`). Falls
 * back to {@link isClosedloopDesktopCommand} for the product/db-host signals.
 */
export function makeOwnProcessMatcher(
  dbPath: string
): (command: string) => boolean {
  const dir = dbPath
    .slice(0, Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\")))
    .toLowerCase();
  return (command: string): boolean => {
    if (isClosedloopDesktopCommand(command)) {
      return true;
    }
    return dir.length > 0 && command.toLowerCase().includes(dir);
  };
}

export type ReapZombieDbHoldersDeps = {
  /**
   * List the PIDs currently holding any of the given file paths open. Backed by
   * `lsof` on macOS/Linux; returns [] (or throws, which the caller absorbs) when
   * the platform/tool is unavailable.
   */
  listHolderPids: (paths: string[]) => Promise<number[]>;
  /** Read a single process's `{ stat, command }`, or null if it is already gone. */
  describeProcess: (
    pid: number
  ) => Promise<{ stat: string; command: string } | null>;
  /** Send SIGKILL to a pid. Resolves true on success, false if the kill failed. */
  killProcess: (pid: number) => Promise<boolean>;
  /** The current process id (defaults to `process.pid` at the call site). */
  currentPid: number;
  /** Own-process command scoping (defaults to {@link isClosedloopDesktopCommand}). */
  isOwnProcessCommand?: (command: string) => boolean;
  /**
   * Sleep helper for the post-reap settle loop. `process.kill` returns before the
   * kernel has finished tearing the process down and reclaiming its file locks,
   * so after a successful SIGKILL we poll until the reaped pids are gone (up to
   * {@link RELEASE_WAIT_TOTAL_MS}) BEFORE the caller opens the DB — otherwise the
   * db-host can race the still-held WAL lock and boot fails anyway. Omit to skip
   * the wait (e.g. tests that assert the pre-wait behavior).
   */
  delay?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

/** Poll interval + budget for the post-reap "lock actually released" wait. */
const RELEASE_WAIT_STEP_MS = 100;
const RELEASE_WAIT_TOTAL_MS = 2000;

export type ReapZombieDbHoldersResult = {
  /** PIDs that were successfully SIGKILL'd. */
  reaped: number[];
  /** Suspended/zombie own-holders we tried but failed to kill. */
  failed: number[];
  /**
   * Own-holders that were LEFT alive because they were runnable (a legitimately
   * running instance). Informational — never an error.
   */
  skippedRunning: number[];
};

const errText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `ps`-describe each candidate pid, absorbing a per-pid error or an
 * already-exited process (null) so one bad pid never aborts the reap.
 */
async function describeHolders(
  candidates: number[],
  deps: ReapZombieDbHoldersDeps,
  log: (message: string) => void
): Promise<DbHolder[]> {
  const holders: DbHolder[] = [];
  for (const pid of candidates) {
    let described: { stat: string; command: string } | null;
    try {
      described = await deps.describeProcess(pid);
    } catch (error) {
      log(`zombie-db-reaper: could not describe pid ${pid}: ${errText(error)}`);
      continue;
    }
    // null → the process exited between the lsof snapshot and the ps read.
    if (described) {
      holders.push({ pid, stat: described.stat, command: described.command });
    }
  }
  return holders;
}

/** SIGKILL each target, partitioning into reaped (gone) vs failed (still up). */
async function killTargets(
  targets: number[],
  deps: ReapZombieDbHoldersDeps,
  log: (message: string) => void
): Promise<{ reaped: number[]; failed: number[] }> {
  const reaped: number[] = [];
  const failed: number[] = [];
  for (const pid of targets) {
    let killed = false;
    try {
      killed = await deps.killProcess(pid);
    } catch (error) {
      log(`zombie-db-reaper: kill pid ${pid} threw: ${errText(error)}`);
      killed = false;
    }
    (killed ? reaped : failed).push(pid);
  }
  return { reaped, failed };
}

/**
 * After a successful SIGKILL, `process.kill` has returned but the kernel may not
 * have finished reaping the process and releasing its file locks yet — so poll
 * `describeProcess` for the reaped pids until they are all gone (null) or the
 * budget expires, giving the WAL lock time to release before the caller opens
 * the DB. Best-effort: a describe error just ends the wait (we then let the DB
 * open attempt proceed and surface any residual lock the normal way).
 */
async function waitForHoldersGone(
  pids: number[],
  deps: ReapZombieDbHoldersDeps,
  log: (message: string) => void
): Promise<void> {
  const delay = deps.delay;
  if (!delay || pids.length === 0) {
    return;
  }
  let waited = 0;
  while (waited < RELEASE_WAIT_TOTAL_MS) {
    let anyAlive = false;
    for (const pid of pids) {
      try {
        if (await deps.describeProcess(pid)) {
          anyAlive = true;
          break;
        }
      } catch {
        // Can't tell — stop waiting and let the DB open attempt proceed.
        return;
      }
    }
    if (!anyAlive) {
      return;
    }
    await delay(RELEASE_WAIT_STEP_MS);
    waited += RELEASE_WAIT_STEP_MS;
  }
  log(
    `zombie-db-reaper: reaped holders still visible after ${RELEASE_WAIT_TOTAL_MS}ms; opening DB anyway`
  );
}

/**
 * Detect and reap zombie/suspended processes of THIS app holding the given
 * SQLite DB (and its `-wal`/`-shm` sidecars) open. Safe to call unconditionally
 * at start-up: it never throws (all failures are logged and absorbed) and only
 * kills the narrowly-scoped set described in the file header.
 */
export async function reapZombieDatabaseHolders(
  dbPath: string,
  deps: ReapZombieDbHoldersDeps
): Promise<ReapZombieDbHoldersResult> {
  const log = deps.log ?? (() => {});
  const isOwn = deps.isOwnProcessCommand ?? isClosedloopDesktopCommand;
  const empty: ReapZombieDbHoldersResult = {
    reaped: [],
    failed: [],
    skippedRunning: [],
  };

  let pids: number[];
  try {
    pids = await deps.listHolderPids([
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
    ]);
  } catch (error) {
    // No lsof / unsupported platform / permission error: treat as "no holders".
    // The db-host open still proceeds; if a real lock lingers it surfaces as a
    // normal boot failure rather than being masked.
    log(
      `zombie-db-reaper: holder lookup failed (skipping cleanup): ${errText(error)}`
    );
    return empty;
  }

  const candidates = pids.filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== deps.currentPid
  );
  if (candidates.length === 0) {
    return empty;
  }

  const holders = await describeHolders(candidates, deps, log);

  // Informational: own-holders that are alive/runnable are deliberately left
  // running (a legitimate instance). We only report them, never kill them.
  const skippedRunning = holders
    .filter(
      (h) =>
        isOwn(h.command) &&
        !isReapableHolder(h, deps.currentPid, isOwn) &&
        h.pid !== deps.currentPid
    )
    .map((h) => h.pid)
    .sort((a, b) => a - b);

  const targets = selectZombieDbHolders(holders, deps.currentPid, isOwn);
  if (targets.length === 0) {
    if (skippedRunning.length > 0) {
      log(
        `zombie-db-reaper: DB held by ${skippedRunning.length} running instance(s) (${skippedRunning.join(
          ", "
        )}); leaving them alone`
      );
    }
    return { ...empty, skippedRunning };
  }

  log(
    `zombie-db-reaper: reaping ${targets.length} suspended/zombie DB holder(s): ${targets.join(
      ", "
    )}`
  );

  const { reaped, failed } = await killTargets(targets, deps, log);
  if (failed.length > 0) {
    log(
      `zombie-db-reaper: failed to reap ${failed.length} holder(s): ${failed.join(
        ", "
      )} (DB open may still contend)`
    );
  }

  // Let the kernel finish tearing down the reaped processes (and release their
  // WAL locks) before the caller opens the DB, so the db-host does not race a
  // still-held lock.
  if (reaped.length > 0) {
    await waitForHoldersGone(reaped, deps, log);
  }

  return { reaped, failed, skippedRunning };
}
