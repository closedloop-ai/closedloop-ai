/**
 * @file db-store-client.ts
 * @description ISS-8246 M1 — the DISPATCHER's handle on the store thread.
 *
 * The db-host utilityProcess keeps everything that must answer promptly — the
 * message loop, the admission lanes, the insights cache, the heap watchdog —
 * and forwards execution here. This module owns the
 * `node:worker_threads` hop: spawn, correlate, deadline, relay, terminate.
 *
 * ## Every worker-origin message is relayed, and the list is exhaustive
 *
 * `process.parentPort` is `undefined` inside a worker (probe 8), so nothing the
 * store raises can reach main by itself. All twelve inner response kinds are
 * handled below, and the two that fail SILENTLY when unhandled — telemetry and
 * durable logs — have each already shipped that exact bug one boundary out
 * (ISS-7109, ISS-7882). `SessionTerminal` is in the list because it was missed
 * in the first draft of this design and caught in review; a relay that covers
 * only the obvious kinds leaves core runtime signals dark.
 *
 * ## Ordering, not just delivery
 *
 * `handleMessage` is SYNCHRONOUS for every unsolicited kind, and resolves
 * correlated results through a promise (a microtask). That asymmetry is the
 * mechanism behind PLN-1837 §1.5: the store posts `CommittedWrite` before the
 * write's own `Result` — the observer fires before the write call returns — so
 * FIFO delivery plus a synchronous handler applies the epoch bump strictly
 * before the result is delivered onward. If this handler ever grows an `await`
 * ahead of the `CommittedWrite` branch, an insights read issued right after a
 * write can reuse the pre-write cache and the ISS-7110 onboarding-zeros class
 * comes back.
 */

import { Worker } from "node:worker_threads";
import { DbStoreOpDeadlineError } from "../../../shared/db-store-op-deadline-error.js";
import {
  DB_HOST_EXITED_SIGNATURE,
  STORE_OPEN_TIMEOUT_SIGNATURE,
} from "../../../shared/transient-db-host-error.js";
import type { DurableLogLevel } from "../../logging/durable-log-sink.js";
import type { TelemetryEventPayload } from "../../telemetry/telemetry-protocol.js";
import type {
  WriteQueueTaskPhase,
  WriteQueueTaskToken,
} from "../write-queue.js";
import {
  DbHostDataCloneError,
  type DbHostError,
  type DbHostInitOptions,
  type DbHostUserIdentity,
} from "./db-host-protocol.js";
import { EncodedDbHostResult } from "./db-host-result-codec.js";
import {
  STORE_CLOSE_DEADLINE_MS,
  STORE_HEAVY_DEADLINE_MS,
  STORE_OPEN_DEADLINE_MS,
  STORE_UNRESPONSIVE_DEADLINE_MS,
  storeExecuteDeadlineMs,
} from "./db-store-deadlines.js";
import {
  type DbStoreRequest,
  DbStoreRequestKind,
  type DbStoreResponse,
  DbStoreResponseKind,
  isDbStoreResponse,
} from "./db-store-protocol.js";

/**
 * Structural view of the store thread, so a test can drive the real client
 * against a fake without spawning a Worker (the seam `DbHostForkFn` gives the
 * outer hop, for the same reason).
 */
export type DbStoreWorkerHandle = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: DbStoreRequest): void;
  terminate(): Promise<number>;
};

export type DbStoreClientDeps = {
  onEmit: (sessionId: string) => void;
  onSessionTerminal: (notice: { sessionId: string; status: string }) => void;
  /** ISS-7110 — applied SYNCHRONOUSLY; see this file's header. */
  onCommittedWrite: () => void;
  /**
   * ISS-7256 — mirror one write-queue transition. Applied SYNCHRONOUSLY for the
   * same reason as `onCommittedWrite`: the mirror must already be current when
   * the next `Execute` on this port is a probe against it.
   */
  onWriteTask: (
    token: WriteQueueTaskToken,
    phase: WriteQueueTaskPhase,
    taskSeq: number
  ) => void;
  onLog: (message: string) => void;
  onDurableLog: (level: DurableLogLevel, line: string) => void;
  onTelemetry: (event: TelemetryEventPayload) => void;
  /**
   * The store thread is GONE — it errored, exited, failed to open, or went
   * silent past {@link STORE_UNRESPONSIVE_DEADLINE_MS}. ISS-8773: a single op
   * missing its deadline no longer reaches here; that fails the op alone.
   * PLN-1837 §1.3: the dispatcher exits non-zero, so this becomes the existing
   * `DbHostClient.handleExit` path.
   */
  onDeath: (reason: string) => void;
  /** Test seam. Defaults to spawning the real `db-store-worker.js`. */
  createWorker?: () => DbStoreWorkerHandle;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** ISS-8773 — read to report an op's TRUE elapsed, not its last-armed budget. */
  nowFn?: () => number;
};

export type DbStoreClient = {
  open: (options: DbHostInitOptions) => Promise<void>;
  /**
   * ISS-9802 — `cancellationToken` is the renderer token this op runs under, and
   * it is OMITTED from the posted message when absent so an op that cannot be
   * cancelled keeps the wire shape it has today.
   */
  execute: (
    op: string,
    args: unknown[],
    cancellationToken?: string
  ) => Promise<unknown>;
  /**
   * ISS-9802 — ask the store thread to abandon the read carrying `token` at its
   * next statement boundary. Fire-and-forget and never throws: the read settles
   * through its own `Execute` correlation, and a token naming nothing in flight
   * is a no-op over there.
   */
  cancelRead: (token: string) => void;
  setIdentity: (identity: DbHostUserIdentity) => void;
  /** Drain the store and await its ack, bounded. Never rejects. */
  close: () => Promise<void>;
  terminate: () => Promise<void>;
  /**
   * The store thread's most recent memory sample, or null before the first one.
   *
   * `heapUsed` is PER-ISOLATE, so after the split the dispatcher's own figure no
   * longer sees the allocations that matter — the backfills, the importer, the
   * corpus reads all allocate a thread away. The dispatcher folds this into the
   * sample it feeds the watchdog, the FEA-3150 admission gate, and `measureOp`.
   */
  latestStoreMemory: () => { heapUsed: number; rss: number } | null;
};

type PendingExecute = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  op: string;
  /** This op runs on {@link STORE_HEAVY_DEADLINE_MS}. */
  isHeavy: boolean;
  /**
   * Posted while a heavy op was already in flight, so it is armed against the
   * heavy backstop until that op settles. See {@link armExecuteTimer}'s caller.
   */
  queuedBehindHeavy: boolean;
  /** ISS-8773 — when this op was posted, for the elapsed the caller is told. */
  postedAt: number;
  /** The budget currently armed, which a re-arm replaces. */
  deadlineMs: number;
};

/**
 * An op the store has not answered inside its budget, whose caller has already
 * been failed. Kept — rather than forgotten — so a LATE reply can still release
 * the heavy accounting the queued ops are armed against.
 */
type OverdueExecute = {
  op: string;
  isHeavy: boolean;
  postedAt: number;
  /** Bounds the wait for a reply that may never come; see `abandonOverdue`. */
  timer: ReturnType<typeof setTimeout>;
};

/**
 * An error the store thread already serialized, carried WHOLE.
 *
 * The dispatcher has to hand main a `DbHostError`, and the store thread already
 * produced one — with the two fields that only exist because they cannot be
 * re-derived on the far side. ISS-4714's `refusalKind` survives structured
 * clone where `instanceof DesktopMigrationError` does not, and ISS-6337's
 * `storageExhaustionReason` is classified in the process that still holds the
 * driver's result code on a `cause` link the clone flattens away.
 *
 * Rebuilding a plain `Error` here and re-serializing it on the dispatcher would
 * silently drop both: `serializeDbHostError` reads `refusalKind` off a real
 * `DesktopMigrationError` instance and nothing else, so a migration refusal
 * would have reached main as an untyped error and `db-host-client.ts` would
 * have stopped classifying it DB-ahead. Keeping the original payload attached
 * is what makes the second hop lossless.
 */
export class DbStoreRelayedError extends Error {
  readonly serialized: DbHostError;

  constructor(serialized: DbHostError) {
    super(serialized.message);
    this.name = serialized.name ?? "Error";
    if (serialized.stack) {
      this.stack = serialized.stack;
    }
    this.serialized = serialized;
  }
}

/**
 * The store thread's original payload, when `error` came from across the hop.
 *
 * Callers re-serializing for main use `serializedDbStoreError(e) ??
 * serializeDbHostError(e)` so a relayed error is forwarded verbatim and a
 * dispatcher-local one is serialized normally.
 */
export function serializedDbStoreError(error: unknown): DbHostError | null {
  return error instanceof DbStoreRelayedError ? error.serialized : null;
}

/** The `kind` of a message that failed validation, for the log line only. */
function describeMessageKind(message: unknown): string {
  if (typeof message !== "object" || message === null) {
    return typeof message;
  }
  const kind = (message as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "absent";
}

/**
 * The rejection an in-flight invoke gets when the store thread dies.
 *
 * It MUST carry {@link DB_HOST_EXITED_SIGNATURE}. These rejections settle on the
 * microtask queue, and `handleStoreDeath` defers the process exit by one tick so
 * its log line can flush — so the dispatcher answers main with `Result ok:false`
 * BEFORE the exit runs, main settles the pending request normally, and
 * `DbHostClient.handleExit` never gets to mint its typed `DbHostExitError` for
 * it. Without the signature `isTransientDbHostError` returns false and the
 * Branches/Sessions read boundaries surface the hard error card + Retry instead
 * of the quiet reconnecting state — for a host that is re-forking one tick
 * later. Before ISS-8246 M1 the same crash reached those callers as
 * `db-host exited (code: N)` from `handleExit`.
 *
 * The prose reason is kept for the log; only the wire message is prefixed.
 */
function storeDeathError(reason: string): Error {
  return new Error(`${DB_HOST_EXITED_SIGNATURE}: ${reason}`);
}

/** Rebuild an Error from the store thread's serialized form. */
function rebuildStoreError(error: DbHostError | undefined): Error {
  return new DbStoreRelayedError(
    error ?? { message: "db-host store op failed" }
  );
}

function defaultCreateWorker(): DbStoreWorkerHandle {
  // PLN-999: resolved by PATH at runtime, not by a static import, so
  // `db-store-worker` must be a declared `MAIN_WORKER_ENTRIES` input or rollup
  // drops it from dist/main. `test/worker-entry-bundling.test.ts` matches this
  // URL shape (not the spawn API), so it already covers this call site.
  // No cast: `DbStoreWorkerHandle` is declared to be exactly the slice of
  // `Worker` this module uses, so a real Worker satisfies it structurally. That
  // is the point of writing the seam as an overload set rather than a union —
  // it keeps the fake and the real thing checked against one shape.
  return new Worker(new URL("./db-store-worker.js", import.meta.url));
}

/** Build the dispatcher's handle on a freshly spawned store thread. */
export function createDbStoreClient(deps: DbStoreClientDeps): DbStoreClient {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const nowFn = deps.nowFn ?? Date.now;
  const worker = (deps.createWorker ?? defaultCreateWorker)();
  const pending = new Map<number, PendingExecute>();
  /** Past their deadline, caller already failed, store still working on them. */
  const overdue = new Map<number, OverdueExecute>();
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;
  let storeMemory: { heapUsed: number; rss: number } | null = null;
  let opened: { resolve: () => void; reject: (error: Error) => void } | null =
    null;
  let closed: (() => void) | null = null;
  let dead = false;
  /** Outstanding ops on the heavy backstop; see {@link releaseHeavy}. */
  let heavyInFlight = 0;

  const die = (reason: string): void => {
    if (dead) {
      return;
    }
    dead = true;
    const abandoned = [...pending.values()];
    pending.clear();
    overdue.clear();
    heavyInFlight = 0;
    if (unresponsiveTimer !== null) {
      clearTimeoutFn(unresponsiveTimer);
      unresponsiveTimer = null;
    }
    for (const entry of abandoned) {
      clearTimeoutFn(entry.timer);
      entry.reject(storeDeathError(reason));
    }
    opened?.reject(storeDeathError(reason));
    opened = null;
    // Resolve rather than reject: a close awaiting an ack from a dead thread has
    // already got what it wanted, and must never leave the dispatcher hanging
    // with main's 2s budget running.
    closed?.();
    closed = null;
    deps.onDeath(reason);
  };

  /**
   * Re-arm the wedge backstop, which is the ONLY execute-path clock that still
   * ends in {@link die}.
   *
   * Armed while anything is outstanding, cleared and re-armed on every
   * correlated reply, and NOT reset by posting more work — otherwise a steady
   * stream of new ops would keep a wedged store alive indefinitely. An op going
   * overdue does not reset it either: being late is the symptom under
   * investigation, not evidence of life.
   */
  const armUnresponsiveWatch = (): void => {
    if (unresponsiveTimer !== null || dead) {
      return;
    }
    if (pending.size + overdue.size === 0) {
      return;
    }
    unresponsiveTimer = setTimeoutFn(() => {
      unresponsiveTimer = null;
      // Recomputed, never captured: an op can be withdrawn (a failed post) after
      // the arm, and a store with nothing outstanding has answered everything
      // asked of it.
      const outstanding = pending.size + overdue.size;
      if (outstanding === 0) {
        return;
      }
      die(
        `store thread is unresponsive: no reply to any of ${outstanding} outstanding op(s) in ${STORE_UNRESPONSIVE_DEADLINE_MS}ms`
      );
    }, STORE_UNRESPONSIVE_DEADLINE_MS);
  };

  /** The store answered something, so it is alive; restart its silence clock. */
  const noteStoreReplied = (): void => {
    if (unresponsiveTimer !== null) {
      clearTimeoutFn(unresponsiveTimer);
      unresponsiveTimer = null;
    }
    armUnresponsiveWatch();
  };

  /**
   * Disarm the silence clock once the store owes nothing.
   *
   * {@link armUnresponsiveWatch} already refuses to arm on an empty outstanding
   * set; this is the same rule applied to a window that is ALREADY running when
   * the set drains, so a stale deadline can never be inherited by an op posted
   * afterwards.
   */
  const clearUnresponsiveWatchWhenIdle = (): void => {
    if (unresponsiveTimer === null || pending.size + overdue.size > 0) {
      return;
    }
    clearTimeoutFn(unresponsiveTimer);
    unresponsiveTimer = null;
  };

  /**
   * Stop waiting for a reply to an op that is already past its deadline.
   *
   * The overdue set is bounded HERE and nowhere else. Matching a late reply is
   * the happy path, but a store that drops one correlated reply while still
   * answering everything else keeps the unresponsive watch resetting forever, so
   * without this the entry would never be evicted — and, worse, a heavy op's
   * slot would never be released, arming every later light op against the
   * hour-long backstop instead of its own budget. That is the ISS-8773 defect
   * inverted: one anomalous op silently degrading every unrelated one.
   */
  const abandonOverdue = (id: number): void => {
    const late = overdue.get(id);
    if (!late) {
      return;
    }
    overdue.delete(id);
    clearTimeoutFn(late.timer);
    if (late.isHeavy) {
      releaseHeavy();
    }
    deps.onLog(
      `db-host store op "${late.op}" never answered; giving up on it ${nowFn() - late.postedAt}ms after it was posted`
    );
    // The silence window is deliberately NOT reset by an op going late, but
    // abandoning the LAST one leaves nothing outstanding for it to convict. Left
    // running, it outlives its own subject: the next op posted finds the watch
    // already armed, {@link armUnresponsiveWatch} declines to install its own,
    // and a remainder of a window that was never about it kills the host. Same
    // re-anchoring the failed-post path in `execute` does, and for the same
    // reason.
    clearUnresponsiveWatchWhenIdle();
  };

  /**
   * ISS-8773 — fail the op that ran long, and only it.
   *
   * The entry moves to {@link overdue} rather than being forgotten, because the
   * store thread is still inside the call: its heavy accounting still holds the
   * queued ops on the heavy backstop, and its eventual reply still has to be
   * matched so that accounting is released.
   *
   * It is granted ONE more budget of the same size to produce that reply. One
   * budget already elapsed without it, so a second is the point past which the
   * reply is not coming, and {@link abandonOverdue} takes over.
   */
  const failOverdue = (id: number): void => {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    clearTimeoutFn(entry.timer);
    overdue.set(id, {
      op: entry.op,
      isHeavy: entry.isHeavy,
      postedAt: entry.postedAt,
      timer: setTimeoutFn(() => abandonOverdue(id), entry.deadlineMs),
    });
    const elapsedMs = nowFn() - entry.postedAt;
    // Never silent. Until ISS-8773 every trip became a process death, which the
    // supervisor reported on the monitored exit path; failing the op alone
    // removes that report, so the trip has to say so itself.
    deps.onLog(
      `db-host store op "${entry.op}" missed its ${entry.deadlineMs}ms deadline after ${elapsedMs}ms; failing that op only, the store thread is still up`
    );
    entry.reject(
      new DbStoreOpDeadlineError(entry.op, entry.deadlineMs, elapsedMs)
    );
    armUnresponsiveWatch();
  };

  const armExecuteTimer = (
    id: number,
    deadlineMs: number
  ): ReturnType<typeof setTimeout> =>
    setTimeoutFn(() => {
      failOverdue(id);
    }, deadlineMs);

  /**
   * Put every op that was queued behind a heavy one back on its own budget.
   *
   * Measured from NOW rather than from its post: this is the first instant the
   * store thread could have picked the op up, so it is the first instant its own
   * budget describes anything the store did. See the carve-out in
   * `db-store-deadlines.ts`.
   */
  const rearmQueuedOps = (): void => {
    for (const [id, entry] of pending) {
      if (!entry.queuedBehindHeavy) {
        continue;
      }
      clearTimeoutFn(entry.timer);
      entry.queuedBehindHeavy = false;
      entry.deadlineMs = storeExecuteDeadlineMs(entry.op);
      entry.timer = armExecuteTimer(id, entry.deadlineMs);
    }
  };

  const releaseHeavy = (): void => {
    heavyInFlight -= 1;
    // The LAST one: while any heavy op is outstanding the store thread can still
    // be inside a synchronous call, so the queued ops have not become measurable
    // yet.
    if (heavyInFlight === 0) {
      rearmQueuedOps();
    }
  };

  const settleExecute = (
    id: number,
    ok: boolean,
    value: unknown,
    error: DbHostError | undefined
  ): void => {
    const late = overdue.get(id);
    if (late) {
      overdue.delete(id);
      if (late.isHeavy) {
        releaseHeavy();
      }
      noteStoreReplied();
      // Never silent: the caller already got a failure for this op, so this line
      // is the only place the elapsed the store ACTUALLY took is recorded.
      deps.onLog(
        `db-host store op "${late.op}" ${ok ? "succeeded" : `failed (${error?.message ?? "no message"})`} ${nowFn() - late.postedAt}ms after it was posted, past its deadline; its caller was already failed`
      );
      return;
    }
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    clearTimeoutFn(entry.timer);
    if (entry.isHeavy) {
      releaseHeavy();
    }
    noteStoreReplied();
    if (ok) {
      entry.resolve(value);
      return;
    }
    entry.reject(rebuildStoreError(error));
  };

  const handleMessage = (message: DbStoreResponse): void => {
    switch (message.kind) {
      case DbStoreResponseKind.Opened:
        if (message.error) {
          opened?.reject(rebuildStoreError(message.error));
        } else {
          opened?.resolve();
        }
        opened = null;
        return;
      case DbStoreResponseKind.Result:
        settleExecute(
          message.id,
          message.ok,
          // ISS-12022: forwarded to main as the bytes the store produced, never
          // decoded on this thread.
          message.encoded === undefined
            ? message.value
            : new EncodedDbHostResult(message.encoded),
          message.error
        );
        return;
      case DbStoreResponseKind.CommittedWrite:
        deps.onCommittedWrite();
        return;
      case DbStoreResponseKind.WriteTask:
        deps.onWriteTask(message.token, message.phase, message.taskSeq);
        return;
      case DbStoreResponseKind.Emit:
        deps.onEmit(message.sessionId);
        return;
      case DbStoreResponseKind.SessionTerminal:
        deps.onSessionTerminal({
          sessionId: message.sessionId,
          status: message.status,
        });
        return;
      case DbStoreResponseKind.Log:
        deps.onLog(message.message);
        return;
      case DbStoreResponseKind.DurableLog:
        deps.onDurableLog(message.level, message.line);
        return;
      case DbStoreResponseKind.Telemetry:
        deps.onTelemetry(message.event);
        return;
      case DbStoreResponseKind.Heap:
        storeMemory = { heapUsed: message.heapUsed, rss: message.rss };
        return;
      case DbStoreResponseKind.Closed:
        closed?.();
        closed = null;
        return;
      default:
        return;
    }
  };

  worker.on("message", (message: unknown) => {
    if (isDbStoreResponse(message)) {
      handleMessage(message);
      return;
    }
    // Never a silent drop. A malformed inner message means the store thread —
    // our own code, in this same bundle — is broken, and the only other symptom
    // would be an op that hangs to its deadline with nothing saying why. The
    // kind is named because it is the one field safe to read off a message that
    // failed validation.
    deps.onLog(
      `db-host store thread sent a malformed message (kind: ${describeMessageKind(message)}); ignoring it`
    );
  });
  // The reasons below are the PROSE half; `storeDeathError` prefixes the wire
  // message with the lifecycle signature, so they must not repeat "db-host".
  worker.on("error", (error: Error) => {
    die(`store thread error: ${error.message}`);
  });
  worker.on("exit", (code: number) => {
    die(`store thread exited with code ${code}`);
  });

  const post = (op: string, message: DbStoreRequest): void => {
    try {
      worker.postMessage(message);
    } catch (error) {
      // The outer hop already rejected non-cloneable args with this same typed
      // error, so anything reaching here cloned once already. Kept anyway so a
      // future op whose result is thread-hostile fails as a handled rejection
      // naming the op, not as an unhandled one that takes the app down.
      throw new DbHostDataCloneError(op, error);
    }
  };

  return {
    open(options: DbHostInitOptions): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeoutFn(() => {
          // ISS-9197: minted through the shared signature, not a local literal.
          // The boot path retries THIS failure and terminates on every other
          // open failure, so the token that tells them apart has one owner.
          die(`${STORE_OPEN_TIMEOUT_SIGNATURE} ${STORE_OPEN_DEADLINE_MS}ms`);
        }, STORE_OPEN_DEADLINE_MS);
        opened = {
          resolve: () => {
            clearTimeoutFn(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeoutFn(timer);
            reject(error);
          },
        };
        post("store-open", {
          kind: DbStoreRequestKind.Open,
          options,
        });
      });
    },

    execute(
      op: string,
      args: unknown[],
      cancellationToken?: string
    ): Promise<unknown> {
      if (dead) {
        // Same signature rule as `storeDeathError`: an invoke that arrives in
        // the tick between the death and the process exit must still classify
        // transient, not fatal.
        return Promise.reject(storeDeathError("store thread is gone"));
      }
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        // ISS-8773: a missed deadline fails THIS op and keeps the thread. It is
        // the signature of a slow loop just as much as a wedged one, and nothing
        // at this boundary can tell those apart — so the ambiguous case now
        // costs one caller a failure instead of costing every other in-flight op
        // the process (`db-store-deadlines.ts`).
        //
        // An op posted while a heavy op is in flight is still armed against the
        // HEAVY backstop rather than its own. The store thread has no loop turns
        // inside a synchronous libSQL call, so this Execute is sitting in the
        // port buffer, unseen; measuring it against its own budget would fail a
        // read because a concurrent import was slow. ISS-10401 made the import
        // yield between its record groups, so such a read now waits out ONE
        // group rather than the whole session — but it is still the store
        // thread's own turn that delivers it, and a group can be slow, so the
        // re-arm is kept deliberately.
        const ownDeadlineMs = storeExecuteDeadlineMs(op);
        const isHeavy = ownDeadlineMs === STORE_HEAVY_DEADLINE_MS;
        const queuedBehindHeavy = !isHeavy && heavyInFlight > 0;
        const deadlineMs = queuedBehindHeavy
          ? STORE_HEAVY_DEADLINE_MS
          : ownDeadlineMs;
        const timer = armExecuteTimer(id, deadlineMs);
        pending.set(id, {
          resolve,
          reject,
          timer,
          op,
          isHeavy,
          queuedBehindHeavy,
          postedAt: nowFn(),
          deadlineMs,
        });
        if (isHeavy) {
          heavyInFlight += 1;
        }
        armUnresponsiveWatch();
        try {
          post(op, {
            kind: DbStoreRequestKind.Execute,
            id,
            op,
            args,
            // Omitted, never `undefined`: an uncancellable op posts the message
            // it always posted, so a store thread that predates the field is
            // handed nothing new to ignore.
            ...(cancellationToken === undefined ? {} : { cancellationToken }),
          });
        } catch (error) {
          pending.delete(id);
          if (isHeavy) {
            releaseHeavy();
          }
          clearTimeoutFn(timer);
          // Re-anchor the silence window. It was armed for THIS op a moment ago;
          // left running it would convict whatever is outstanding when it fires,
          // however recently that op was posted — a false wedge that exits the
          // host, which is the blast radius this ticket removes.
          noteStoreReplied();
          reject(error as Error);
        }
      });
    },

    cancelRead(token: string): void {
      if (dead) {
        // Nothing is running over there to cancel, and posting into a dead port
        // would throw a clone error for a message no caller is awaiting.
        return;
      }
      post("store-cancel-read", {
        kind: DbStoreRequestKind.CancelRead,
        token,
      });
    },

    setIdentity(identity: DbHostUserIdentity): void {
      if (dead) {
        return;
      }
      post("store-set-identity", {
        kind: DbStoreRequestKind.SetIdentity,
        identity,
      });
    },

    close(): Promise<void> {
      if (dead) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeoutFn(() => {
          closed = null;
          deps.onLog(
            `db-host store thread did not acknowledge close within ${STORE_CLOSE_DEADLINE_MS}ms; terminating it anyway`
          );
          resolve();
        }, STORE_CLOSE_DEADLINE_MS);
        closed = () => {
          clearTimeoutFn(timer);
          resolve();
        };
        post("store-close", { kind: DbStoreRequestKind.Close });
      });
    },

    async terminate(): Promise<void> {
      // Mark dead FIRST so the `exit` this triggers is not reported as a death
      // the dispatcher must react to.
      dead = true;
      await worker.terminate().catch(() => 0);
    },

    latestStoreMemory() {
      return storeMemory;
    },
  };
}
