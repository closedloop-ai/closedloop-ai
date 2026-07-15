import { fileURLToPath } from "node:url";
import electron from "electron";
import {
  type DbHostInitOptions,
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
  type DbHostUserIdentity,
  isDbHostResponse,
} from "./db-host-protocol.js";

const { utilityProcess } = electron;

const WORKER_STDIO: WorkerStdio = ["ignore", "ignore", "pipe"];
type WorkerStdio = ["ignore", "ignore", "pipe"];

// NOTE (exit-code-5 RCA, 2026-07): the child's `exit` code is the SIGNAL number
// when it dies to a native crash (measured on Electron 39: SIGTRAP→5, SIGABRT→6,
// SIGSEGV→11), so the recurring "exited (code: 5)" was a trapped native failure,
// NOT a V8 heap OOM — a real JS-heap OOM prints a FATAL ERROR banner on the
// piped stderr first. Root cause was `@libsql/client.transaction()` leaking one
// native connection per Prisma `$transaction` until fds/native memory ran out
// (fixed by patches/@libsql__client@0.17.3.patch). The `--max-old-space-size=12288`
// execArgv this file used to pass was measured to be a complete no-op in a
// utilityProcess (heap_size_limit stays at the ~4 GB pointer-compression cage
// regardless of the flag), so it was removed rather than left to mislead the
// next OOM investigation.
//
// Backoff before re-forking a crashed child, so a crash-on-start can't tight-loop.
const RESTART_BACKOFF_MS = 1000;
// FEA-3072 — crash-storm guard. When the child crashes (e.g. the exit-code-5
// native failure above) on a request the renderer polls (dashboard
// get-insights), a fixed 1 s backoff re-forks into the SAME slamming load and
// the process crashes again ~1×/s indefinitely. Escalate the backoff with the
// number of crashes seen inside a rolling window so a persistent crash degrades
// to widely-spaced retries (giving backfill/sync room to drain between reads)
// instead of a hot loop. Self-resets: once crashes age out of the window a lone
// crash restarts at the base backoff again.
const CRASH_WINDOW_MS = 60_000;
const MAX_RESTART_BACKOFF_MS = 30_000;
// Below this many crashes in the window, stay quiet (a one-off restart is normal).
const CRASH_STORM_THRESHOLD = 3;

/** Structural view of the forked utility process (also lets tests inject a fake). */
type DbHostProcess = {
  stderr?: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  } | null;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  postMessage(message: DbHostRequest): void;
  kill(): void;
};

type DbHostForkFn = (
  modulePath: string,
  args: string[],
  options: {
    serviceName: string;
    stdio: typeof WORKER_STDIO;
    execArgv?: string[];
  }
) => DbHostProcess;

type DbHostClientOptions = {
  /** Forwarded to the renderer as desktop:db:changed (child saw a mutation). */
  onEmit: (sessionId: string) => void;
  /**
   * A live SessionEnd hook drove a session terminal; the main process fires the
   * desktop completion Notification (gated on the flag). Optional so existing
   * call sites and tests that don't wire notifications stay unaffected.
   */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  /** Forwarded to the main-process logger. */
  onLog: (message: string) => void;
  /** Override the fork (tests). Defaults to electron utilityProcess.fork. */
  fork?: DbHostForkFn;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function rebuildError(response: DbHostResponse): Error {
  if (
    response.kind === DbHostResponseKind.Result ||
    response.kind === DbHostResponseKind.Ready
  ) {
    const error = new Error(response.error?.message ?? "db-host error");
    if (response.error?.stack) {
      error.stack = response.error.stack;
    }
    if (response.error?.name) {
      error.name = response.error.name;
    }
    return error;
  }
  return new Error("db-host error");
}

/**
 * Main-process transport to the DB host utilityProcess. Owns the child lifecycle,
 * correlates `invoke` requests to `result` responses by id, and surfaces the
 * child's `emit`/`log` notifications via callbacks. The typed SqliteAgentDatabase
 * proxy is built separately (db-host-proxy.ts) on top of `invoke`.
 */
export class DbHostClient {
  private child: DbHostProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly fork: DbHostForkFn;
  // Init options + identity are retained so a crashed child can be re-forked and
  // re-initialized transparently. `ready` is pending while (re)starting; invoke()
  // awaits it so in-flight calls queue across a restart instead of failing.
  private initOptions: DbHostInitOptions | null = null;
  private identity: DbHostUserIdentity = null;
  private ready: Promise<void> = Promise.resolve();
  private restarting = false;
  // FEA-3072 — timestamps of recent unexpected exits, pruned to CRASH_WINDOW_MS,
  // used to escalate the restart backoff during a crash storm.
  private readonly recentCrashes: number[] = [];

  constructor(private readonly options: DbHostClientOptions) {
    this.fork =
      options.fork ??
      ((modulePath, args, forkOptions) =>
        utilityProcess.fork(modulePath, args, forkOptions) as DbHostProcess);
  }

  /** Fork the child, apply migrations, and resolve once it reports ready. */
  start(init: DbHostInitOptions): Promise<void> {
    this.initOptions = init;
    this.identity = init.identity ?? null;
    this.ready = this.spawn(init);
    return this.ready;
  }

  /** Fork a child, wire it, send init, and (on re-spawn) re-apply identity. */
  private spawn(init: DbHostInitOptions): Promise<void> {
    const workerPath = fileURLToPath(
      new URL("./db-host-worker.js", import.meta.url)
    );
    const child = this.fork(workerPath, [], {
      serviceName: "closedloop-db-host",
      stdio: WORKER_STDIO,
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.options.onLog(`db-host stderr: ${chunk.toString("utf8").trim()}`);
    });
    child.on("message", (message) => this.handleMessage(message));
    child.on("exit", (code) => this.handleExit(code));

    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject });
      this.post({ kind: DbHostRequestKind.Init, id, options: init });
    }).then(() => {
      // Re-assert the cached identity on the fresh child after a restart.
      if (this.identity) {
        this.post({
          kind: DbHostRequestKind.SetUserIdentity,
          identity: this.identity,
        });
      }
    });
  }

  /** Run a DB operation in the child and await its serialized result. */
  invoke(op: string, args: unknown[]): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`db-host is closed (op: ${op})`));
    }
    // Wait for the current child to be ready — across a restart this queues the
    // call until the re-forked child has re-initialized, so the app self-heals
    // instead of surfacing transient "not running" errors to every caller.
    return this.ready.then(() => {
      if (!this.child) {
        throw new Error(`db-host is not running (op: ${op})`);
      }
      const id = this.nextId++;
      return new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.post({ kind: DbHostRequestKind.Invoke, id, op, args });
      });
    });
  }

  /** Push the current user identity so the child's sync getUserIdentity sees it. */
  setUserIdentity(identity: DbHostUserIdentity): void {
    this.identity = identity;
    if (this.closed || !this.child) {
      return;
    }
    this.post({ kind: DbHostRequestKind.SetUserIdentity, identity });
  }

  async close(): Promise<void> {
    if (this.closed || !this.child) {
      this.closed = true;
      return;
    }
    const id = this.nextId++;
    const child = this.child;
    await new Promise<void>((resolve) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject: () => resolve(),
      });
      this.post({ kind: DbHostRequestKind.Close, id });
    }).finally(() => {
      this.closed = true;
      child.kill();
    });
  }

  private post(request: DbHostRequest): void {
    this.child?.postMessage(request);
  }

  private handleMessage(message: unknown): void {
    if (!isDbHostResponse(message)) {
      return;
    }
    switch (message.kind) {
      case DbHostResponseKind.Emit:
        this.options.onEmit(message.sessionId);
        return;
      case DbHostResponseKind.SessionTerminal:
        this.options.onSessionTerminal?.({
          sessionId: message.sessionId,
          status: message.status,
        });
        return;
      case DbHostResponseKind.Log:
        this.options.onLog(message.message);
        return;
      case DbHostResponseKind.Ready: {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(rebuildError(message));
          return;
        }
        pending.resolve(undefined);
        return;
      }
      case DbHostResponseKind.Result: {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.value);
          return;
        }
        pending.reject(rebuildError(message));
        return;
      }
      default:
        return;
    }
  }

  private handleExit(code: number | null): void {
    const error = new Error(`db-host exited (code: ${code ?? "null"})`);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.child = null;
    if (this.closed) {
      return;
    }
    const backoffMs = this.registerCrashAndComputeBackoff();
    const crashesInWindow = this.recentCrashes.length;
    if (crashesInWindow >= CRASH_STORM_THRESHOLD) {
      this.options.onLog(
        `db-host crash storm: ${crashesInWindow} crashes in ${
          CRASH_WINDOW_MS / 1000
        }s (code: ${code ?? "null"}); backing off ${backoffMs}ms before restart`
      );
    } else {
      this.options.onLog(
        `db-host exited unexpectedly (code: ${code ?? "null"}); restarting in ${backoffMs}ms`
      );
    }
    this.scheduleRestart(backoffMs);
  }

  /**
   * Record this crash, prune crashes older than the rolling window, and return
   * the backoff to use before the next restart: base backoff doubled per crash
   * still inside the window, capped at MAX_RESTART_BACKOFF_MS. Self-resets to the
   * base once the window empties (a lone crash → base backoff).
   */
  private registerCrashAndComputeBackoff(): number {
    const now = Date.now();
    this.recentCrashes.push(now);
    while (
      this.recentCrashes.length > 0 &&
      now - this.recentCrashes[0] > CRASH_WINDOW_MS
    ) {
      this.recentCrashes.shift();
    }
    const exponent = Math.min(this.recentCrashes.length - 1, 5);
    return Math.min(RESTART_BACKOFF_MS * 2 ** exponent, MAX_RESTART_BACKOFF_MS);
  }

  /**
   * Re-fork + re-initialize the child after an unexpected exit (e.g. an OOM
   * during a heavy backfill). `ready` stays pending until a restart attempt
   * succeeds, so queued invoke() calls resume against the fresh child; failed
   * attempts retry with backoff. The on-disk DB persists, so committed data
   * survives the crash.
   */
  private scheduleRestart(backoffMs: number): void {
    if (this.closed || this.child || this.restarting || !this.initOptions) {
      return;
    }
    this.restarting = true;
    const init = this.initOptions;
    this.ready = new Promise<void>((resolve) => {
      const attempt = (): void => {
        if (this.closed) {
          resolve();
          return;
        }
        this.spawn(init).then(
          () => {
            this.restarting = false;
            resolve();
          },
          (spawnError: unknown) => {
            this.child = null;
            this.options.onLog(
              `db-host restart failed, retrying: ${
                spawnError instanceof Error
                  ? spawnError.message
                  : String(spawnError)
              }`
            );
            setTimeout(attempt, backoffMs);
          }
        );
      };
      setTimeout(attempt, backoffMs);
    });
  }
}
