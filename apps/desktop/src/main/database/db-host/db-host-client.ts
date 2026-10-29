import { fileURLToPath } from "node:url";
import electron from "electron";
import { isBackgroundDbRead } from "../../../shared/db-host-call-priority.js";
import { DbHostExitError } from "../../../shared/db-host-exit-error.js";
import { currentReadCancellationToken } from "../../../shared/db-host-read-cancellation.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
  isGracefulDbHostExitCode,
} from "../../../shared/db-host-shutdown-error.js";
import { DesktopReadCancelledError } from "../../../shared/read-cancellation-contract.js";
import { writeRelayedDurableLog } from "../../logging/durable-log-sink.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import { reportRefusedChildTelemetry } from "../../telemetry/db-host-telemetry-refusal.js";
import { emitRelayedChildTelemetry } from "../../telemetry/relayed-child-telemetry.js";
import type { DbHostExitDiagnostics } from "../../telemetry/telemetry-protocol.js";
import { sameUserIdentity } from "../../util/user-identity.js";
import { createDetachedCancelRing } from "./db-host-detached-cancels.js";
import { rebuildError } from "./db-host-error-rebuild.js";
import { describeUnexpectedDbHostExit } from "./db-host-exit-log.js";
import { MemoryPressureLevel } from "./db-host-memory-watchdog.js";
import { handleDbHostPostFailure, rejectAll } from "./db-host-post-failure.js";
import {
  DbHostDataCloneError,
  type DbHostInitOptions,
  type DbHostRequest,
  DbHostRequestKind,
  DbHostResponseKind,
  type DbHostUserIdentity,
  isDbHostResponse,
} from "./db-host-protocol.js";
import {
  CRASH_WINDOW_MS,
  describeRestartExhausted,
  evaluateRestartBudget,
  RESTART_BACKOFF_MS,
  registerCrashAndComputeBackoff,
  restartAttemptBackoffMs,
  restartExhaustedError,
} from "./db-host-restart-budget.js";
import {
  type DbHostPending,
  settleDbHostResult,
} from "./db-host-result-assembly.js";
import { isAdmittedDuringShutdown } from "./db-host-shutdown-admission.js";

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
// The restart ladder's delays and its ceiling live in `db-host-restart-budget.ts`.
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
/**
 * Exported so the inner store-close budget can be checked against the real
 * value: `STORE_CLOSE_DEADLINE_MS` must fit inside this, or the dispatcher is
 * still waiting on the store when main gives up and kills it mid-ack.
 */
export const CLOSE_ACK_TIMEOUT_MS = 2000;

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

  onUnexpectedExit?: (event: DbHostExitDiagnostics) => void;
  /**
   * ISS-8776 — the restart ladder gave up: terminal, at most once per process.
   * {@link onUnexpectedExit} means "a replacement is coming"; this means the
   * opposite. It reuses that event's payload shape because the wire schema
   * already validates it, so a fresh key would have been stripped on arrival.
   */
  onRestartExhausted?: (event: DbHostExitDiagnostics) => void;
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

/**
 * Main-process transport to the DB host utilityProcess. Owns the child lifecycle,
 * correlates `invoke` requests to `result` responses by id, and surfaces the
 * child's `emit`/`log` notifications via callbacks. The typed SqliteAgentDatabase
 * proxy is built separately (db-host-proxy.ts) on top of `invoke`.
 */
export class DbHostClient {
  private child: DbHostProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, DbHostPending>();
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
  // ISS-8776 — consecutive attempts armed since the last child that actually
  // came up, so the ceiling is per-run of failures and a healthy app that
  // bounces occasionally never approaches it. `evaluateRestartBudget` owns the
  // ceiling; `restartExhausted` is the terminal state past it, after which every
  // call rejects non-recoverably instead of promising a replacement forever.
  private restartAttempts = 0;
  private restartExhausted = false;
  // ISS-9802 — cancels that arrived with no child; see the ring's own module.
  private readonly cancelledWhileDetached = createDetachedCancelRing();
  private lastExitCode: number | null = null;
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
    // ISS-8776: reject BEFORE joining the in-flight set — nothing will re-arm
    // `ready`, so a caller queued behind it would wait forever.
    if (this.restartExhausted) {
      return Promise.reject(restartExhaustedError(this.lastExitCode, op));
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
      //
      // ISS-9839 / ISS-9914: `closing` alone does not refuse a TERMINAL flush —
      // see {@link isAdmittedDuringShutdown}. `closed` still does.
      if (this.closed || (this.closing && !isAdmittedDuringShutdown(op))) {
        finishSettled();
        // ISS-5262: classifiable, message unchanged (see the `closed` branch).
        throw new DbHostShutdownError(
          DbHostShutdownReason.Closing,
          `db-host is closing (op: ${op})`
        );
      }
      // ISS-8776: exhaustion settles `ready`, so a queued call lands here with
      // no child. The bare `db-host is not running` branch below is untyped and
      // unclassifiable; the terminal state has its own typed answer.
      if (this.restartExhausted) {
        finishSettled();
        throw restartExhaustedError(this.lastExitCode, op);
      }
      if (!this.child) {
        finishSettled();
        throw new Error(`db-host is not running (op: ${op})`);
      }
      // ISS-9802 (whitlockk review): cancelled while there was no child to forward
      // it to, so honour it HERE rather than re-running the abandoned scan.
      const cancellationToken = currentReadCancellationToken();
      if (
        cancellationToken !== undefined &&
        this.cancelledWhileDetached.has(cancellationToken)
      ) {
        finishSettled();
        throw new DesktopReadCancelledError();
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
        // ISS-9802: same omission rule as `background` — the token is attached
        // only when this call runs inside a `runWithReadCancellationToken`
        // scope, so every other call posts the request it always posted.
        this.post({
          kind: DbHostRequestKind.Invoke,
          id,
          op,
          args,
          ...(isBackgroundDbRead() ? { background: true } : {}),
          ...(cancellationToken === undefined ? {} : { cancellationToken }),
        });
      });
    });
  }

  /**
   * ISS-9802 — ask the child to abandon the in-flight read carrying `token`.
   *
   * Fire-and-forget, and deliberately unconditional on `pending`: main does not
   * track which correlation id a token belongs to (the token is scoped, not
   * correlated), and the store thread is the only side that knows whether the
   * read is still running. A token naming nothing in flight is a no-op there.
   *
   * Silent while closed or child-less: there is no work left to cancel in
   * either state, and a caller aborting a read it already lost must not be
   * handed an error for it. A cancel DURING `closing` is still forwarded — the
   * child is alive until the drain completes, so a read in flight then is
   * exactly one worth abandoning.
   */
  cancelRead(token: string): void {
    if (this.closed) {
      return;
    }
    if (!this.child) {
      // ISS-9802 (whitlockk review): there IS work left to cancel here — a read
      // parked on `ready` still holds its token — so the verdict is retained.
      this.cancelledWhileDetached.remember(token);
      return;
    }
    this.post({ kind: DbHostRequestKind.CancelRead, token });
  }

  /**
   * @internal Number of correlated requests still awaiting a reply. Exposed for
   * regression tests that must prove the correlation map is actually cleaned up
   * (e.g. after a clone-failure rejection); production code never reads it.
   */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

  /**
   * ISS-12552: keep main's parse policy in the RETAINED init options, so a
   * restarted child opens under the current policy rather than the one this
   * client started with. The running child is told through its
   * `parsePolicy.set` store op.
   */
  retainParsePolicy(parsePolicy: ParsePolicy): void {
    if (this.initOptions) {
      this.initOptions = { ...this.initOptions, parsePolicy };
    }
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
   * awaited too — that late continuation then observes `closed` and settles
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
      handleDbHostPostFailure({
        request,
        error,
        pending: this.pending,
        onLog: this.options.onLog,
      });
    }
  }

  private handleMessage(message: unknown): void {
    if (!isDbHostResponse(message)) {
      this.reportUnroutableChildTelemetry(message);
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
      case DbHostResponseKind.MemoryPressure:
        this.lastMemoryPressure = {
          level: message.level,
          atMs: this.now(),
        };
        return;
      // ISS-7109: emit the child's event on its behalf. This is deliberately NOT
      // a `DbHostClientOptions` callback: an optional handler that a composition
      // root forgets to wire is a silent no-op, which is precisely the shape of
      // the defect this relay exists to end — the child's emit call returned
      // successfully and sent nothing for the whole life of ISS-6417. Hard-wiring
      // the sink means there is no way to compose a DB host whose telemetry is
      // dropped. Tests substitute the transport through `Observability.init`,
      // which is the same seam main uses.
      case DbHostResponseKind.Telemetry:
        emitRelayedChildTelemetry(message.event);
        return;
      // ISS-7882: append the child's durable line to `main.log` on its behalf,
      // hard-wired for the same reason the telemetry case above is.
      case DbHostResponseKind.DurableLog:
        writeRelayedDurableLog(message.level, message.line);
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
      case DbHostResponseKind.Result:
      case DbHostResponseKind.ResultPage:
        settleDbHostResult(message, this.pending, (id, offset) =>
          this.post({ kind: DbHostRequestKind.ResultPagePull, id, offset })
        );
        return;
      default:
        return;
    }
  }

  /**
   * ISS-7109/ISS-7201 — a telemetry relay message the boundary rejected.
   *
   * Delegated whole: ISS-7201 made this drop a MONITORED signal rather than a
   * local log line, and the reason classification plus the version-skew silence
   * for unknown kinds now live with the other telemetry reporters.
   */
  private reportUnroutableChildTelemetry(message: unknown): void {
    reportRefusedChildTelemetry({ message, onLog: this.options.onLog });
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
    // ISS-8776: every exit, including expected ones, so the terminal report
    // names the code the host actually last died with.
    this.lastExitCode = code;
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
    const backoffMs = registerCrashAndComputeBackoff(
      this.recentCrashes,
      Date.now()
    );
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
    // ISS-8776: enforced HERE, the one owner of "schedule the next attempt" —
    // a bound honored by only one of the three arming paths would have left the
    // spawn-failure retry (the one the incident looped on) unbounded.
    const verdict = evaluateRestartBudget(this.restartAttempts);
    if (!verdict.arm) {
      this.enterRestartExhausted();
      return;
    }
    this.restartAttempts = verdict.attempt;
    this.restarting = true;
    this.restartTimer = this.setTimeoutFn(attempt, this.latestRestartBackoffMs);
  }

  /**
   * ISS-8776 — the ladder is finished; give up for the rest of this process.
   *
   * Idempotent, and it settles `ready`: exhaustion removes the only callback
   * that would have resolved it, so a queued `invoke()` would otherwise hang —
   * the wedge `clearRestartTimer` prevents on the close path. `rejectedOps`
   * counts the IN-FLIGHT set, not `pending`, which `handleExit` already
   * drained; reading `pending` would report zero for a real blast radius.
   */
  private enterRestartExhausted(): void {
    if (this.restartExhausted) {
      return;
    }
    this.restartExhausted = true;
    this.restarting = false;
    this.restartTimer = null;
    this.options.onLog(
      describeRestartExhausted(this.restartAttempts, this.lastExitCode)
    );
    this.options.onRestartExhausted?.({
      exitCode: this.lastExitCode,
      // Windowed, so NOT the severity signal here — `restartAttempts` is.
      crashesInWindow: this.recentCrashes.length,
      backoffMs: this.latestRestartBackoffMs,
      rejectedOps: this.inFlightInvokes.size,
      restartAlreadyInFlight: false,
      restartAttempts: this.restartAttempts,
    });
    if (this.resolveReady) {
      const resolve = this.resolveReady;
      this.resolveReady = null;
      resolve();
    }
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
      // ISS-8776: a finished ladder must not be restarted by a later exit.
      this.restartExhausted ||
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
        const onSpawnFailed = (spawnError: unknown): void => {
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
          // ISS-8776: escalate on THIS path too. `latestRestartBackoffMs` is
          // refreshed only by `handleExit`, so a spawn that failed without the
          // child ever exiting re-armed at a FIXED delay, not a ladder.
          //
          // NEVER DOWNWARD. `handleExit` can run while this attempt is in
          // flight: its `scheduleRestart()` no-ops on the `restarting`
          // sentinel and relies on THIS continuation to re-arm, having
          // already stored the FEA-3072 crash-storm delay. A plain assignment
          // would discard that and re-arm a storm at the shorter delay — the
          // hot loop FEA-3072 exists to prevent. Larger wins.
          this.latestRestartBackoffMs = Math.max(
            this.latestRestartBackoffMs,
            restartAttemptBackoffMs(this.restartAttempts)
          );
          this.armRestartTimer(attempt);
        };
        // ISS-9013: `spawn()` forks SYNCHRONOUSLY, and `attempt` is a bare
        // setTimeout callback, so an `utilityProcess.fork` that throws rather
        // than rejects (EMFILE under a crash storm) escapes as an
        // uncaughtException — the process-wide handler exits the app, and
        // `restarting` is left true with no timer armed, wedging the ladder even
        // if the app survived. A sync throw is the same event as a rejection:
        // no child came up. Route it to the one continuation that knows that.
        try {
          this.spawn(this.initOptions ?? initAtSchedule).then(() => {
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
            // ISS-8776: a child that is actually up ends this run of failures.
            // Reset HERE, not in `spawn()`: spawn also resolves on the
            // Ready-then-exit window above, and crediting that would clear the
            // tally on the exact sequence the ceiling exists to bound.
            this.restartAttempts = 0;
            settleReady();
          }, onSpawnFailed);
        } catch (spawnError) {
          onSpawnFailed(spawnError);
        }
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
