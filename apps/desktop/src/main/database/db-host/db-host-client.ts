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

// V8 old-space ceiling for the child, which holds the DB + the import/sync
// working set + reader snapshots during a large from-scratch backfill. This is a
// LAZY ceiling (V8 only grows the heap on demand — it does not reserve the
// memory up front), so a generous limit just raises the OOM threshold without
// pre-allocating. 8 GB was still being exceeded (exit code 5) when the backfill,
// the cloud-sync payload build, and dashboard reads peak together; 12 GB clears
// that with comfortable headroom on typical (≥16 GB) machines. The read-path
// bounding (omitEventData) + WAL checkpointing + smaller reader pool reduce the
// peak; this raises the ceiling above it. Crashes still auto-restart below.
const WORKER_EXEC_ARGV = ["--max-old-space-size=12288"];
// Backoff before re-forking a crashed child, so a crash-on-start can't tight-loop.
const RESTART_BACKOFF_MS = 1000;

/** Structural view of the forked utility process (also lets tests inject a fake). */
export type DbHostProcess = {
  stderr?: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  } | null;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  postMessage(message: DbHostRequest): void;
  kill(): void;
};

export type DbHostForkFn = (
  modulePath: string,
  args: string[],
  options: {
    serviceName: string;
    stdio: typeof WORKER_STDIO;
    execArgv?: string[];
  }
) => DbHostProcess;

export type DbHostClientOptions = {
  /** Forwarded to the renderer as desktop:db:changed (child saw a mutation). */
  onEmit: (sessionId: string) => void;
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
      execArgv: WORKER_EXEC_ARGV,
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
    this.options.onLog(
      `db-host exited unexpectedly (code: ${code ?? "null"}); restarting`
    );
    this.scheduleRestart();
  }

  /**
   * Re-fork + re-initialize the child after an unexpected exit (e.g. an OOM
   * during a heavy backfill). `ready` stays pending until a restart attempt
   * succeeds, so queued invoke() calls resume against the fresh child; failed
   * attempts retry with backoff. The on-disk DB persists, so committed data
   * survives the crash.
   */
  private scheduleRestart(): void {
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
            setTimeout(attempt, RESTART_BACKOFF_MS);
          }
        );
      };
      setTimeout(attempt, RESTART_BACKOFF_MS);
    });
  }
}
