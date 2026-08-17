import { fileURLToPath } from "node:url";
import electron from "electron";
import { DbHostExitError } from "../../../shared/db-host-exit-error.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
  isGracefulDbHostExitCode,
} from "../../../shared/db-host-shutdown-error.js";
import { exponentialBackoffMs } from "../../../shared/exponential-backoff.js";
import type {
  ScheduledReviewRequest,
  ScheduledReviewResult,
} from "../../../shared/scheduled-review-contract.js";
import {
  DesktopMigrationError,
  toMigrationRefusalKind,
} from "../../lifecycle/migration-refusal.js";
import type { DbHostExitDiagnostics } from "../../telemetry/telemetry-protocol.js";
import { sameUserIdentity } from "../../util/user-identity.js";
import { isBackgroundDbRead } from "./db-host-call-priority.js";
import { describeUnexpectedDbHostExit } from "./db-host-exit-log.js";
import { MemoryPressureLevel } from "./db-host-memory-watchdog.js";
import {
  type DbHostCloseRequest,
  DbHostDataCloneError,
  type DbHostInitOptions,
  type DbHostInitRequest,
  type DbHostInvokeRequest,
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
  type DbHostUserIdentity,
  isDbHostResponse,
  serializeDbHostError,
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
// ISS-4823 — how long a published db-host memory-pressure level stays actionable.
// The child republishes "high" on EVERY heap-watchdog sample (default 2s), so
// three sample intervals tolerates a couple of missed/late ticks under load while
// still aging out a level nobody is refreshing within a few seconds. See
// DbHostClient.isUnderMemoryPressure for why staleness must read as "not under
// pressure" rather than as continued pressure.
const DB_HOST_MEMORY_PRESSURE_STALE_MS = 6000;
// ISS-4713 — bounded shutdown drain. On quit, close() first lets the in-flight
// db-host ops (outbox-clear + sync writes) settle so their SQLite work commits
// cleanly instead of being force-killed mid-write. The drain is bounded so a
// slow/wedged lane can never hold shutdown past this budget — after it elapses
// close() proceeds to send Close + kill the child anyway. Sized to sit well
// under the shutdown-lifecycle hard-exit fallback (8s) so a clean db-host close
// finishes before the outer app.exit(1) can force-kill the utilityProcess.
const CLOSE_DRAIN_TIMEOUT_MS = 2000;
// ISS-4713 — bound the Close-acknowledgement + kill path too. The worker's Close
// handler awaits `agentDatabase.close()` (which drains its own write queue) BEFORE
// posting the Close reply, so a write wedged in the child would otherwise leave
// this promise pending forever and `child.kill()` would never run — the child
// would linger until the separate 8s shutdown-lifecycle watchdog force-exits the
// whole app. Racing the reply against this budget guarantees we always fall
// through to kill the child. Sized to sit (together with the drain budget) under
// that 8s hard-exit fallback so a clean close still finishes first.
const CLOSE_ACK_TIMEOUT_MS = 2000;

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

/**
 * How the client forks its utility process. Exported so the owning lifecycle
 * (`agent-dashboard-db-host-lifecycle.ts`) can re-expose the same seam and a
 * behavioral test can drive a real unexpected exit through the REAL wiring
 * instead of pinning that wiring by reading source text (ISS-5715 review).
 */
export type DbHostForkFn = (
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
   * ISS-5715 — an unexpected child exit, for the TELEMETRY path. `onLog` alone
   * never leaves the machine, and every consumer that dies with the child
   * (collectors, transcript sync, the Sessions read path) fails invisibly to the
   * user. Optional so existing call sites and tests stay unaffected.
   *
   * Wiring this makes the exit queryable in Datadog; it does not by itself make
   * it page. The companion `datadog_monitor` lives in `cl-tofu-aws-live` — see
   * the scope note in `telemetry/db-host-exit-telemetry.ts`.
   *
   * "Unexpected" is exactly the branch `handleExit` restarts from: the client
   * was neither `closing` nor `closed`, so nobody asked the child to stop. The
   * payload is the WIRE type, imported rather than re-declared (matching
   * `store-integrity-probe.ts`) so the producer and the telemetry contract
   * cannot drift — an extra field here would otherwise compile and then be
   * silently stripped on the wire.
   */
  onUnexpectedExit?: (event: DbHostExitDiagnostics) => void;
  /**
   * A live SessionEnd hook drove a session terminal; the main process fires the
   * desktop completion Notification (gated on the flag). Optional so existing
   * call sites and tests that don't wire notifications stay unaffected.
   */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  /** Forwarded to the main-process logger. */
  onLog: (message: string) => void;
  /**
   * FEA-3814 (PRD-553 M2): the crewd scheduler in the child changed its tasks or
   * runs; main forwards desktop:scheduled-tasks:changed to the renderer. Optional
   * so existing call sites/tests that don't wire it stay unaffected.
   */
  onSchedulerChanged?: () => void;
  /**
   * FEA-4143: run a scheduled review the child's daemon dispatch proxied to main.
   * Composed through the on-demand AuditService (throwaway workspace + main-side
   * credentials). Optional so existing call sites/tests that don't wire it stay
   * unaffected — an unwired handler replies with a typed failure so the child's
   * dispatch records a clean run status instead of hanging.
   */
  onRunScheduledReview?: (
    request: ScheduledReviewRequest
  ) => Promise<ScheduledReviewResult>;
  /** Override the fork (tests). Defaults to electron utilityProcess.fork. */
  fork?: DbHostForkFn;
  /**
   * ISS-4713 — override the timer used to bound the shutdown drain (tests drive
   * it with mock timers). Defaults to global setTimeout/clearTimeout.
   */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * ISS-4823 — clock backing the memory-pressure staleness bound. Injectable so
   * the staleness behavior is pinned with a controlled clock instead of a
   * wall-clock wait (see the desktop `test:node` determinism rule). Defaults to
   * `Date.now`.
   */
  now?: () => number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * True when `request`'s `id` was allocated from `DbHostClient.nextId` into the
 * `pending` map — i.e. Init, Invoke, or Close. Those are the only kinds a
 * main-side correlated lookup (`this.pending.get(id)`) may consult. A
 * ScheduledReviewResult also has an `id`, but it is the CHILD's reverse-RPC id
 * (a separate counter), so it must NOT be correlated through this map;
 * SetUserIdentity has no `id`.
 */
function isPendingCorrelatedRequest(
  request: DbHostRequest
): request is DbHostInitRequest | DbHostInvokeRequest | DbHostCloseRequest {
  return (
    request.kind === DbHostRequestKind.Init ||
    request.kind === DbHostRequestKind.Invoke ||
    request.kind === DbHostRequestKind.Close
  );
}

function rebuildError(response: DbHostResponse): Error {
  if (
    response.kind === DbHostResponseKind.Result ||
    response.kind === DbHostResponseKind.Ready
  ) {
    const message = response.error?.message ?? "db-host error";
    // ISS-4714: a migration refusal thrown in the DB-host child loses its
    // prototype (and so its `kind`) crossing the structured-clone boundary. When
    // the serialized error carried a validated refusal kind, rebuild the typed
    // `DesktopMigrationError` so main-side classification (`isDbAheadOfAppError`)
    // still fires in production — not just in the in-process test.
    const refusalKind = toMigrationRefusalKind(response.error?.refusalKind);
    const error =
      refusalKind === null
        ? new Error(message)
        : new DesktopMigrationError(refusalKind, message);
    if (response.error?.stack) {
      error.stack = response.error.stack;
    }
    // A rebuilt DesktopMigrationError already carries name "DesktopMigrationError";
    // only override for the plain-Error path so a serialized custom name survives.
    if (refusalKind === null && response.error?.name) {
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
  // ISS-4713 — settle signals for every invoke ACCEPTED (passed the closed
  // check) but not yet finished, tracked from call entry BEFORE the async
  // `ready.then(...)` continuation registers it in `pending`. The shutdown drain
  // awaits this set so an invoke that is still queued on `ready` when close()
  // runs is drained too — closing the race where a late readiness continuation
  // would otherwise post its request into a child that is concurrently closing.
  // Each promise removes itself on settle, so the set stays bounded.
  private readonly inFlightInvokes = new Set<Promise<void>>();
  private closed = false;
  // ISS-4713 — set SYNCHRONOUSLY at the top of close(), BEFORE any drain await,
  // so a db-host `exit` that lands during the intentional shutdown drain is
  // treated as expected: handleExit() must NOT relabel it "unexpected" and must
  // NOT schedule a restart mid-shutdown. `closed` alone is insufficient because
  // it is also true after close() finishes — `closing` marks the intentional
  // teardown window specifically. Kept distinct from `closed` so existing
  // closed-gated paths are unchanged.
  private closing = false;
  private readonly fork: DbHostForkFn;
  // Init options + identity are retained so a crashed child can be re-forked and
  // re-initialized transparently. `ready` is pending while (re)starting; invoke()
  // awaits it so in-flight calls queue across a restart instead of failing.
  private initOptions: DbHostInitOptions | null = null;
  private identity: DbHostUserIdentity = null;
  private ready: Promise<void> = Promise.resolve();
  private restarting = false;
  // ISS-4474 — handle of the pending restart-backoff timer, tracked so close()
  // can cancel a superseded restart instead of leaving a timer to fire against a
  // closed client.
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  // ISS-4474 — resolver of the current `ready` promise while a restart is in
  // flight. clearing the restart timer removes the only callback that would
  // otherwise resolve `ready`, so close() (or any timer cancel during shutdown)
  // must settle it here — otherwise an invoke() already awaiting `ready` hangs
  // forever. Null whenever no restart is pending (ready is already settled).
  private resolveReady: (() => void) | null = null;
  // FEA-3072 — timestamps of recent unexpected exits, pruned to CRASH_WINDOW_MS,
  // used to escalate the restart backoff during a crash storm.
  private readonly recentCrashes: number[] = [];
  // ISS-5715 — the most recent backoff the crash ladder computed. A restart
  // attempt captures the backoff it was scheduled with, so an attempt that has
  // to re-arm itself (the Ready-then-exit window below) would otherwise retry
  // forever at the delay of the FIRST crash, defeating FEA-3072's escalation and
  // reinstating the hot loop it exists to prevent. handleExit refreshes this on
  // every unexpected exit, so the re-arm always waits the escalated delay.
  private latestRestartBackoffMs = RESTART_BACKOFF_MS;
  // ISS-5715 — correlation id of the current child's Init handshake, so an exit
  // can tell the restart's own bookkeeping apart from real caller work when it
  // reports how many ops it dropped. Null whenever no Init is outstanding.
  private initRequestId: number | null = null;
  // ISS-4713 — timers, injectable so the shutdown-drain test can drive the
  // bounded budget with mock timers instead of a wall-clock wait.
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  // ISS-4823 — most recent memory-pressure level published by the child, with
  // the local receipt time so `isUnderMemoryPressure` can age it out. Null until
  // the first publication and again after the child exits.
  private lastMemoryPressure: {
    level: MemoryPressureLevel;
    atMs: number;
  } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: DbHostClientOptions) {
    this.fork =
      options.fork ??
      ((modulePath, args, forkOptions) =>
        utilityProcess.fork(modulePath, args, forkOptions) as DbHostProcess);
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * ISS-4823 — is the DB host currently under memory pressure? Synchronous by
   * design: the DATA_REVISION rebuild's adaptive write-pause gate is consulted
   * once per session write and cannot await a round trip (and a callback could
   * not cross the method proxy anyway), so the child PUBLISHES its level and this
   * answers from the cached value.
   *
   * Fails safe to `false` — "no evidence of pressure" — in every uncertain case:
   * before the first publication, after the child exits, and once the last
   * `"high"` has aged past {@link DB_HOST_MEMORY_PRESSURE_STALE_MS}. A stale
   * `"high"` means nobody is refreshing it (a crashed or wedged worker), and
   * treating that as live pressure would make the rebuild pay the full 50ms
   * per-write pause indefinitely — reintroducing the multi-hour drain ISS-4711
   * removed. Under-reporting only costs back-pressure the pre-ISS-4711 code
   * never had here; over-reporting costs the user hours.
   */
  isUnderMemoryPressure(): boolean {
    const last = this.lastMemoryPressure;
    if (last === null || last.level !== MemoryPressureLevel.High) {
      return false;
    }
    // `now` is wall-clock (Date.now), which can step BACKWARD across an NTP
    // correction or a manual clock change. A negative age would then read as
    // "well inside the freshness window" and pin a stale `"high"` until wall
    // time caught back up — the exact indefinite full-pause this guard exists to
    // prevent. A negative age means the sample cannot be dated against the
    // current clock, so it is treated as stale, matching the fail-safe-to-false
    // rule documented above.
    const ageMs = this.now() - last.atMs;
    return ageMs >= 0 && ageMs < DB_HOST_MEMORY_PRESSURE_STALE_MS;
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
    this.initRequestId = id;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject });
      this.post({ kind: DbHostRequestKind.Init, id, options: init });
    }).then(() => {
      this.initRequestId = null;
      // ISS-6243: compare against the identity the child actually OPENED with,
      // not against null. A sign-out that lands while the Init handshake is in
      // flight leaves `this.identity` null while the child holds the previous
      // user — gating on `if (this.identity)` skips the correction on exactly
      // that boot and every session the child writes is attributed to the
      // signed-out account. The pair predicate also makes an org switch mid-
      // handshake a real transition rather than a same-user no-op.
      if (!sameUserIdentity(init.identity ?? null, this.identity)) {
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
      // ISS-5262: same message, classifiable class — this is the rejection that
      // surfaced as `ipc perf session_count query failed: db-host is closed
      // (op: sessions.count)` after the shutdown sequence reported clean.
      return Promise.reject(
        new DbHostShutdownError(
          DbHostShutdownReason.Closed,
          `db-host is closed (op: ${op})`
        )
      );
    }
    // ISS-4713 — expose a settle signal for the shutdown drain, created and
    // TRACKED SYNCHRONOUSLY here (before the async `ready.then(...)` below), so
    // an invoke accepted just before close() is drained even while it is still
    // queued on `ready` and has not yet registered in `pending`. `settled`
    // resolves whichever way the invoke lands (result, rejection, or a shutdown
    // that arrived while it was queued) so close() can await the in-flight write
    // tail before killing the child. The entry removes itself from the set on
    // settle, keeping it bounded.
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolveSettled) => {
      markSettled = resolveSettled;
    });
    this.inFlightInvokes.add(settled);
    const finishSettled = (): void => {
      markSettled();
      this.inFlightInvokes.delete(settled);
    };
    // Wait for the current child to be ready — across a restart this queues the
    // call until the re-forked child has re-initialized, so the app self-heals
    // instead of surfacing transient "not running" errors to every caller.
    return this.ready.then(() => {
      // Shutdown may have begun WHILE this call was queued on `ready`. Re-check
      // so a late continuation never posts a fresh Invoke into a child the drain
      // has already accounted for and close() is about to Close/kill — the
      // race the shutdown drain exists to prevent. Settling here releases the
      // tracked entry so drainInFlight() doesn't wait on an op we never sent.
      if (this.closed || this.closing) {
        finishSettled();
        // ISS-5262: classifiable, message unchanged (see the `closed` branch).
        throw new DbHostShutdownError(
          DbHostShutdownReason.Closing,
          `db-host is closing (op: ${op})`
        );
      }
      if (!this.child) {
        finishSettled();
        throw new Error(`db-host is not running (op: ${op})`);
      }
      const id = this.nextId++;
      return new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) => {
            finishSettled();
            resolve(value);
          },
          reject: (error) => {
            finishSettled();
            reject(error);
          },
        });
        // ISS-6079: the field is OMITTED unless this call is running inside a
        // background scope. Omission (not `background: false`) keeps the wire
        // shape byte-identical for every interactive call, which is both the
        // repo's optional-field convention and what makes a version-skewed
        // child — one that has never heard of the field — behave exactly as it
        // does today.
        this.post(
          isBackgroundDbRead()
            ? { kind: DbHostRequestKind.Invoke, id, op, args, background: true }
            : { kind: DbHostRequestKind.Invoke, id, op, args }
        );
      });
    });
  }

  /**
   * @internal Number of correlated requests still awaiting a reply. Exposed for
   * regression tests that must prove the correlation map is actually cleaned up
   * (e.g. after a clone-failure rejection); production code never reads it.
   */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

  /** Push the current user identity so the child's sync getUserIdentity sees it. */
  setUserIdentity(identity: DbHostUserIdentity): void {
    this.identity = identity;
    // ISS-6243: keep the RETAINED init options in lockstep, so a restart forks
    // the replacement child with the CURRENT identity rather than resurrecting
    // a signed-out user and stamping their id on every session it goes on to
    // create. Harmless before this identity could change after boot;
    // load-bearing now that it can.
    if (this.initOptions) {
      this.initOptions = { ...this.initOptions, identity };
    }
    if (this.closed || !this.child) {
      return;
    }
    this.post({ kind: DbHostRequestKind.SetUserIdentity, identity });
  }

  /**
   * ISS-4713 — mark the intentional-shutdown window OPEN, synchronously, before
   * the app tears down the capture/sync services that still drive db-host ops.
   * From this point a child `exit` (its own crash, an OS kill, or the eventual
   * clean Close) is treated as expected: handleExit() will not relabel it
   * "unexpected" and will not schedule a restart mid-shutdown. Idempotent and
   * safe to call before close(); close() also sets this flag as a backstop for
   * callers that never invoke beginClosing().
   */
  beginClosing(): void {
    this.closing = true;
    // Cancel any in-flight restart backoff so a bounce that is still in its
    // backoff window when shutdown begins cannot re-fork against a client that
    // is about to close.
    this.clearRestartTimer();
  }

  async close(): Promise<void> {
    // ISS-4474: mark shutdown SYNCHRONOUSLY before anything can await, so an
    // in-flight spawn() that rejects (its retry branch) or a restart attempt that
    // fires observes `closed` and does not re-arm a timer / re-fork after close.
    // ISS-4713: also set `closing` here — BEFORE the drain await below can yield
    // — so a child `exit` during the intentional teardown is not relabeled
    // "unexpected" or restarted by handleExit().
    const alreadyClosed = this.closed;
    this.closed = true;
    this.closing = true;
    // Cancel any pending restart-backoff timer so a bounce that is mid-backoff
    // when we close doesn't fire a re-fork against a closed client. This also
    // settles the pending `ready` promise so an invoke() awaiting it doesn't hang.
    this.clearRestartTimer();
    if (alreadyClosed || !this.child) {
      return;
    }
    // ISS-4713: no new invoke() will be accepted (closed is set), so let the
    // in-flight db-host writes (outbox-clear + sync) settle within a bounded
    // budget before we send Close + kill. This is what makes the shutdown drain
    // clean: those SQLite writes commit instead of being force-killed mid-write
    // (the `failed to clear N acked outbox row(s): db-host exited` /
    // `sync failed: db-host exited` corruption symptom). The budget guarantees a
    // slow/wedged lane can NOT hold shutdown open past CLOSE_DRAIN_TIMEOUT_MS.
    await this.drainInFlight();
    // The child may have exited during the drain (its own crash, or the OS). If
    // so there is nothing left to Close/kill — bail without re-posting.
    const child = this.child;
    if (!child) {
      return;
    }
    const id = this.nextId++;
    const acknowledged = new Promise<void>((resolve) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject: () => resolve(),
      });
      this.post({ kind: DbHostRequestKind.Close, id });
    });
    // Bound the wait for the Close reply: the worker drains its own write queue
    // before acknowledging, so a wedged child would never reply. On timeout we
    // drop the parked pending entry and proceed to kill anyway — the `.finally`
    // below always runs child.kill(), so the child can never linger past this
    // budget waiting on the outer 8s hard-exit fallback.
    await this.raceCloseAck(id, acknowledged).finally(() => {
      // `closed` is already set synchronously at the top of close().
      child.kill();
    });
  }

  /**
   * ISS-4713 — resolve when the child acknowledges Close OR the
   * CLOSE_ACK_TIMEOUT_MS budget elapses, whichever comes first. On timeout the
   * still-parked Close pending entry is removed so a late reply (if the child
   * ever posts one) can't resolve a stale promise, and the drain timer is always
   * cleared on the winning branch so neither path leaks a timer.
   */
  private raceCloseAck(id: number, acknowledged: Promise<void>): Promise<void> {
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const budget = new Promise<void>((resolve) => {
      ackTimer = this.setTimeoutFn(() => {
        this.pending.delete(id);
        this.options.onLog(
          `db-host Close acknowledgement not received within ${CLOSE_ACK_TIMEOUT_MS}ms; killing child anyway`
        );
        resolve();
      }, CLOSE_ACK_TIMEOUT_MS);
    });
    return Promise.race([acknowledged, budget]).finally(() => {
      if (ackTimer != null) {
        this.clearTimeoutFn(ackTimer);
      }
    });
  }

  /**
   * ISS-4713 — await the in-flight Invoke tail so their SQLite writes commit
   * before the child is closed/killed, bounded by CLOSE_DRAIN_TIMEOUT_MS so a
   * slow or wedged lane can never hold shutdown open. Resolves when either every
   * in-flight invoke has settled OR the budget elapses (whichever comes first);
   * the drain timer is always cleared on the winning branch so a settled drain
   * leaves no dangling timer (and vice-versa). Only Invoke calls join
   * `inFlightInvokes`, so Init/Close never appear here — only real DB writes are
   * drained. The set is tracked from invoke() call entry (not from `pending`
   * registration), so an invoke still queued on `ready` when close() runs is
   * awaited too — that late continuation then observes `closing` and settles
   * without ever posting into the closing child.
   */
  private async drainInFlight(): Promise<void> {
    const inFlight = [...this.inFlightInvokes];
    if (inFlight.length === 0) {
      return;
    }
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const budget = new Promise<void>((resolve) => {
      drainTimer = this.setTimeoutFn(() => {
        this.options.onLog(
          `db-host shutdown drain hit its ${CLOSE_DRAIN_TIMEOUT_MS}ms budget with ${inFlight.length} op(s) still in flight; proceeding to close`
        );
        resolve();
      }, CLOSE_DRAIN_TIMEOUT_MS);
    });
    try {
      await Promise.race([Promise.all(inFlight).then(() => undefined), budget]);
    } finally {
      if (drainTimer != null) {
        this.clearTimeoutFn(drainTimer);
      }
    }
  }

  /**
   * Send a request to the child. `child.postMessage` uses the structured-clone
   * algorithm, so a non-cloneable payload (a function, class instance, `Error`,
   * or — the ISS-4620 crash — the DB-host method proxy reached into an invoke's
   * `args`) makes it THROW SYNCHRONOUSLY. That throw fires inside the
   * `new Promise` executor in invoke()/spawn()/close(); left unhandled it escapes
   * the executor as a thrown exception on the initial dashboard-load path and
   * popped the fatal "unexpected error" dialog that terminated the app.
   *
   * ISS-4620 — fail-safe: catch the clone failure HERE so it never escapes the
   * executor as a synchronous throw. What the catch guarantees is that the app
   * keeps running: the request's OWN correlated pending promise (by `id`) is
   * cleaned up and rejected with the typed {@link DbHostDataCloneError}, so the
   * caller's existing `.catch`/degrade path can recover. It does NOT, by itself,
   * make every downstream rejection "handled" — a caller that drops the returned
   * promise without a `.catch` can still surface an unhandled rejection; keeping
   * that promise handled is the caller's responsibility, as with any invoke().
   * The root cause is still fixed at the source — this is the safety net that
   * keeps a future non-cloneable payload a handled failure rather than a fatal
   * synchronous crash.
   */
  private post(request: DbHostRequest): void {
    try {
      this.child?.postMessage(request);
    } catch (error) {
      this.handlePostFailure(request, error);
    }
  }

  private handlePostFailure(request: DbHostRequest, error: unknown): void {
    const op =
      request.kind === DbHostRequestKind.Invoke ? request.op : request.kind;
    const cloneError = new DbHostDataCloneError(op, error);
    // Only requests whose `id` was allocated from `this.nextId` INTO `this.pending`
    // (Init, Invoke, Close) may be correlated through the pending map. A
    // ScheduledReviewResult carries the CHILD's reverse-RPC id (minted by the
    // worker's independent `nextScheduledReviewId` counter, not `this.nextId`), so
    // looking it up here would collide with — and wrongly delete/reject — an
    // unrelated in-flight Init/Invoke/Close entry. SetUserIdentity has no `id` at
    // all. Both non-correlated kinds take the log/degrade path below.
    const id = isPendingCorrelatedRequest(request) ? request.id : undefined;
    const pending = id === undefined ? undefined : this.pending.get(id);
    if (pending && id !== undefined) {
      this.pending.delete(id);
      pending.reject(cloneError);
      return;
    }
    // No correlated pending promise to carry the rejection (a SetUserIdentity
    // push, or a ScheduledReviewResult reply whose id belongs to the child): log
    // and degrade rather than throw so an un-cloneable identity/notification/reply
    // can never crash the app. A dropped ScheduledReviewResult leaves the child's
    // pendingScheduledReviews entry parked until its own timeout/generation guard
    // clears it — never mis-resolving a main-side request.
    this.options.onLog(cloneError.message);
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
      case DbHostResponseKind.SchedulerChanged:
        this.options.onSchedulerChanged?.();
        return;
      case DbHostResponseKind.MemoryPressure:
        this.lastMemoryPressure = {
          level: message.level,
          atMs: this.now(),
        };
        return;
      case DbHostResponseKind.ScheduledReviewRun:
        this.handleScheduledReviewRun(
          message.id,
          message.generation,
          message.request
        );
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

  /**
   * FEA-4143 — run a scheduled review the child proxied to main, then post the
   * correlated reply back to the child. An unwired handler (or a throw) is
   * reported as a structured failure so the child's dispatch records a clean
   * `failed` run instead of hanging on a reply that never comes.
   *
   * Tzqf1 — `generation` is the originating worker's token; main is stateless
   * w.r.t. it and echoes it back verbatim on the reply. The audit can outlive a
   * DB-host crash, so this reply may reach a re-forked replacement child; the
   * echoed generation lets that child drop a result that isn't its own instead
   * of mis-resolving an unrelated same-`id` review.
   */
  private handleScheduledReviewRun(
    id: number,
    generation: string,
    request: ScheduledReviewRequest
  ): void {
    const run =
      this.options.onRunScheduledReview ??
      (() => Promise.reject(new Error("scheduled review runner not wired")));
    run(request).then(
      (value) =>
        this.post({
          kind: DbHostRequestKind.ScheduledReviewResult,
          id,
          generation,
          ok: true,
          value,
        }),
      (error: unknown) =>
        this.post({
          kind: DbHostRequestKind.ScheduledReviewResult,
          id,
          generation,
          ok: false,
          error: serializeDbHostError(error),
        })
    );
  }

  private handleExit(code: number | null): void {
    // ISS-5262: the message is unchanged on BOTH branches — an already-installed
    // build, a serialized child error, and every existing test still see
    // `db-host exited (code: N)`. Only the CLASS differs, and only when the exit
    // is both intentional (`closing`/`closed`) and graceful. A non-zero code is
    // a crash-signal number even during teardown (see the exit-code-5 RCA at the
    // top of this file), so it keeps the plain Error and stays loud.
    const isExpectedShutdownExit =
      (this.closed || this.closing) && isGracefulDbHostExitCode(code);
    const message = `db-host exited (code: ${code ?? "null"})`;
    // ISS-5715: counted BEFORE the map is drained — how many correlated ops died
    // with the child, reported on the monitored path below. The Init handshake is
    // EXCLUDED: a child that dies during (re)start has only its own Init parked in
    // `pending`, and counting that would report a blast radius of 1 for an exit
    // that dropped no caller work at all. This number is read as "ingestion/read
    // work lost", so it must never be inflated by the restart's own bookkeeping.
    const initStillPending =
      this.initRequestId !== null && this.pending.has(this.initRequestId);
    const rejectedOps = Math.max(
      0,
      this.pending.size - (initStillPending ? 1 : 0)
    );
    // ISS-5808: the abandoned ops are DETACHED here but rejected LAST, after the
    // restart ladder has been armed below. Two reasons, both load-bearing:
    //  - the rejection must carry whether a replacement is actually coming
    //    (`DbHostExitError.restartScheduled`), which is only knowable after
    //    scheduleRestart() has run;
    //  - a consumer re-driving the op in its rejection handler must find the
    //    NEW pending `ready` promise already installed, so its retry queues
    //    behind the replacement child instead of racing a stale settled one.
    // Detaching first keeps the map empty for the whole restart bookkeeping, so
    // a re-entrant post can never observe a half-drained map.
    const abandoned = [...this.pending.values()];
    this.pending.clear();
    this.initRequestId = null;
    this.child = null;
    // ISS-4823: a dead worker publishes nothing, so a "high" it left behind
    // describes a process that no longer exists. Drop it rather than let the
    // rebuild keep throttling against a stale reading until the staleness bound
    // expires — the replacement worker republishes within one sample interval.
    this.lastMemoryPressure = null;
    // ISS-4713: an exit during an INTENTIONAL shutdown (`closing` set by
    // beginClosing()/close(), before the async teardown could yield) is expected
    // — do NOT log it as "unexpected" and do NOT schedule a restart mid-shutdown.
    // `closed` is checked too so a completed close() keeps its existing behavior;
    // `closing` additionally covers the window between shutdown-start and the
    // point close() flips `closed`.
    if (this.closed || this.closing) {
      rejectAll(
        abandoned,
        isExpectedShutdownExit
          ? new DbHostShutdownError(DbHostShutdownReason.Exited, message)
          : new Error(message)
      );
      return;
    }
    const backoffMs = this.registerCrashAndComputeBackoff();
    this.latestRestartBackoffMs = backoffMs;
    const crashesInWindow = this.recentCrashes.length;
    // ISS-5715: scheduleRestart() is a NO-OP while an earlier attempt is still
    // in flight (the `restarting` sentinel), so naming a delay would describe a
    // timer that was never armed — the log that made this bug invisible. Both
    // branches' wording lives in one tested helper so they cannot drift apart
    // again; the in-flight attempt's own continuation re-arms.
    const restartAlreadyInFlight = this.restarting;
    this.options.onLog(
      describeUnexpectedDbHostExit({
        code,
        crashesInWindow,
        backoffMs,
        crashWindowMs: CRASH_WINDOW_MS,
        restartAlreadyInFlight,
      })
    );
    // ISS-5715: an unexpected db-host exit takes out ingestion (collectors,
    // transcript sync) and the read path together, and none of those consumers
    // is user-visible — the local log above never leaves the machine, so route
    // it to the telemetry path as well, where it becomes a queryable Datadog
    // facet. `rejectedOps` is the size of the blast radius: every one of those
    // calls was abandoned mid-flight and is NOT replayed by this client.
    this.options.onUnexpectedExit?.({
      exitCode: code,
      crashesInWindow,
      backoffMs,
      rejectedOps,
      restartAlreadyInFlight,
    });
    this.scheduleRestart();
    // ISS-5808: `restarting` is the supervisor's own answer to "is a replacement
    // coming?" — true when this call armed the ladder AND when an earlier
    // attempt is still in flight (scheduleRestart() no-ops on that sentinel but
    // the in-flight attempt's continuation re-arms). False only when the ladder
    // genuinely cannot recover, e.g. start() was never called so there are no
    // init options to re-fork with. Consumers gate their re-drive on this, so it
    // must never assert a recovery that was not scheduled — the same class of
    // lie the ISS-5715 log line carried.
    rejectAll(abandoned, new DbHostExitError(code, this.restarting, message));
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
    // ISS-5808: on the SHARED ladder (`exponentialBackoffMs`), not a hand-rolled
    // `BASE * 2 ** n`. The sync-lane contract (`main/sync/AGENTS.md`, invariant
    // 5) requires every bounded retry path in the desktop to back off on that
    // one helper precisely so copies cannot drift; this supervisor was the last
    // hand-rolled ladder left. Behaviour is unchanged — the helper is 1-indexed
    // and `recentCrashes.length` is the 1-indexed crash number, and its own
    // exponent clamp sits far above the point `MAX_RESTART_BACKOFF_MS` binds.
    return exponentialBackoffMs(
      this.recentCrashes.length,
      RESTART_BACKOFF_MS,
      MAX_RESTART_BACKOFF_MS
    );
  }

  /**
   * ISS-5715 — arm (or re-arm) the restart ladder's backoff timer.
   *
   * The one owner of "schedule the next attempt". Three call sites previously
   * inlined this, and they had already drifted: two passed the backoff captured
   * when the ladder STARTED, so a retry after a crash storm waited the delay of
   * the FIRST crash and defeated FEA-3072's escalation. Reading
   * {@link latestRestartBackoffMs} here means every site waits the delay the
   * ladder most recently computed. handleExit() refreshes that field
   * immediately before calling scheduleRestart(), so the initial arm is
   * unchanged; only the two RETRY sites were wrong.
   *
   * Also re-asserts `restarting`, which the spawn-resolve re-arm must restore
   * (its continuation cleared it one line earlier) and which the other sites
   * already hold — so the sentinel can never be left false with a timer armed.
   */
  private armRestartTimer(attempt: () => void): void {
    this.restarting = true;
    this.restartTimer = this.setTimeoutFn(attempt, this.latestRestartBackoffMs);
  }

  /**
   * ISS-5715: takes no backoff argument — {@link armRestartTimer} reads
   * {@link latestRestartBackoffMs}, which handleExit() refreshes before every
   * call, so the ladder has exactly one source of truth for the delay and the
   * retry sites cannot drift back to a stale captured value.
   *
   * Re-fork + re-initialize the child after an unexpected exit (e.g. an OOM
   * during a heavy backfill). `ready` stays pending until a restart attempt
   * succeeds, so queued invoke() calls resume against the fresh child; failed
   * attempts retry with backoff. The on-disk DB persists, so committed data
   * survives the crash.
   */
  private scheduleRestart(): void {
    if (
      this.closed ||
      this.closing ||
      this.child ||
      this.restarting ||
      !this.initOptions
    ) {
      return;
    }
    this.restarting = true;
    // ISS-6243: the options captured HERE are only the fallback. `attempt()`
    // re-reads `this.initOptions` when the backoff timer actually fires, because
    // a sign-out or org switch during the backoff replaces that field — forking
    // the replacement child from this frozen snapshot would open it as the
    // previous user and stamp their id on every session it then creates.
    const initAtSchedule = this.initOptions;
    this.ready = new Promise<void>((resolve) => {
      // Retain the resolver so clearRestartTimer() can settle this promise when
      // close() cancels the restart — otherwise clearing the only timer that
      // would call `attempt()`/`resolve()` leaves `ready` (and any invoke()
      // queued behind it) pending forever.
      this.resolveReady = resolve;
      const settleReady = (): void => {
        this.resolveReady = null;
        resolve();
      };
      const attempt = (): void => {
        this.restartTimer = null;
        // ISS-4713: `closing` — not just `closed` — must abort a restart. When
        // beginClosing() fires AFTER the backoff timer already elapsed (so this
        // attempt is queued/running) but BEFORE close() flips `closed`, gating on
        // `closed` alone would let this continuation re-fork the child mid-shutdown.
        if (this.closed || this.closing) {
          this.restarting = false;
          settleReady();
          return;
        }
        this.spawn(this.initOptions ?? initAtSchedule).then(
          () => {
            this.restarting = false;
            // ISS-4713: a spawn that RESOLVED after beginClosing()/close() must
            // not leave a freshly-forked child running into shutdown. spawn() has
            // already assigned this.child + wired its listeners; tear it down here
            // so the just-forked child is killed rather than surviving teardown.
            if (this.closed || this.closing) {
              this.killChild();
              settleReady();
              return;
            }
            // ISS-5715: the replacement can report Ready and then EXIT before
            // this continuation runs — Electron can deliver the child's queued
            // `message` and its `exit` in one task, and `exit` is a macrotask
            // while the two promise hops out of spawn() are microtasks queued
            // behind it. handleExit() then already ran: it cleared `this.child`
            // and called scheduleRestart(), which the `restarting` sentinel —
            // still true, because only the line above clears it — silently
            // swallowed. Nothing else re-forks, so `settleReady()` here would
            // resolve `ready` against NO child and wedge the client for good:
            // every later invoke() falls through to the `!this.child` branch and
            // rejects `db-host is not running` forever, permanently killing the
            // collectors, transcript sync and the Sessions read path while the
            // app still looks healthy. Re-arm the ladder instead and leave
            // `ready` PENDING so queued invokes wait for the next replacement
            // rather than failing against a host that is still coming.
            if (!this.child) {
              this.armRestartTimer(attempt);
              return;
            }
            settleReady();
          },
          (spawnError: unknown) => {
            this.child = null;
            // ISS-4474/ISS-4713: honor a close() OR an in-progress beginClosing()
            // that landed while spawn() was in flight — don't re-arm a retry timer
            // against a client that is shutting down.
            if (this.closed || this.closing) {
              this.restarting = false;
              settleReady();
              return;
            }
            this.options.onLog(
              `db-host restart failed, retrying: ${
                spawnError instanceof Error
                  ? spawnError.message
                  : String(spawnError)
              }`
            );
            this.armRestartTimer(attempt);
          }
        );
      };
      this.armRestartTimer(attempt);
    });
  }

  /**
   * Cancel a pending restart-backoff timer (e.g. on close), if one is armed, and
   * settle the pending `ready` promise so an invoke() queued behind it doesn't
   * hang once the only callback that would resolve it is gone. Idempotent.
   */
  private clearRestartTimer(): void {
    if (this.restartTimer) {
      this.clearTimeoutFn(this.restartTimer);
      this.restartTimer = null;
    }
    this.restarting = false;
    if (this.resolveReady) {
      const resolve = this.resolveReady;
      this.resolveReady = null;
      resolve();
    }
  }

  /**
   * ISS-4713 — kill and detach the current child. Used when a restart spawn
   * RESOLVES after shutdown has begun (beginClosing()/close()): the child was
   * already forked and wired by spawn(), so it must be torn down here rather than
   * left running into teardown. Best-effort — never throws.
   */
  private killChild(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    try {
      child.kill();
    } catch (error) {
      this.options.onLog(
        `db-host kill during shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

/**
 * ISS-5808 — reject a detached batch of abandoned ops with one error.
 *
 * Takes an ARRAY, not the live `pending` map, because `handleExit` must detach
 * before it schedules the restart and reject only afterwards: the rejection has
 * to carry whether a replacement child is actually coming, and a consumer's
 * re-drive has to find the new `ready` promise already installed.
 */
function rejectAll(abandoned: Pending[], error: Error): void {
  for (const pending of abandoned) {
    pending.reject(error);
  }
}
