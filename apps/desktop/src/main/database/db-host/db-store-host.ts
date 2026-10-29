/**
 * @file db-store-host.ts
 * @description ISS-8246 M1 — the SQLite runtime, on its own thread.
 *
 * This is the half of the old `db-host-worker.ts` that actually touches the
 * database. It opens `openSqliteAgentDatabase`, owns the writer connection, the
 * write queue, the reader pool, the scheduler and every `store:` op body, and it
 * answers exactly one caller: the dispatcher, one thread away.
 *
 * ## Why this exists
 *
 * `@libsql/client` 0.17.3's `Sqlite3Client.execute` calls `executeStmt` and
 * returns — no `await`, no threadpool hop. The promise-shaped API wraps
 * synchronous native execution, and no pragma, config, or adapter option makes
 * it otherwise. So while the db-host ran a long statement it answered nothing:
 * measured at ZERO loop turns across a 61 s import. Moving execution to another
 * thread is the only lever available, and it collapses the worst silent window
 * from 953 ms to 2 ms (ISS-8246 probe 2).
 *
 * The spikes also settled that the useful seam is HERE and not one layer down.
 * A real import is only ~1/3 driver time — 33.2 / 34.7 / 33.9% on three large
 * real sessions — so an adapter-level boundary would have left two thirds of
 * the blocking behind. Row mapping, attribution resolution and Prisma query
 * construction are the other two thirds, they all sit inside the store op, and
 * they move with it.
 *
 * ## One store worker, never a pool
 *
 * Three invariants forbid a second one, and all three are load-bearing:
 *
 * - **The write queue IS the single-writer discipline.** Two writer connections
 *   mean one of them absorbs `busy_timeout=15000` on every overlap, and
 *   ISS-4710's fairness classes and ISS-4572's task-scoped eviction have no
 *   cross-thread form.
 * - **The reader pool is deliberately 2**, because a live reader snapshot pins
 *   WAL frames and blocks the TRUNCATE checkpoint (FEA-3132's 26 GB WAL).
 * - **The WAL TRUNCATE cadence is per-client closure state** — ISS-4819's "at
 *   most one checkpoint per interval" holds PER CLIENT.
 *
 * With one worker none of them change. One queue, one pool, one cadence, one
 * connection set — just not on the thread that answers messages.
 *
 * ## The libSQL patch constrains this file
 *
 * `patches/@libsql__client` keeps the native connection ATTACHED across a
 * transaction, and is safe only because every consumer "fully serializes
 * statements per client". One connection set per thread preserves that
 * STRUCTURALLY — threads do not share JS objects — but it also means this module
 * must never multiplex concurrent callers onto one connection, and must never
 * open a short-lived "quick" connection on the side. Connection churn is exactly
 * what the patch exists to stop: upstream's detach leaked a connection per
 * transaction and silently dropped every session PRAGMA onto a lazily recreated
 * replacement (death at ~12.5k transactions / ~75k fds).
 */

import { resolveBinaryFromLoginShellSync } from "../../../server/shell-path.js";
import { detectBillingMode } from "../../cost/billing-mode-detector.js";
import { routeDurableLogsToSink } from "../../logging/durable-log-sink.js";
import { setEffectiveParsePolicy } from "../../parse-policy/effective-parse-policy.js";
import { readParsePolicy } from "../../parse-policy/parse-policy.js";
import { setTelemetryRelaySink } from "../../telemetry/telemetry-relay-sink.js";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../sqlite.js";
import { createDbHostDurableLogRelay } from "./db-host-durable-log.js";
import { callDbHostOp } from "./db-host-invoke-dispatch.js";
import { installProcessCrashLogging } from "./db-host-memory-watchdog.js";
import type {
  DbHostInitOptions,
  DbHostUserIdentity,
} from "./db-host-protocol.js";
import {
  DB_HOST_STORE_OP_PREFIX,
  type DbHostStoreOpRegistry,
  dispatchDbHostStoreOp,
} from "./db-host-store-op-registry.js";
import { createDbHostTelemetryRelaySink } from "./db-host-telemetry-relay.js";
import { createDbStoreOps } from "./db-store-ops.js";
import {
  type DbStoreResponse,
  DbStoreResponseKind,
} from "./db-store-protocol.js";
import { createSessionOwnerClaimTracker } from "./session-owner-claim-tracker.js";

/**
 * How often the store thread publishes its own memory sample to the dispatcher.
 *
 * Faster than the dispatcher's 2 s watchdog tick so a sample is never more than
 * one dispatcher interval stale. Every `Execute` also publishes one on
 * completion, so the sample `measureOp` reads for its post-op snapshot is fresh
 * rather than up to a tick old.
 */
const HEAP_PUBLISH_INTERVAL_MS = 1000;

export type DbStoreHostDeps = {
  /** Post to the dispatcher. In the worker this is `parentPort.postMessage`. */
  post: (message: DbStoreResponse) => void;
};

export type DbStoreHost = {
  open: (options: DbHostInitOptions) => Promise<void>;
  execute: (op: string, args: unknown[]) => Promise<unknown>;
  setIdentity: (identity: DbHostUserIdentity) => void;
  close: () => Promise<void>;
  /** Publish a memory sample now (the dispatcher folds it into its own). */
  publishMemorySample: () => void;
};

/**
 * Build the store host.
 *
 * Called by `db-store-worker.ts` immediately after it dynamically imports this
 * module, and INSIDE that bootstrap's try/catch — so a failure here still
 * reaches the dispatcher as a serialized `Opened` error rather than as a
 * `Worker` error event. See that file for why the difference matters.
 */
export function createDbStoreHost(deps: DbStoreHostDeps): DbStoreHost {
  let agentDatabase: SqliteAgentDatabase | null = null;
  let currentIdentity: DbHostUserIdentity = null;
  let storeOps: DbHostStoreOpRegistry | null = null;
  let heapTimer: ReturnType<typeof setInterval> | null = null;

  const storeLog = (message: string): void => {
    deps.post({ kind: DbStoreResponseKind.Log, message });
  };

  // ISS-7882 / ISS-7109 — this thread is its own V8 isolate, so it holds its OWN
  // copies of the two module-level relay singletons. Both fail SILENTLY when
  // un-installed, and both have already shipped exactly that bug one boundary
  // out: the telemetry emit "ran, returned, and sent nothing" (ISS-7109), and
  // durable log lines were taken by `PreInitLogBuffer` and dropped past its
  // 500-line cap (ISS-7882). Installing them here re-runs those fixes for the
  // new isolate; the relay factories are reused rather than reimplemented, with
  // only the envelope re-addressed to the inner protocol.
  //
  // Installed FIRST, before anything else in this factory, so there is no window
  // in which this thread writes into the void. The heavy module graph above
  // imported before this ran, but `routeDurableLogsToSink` replays whatever
  // `PreInitLogBuffer` captured, which is the same guarantee the dispatcher has.
  routeDurableLogsToSink(
    createDbHostDurableLogRelay({
      post: (message) =>
        deps.post({
          kind: DbStoreResponseKind.DurableLog,
          level: message.level,
          line: message.line,
        }),
    })
  );
  setTelemetryRelaySink(
    createDbHostTelemetryRelaySink({
      post: (message) =>
        deps.post({
          kind: DbStoreResponseKind.Telemetry,
          event: message.event,
        }),
      log: storeLog,
    })
  );

  // FEA-3072 — report an OOM-adjacent throw or rejection before the thread dies.
  //
  // Probe 8: `process.exit()` inside a worker stops the THREAD, not the process,
  // so the exit-to-restart contract this installs does not reach the supervisor
  // by itself. The dispatcher closes that gap by watching `worker.on("exit")`
  // and exiting non-zero itself (PLN-1837 §1.3), which is what turns a store
  // thread death back into the `DbHostClient.handleExit` path that already
  // rejects pending invokes and re-forks.
  installProcessCrashLogging(storeLog);

  // FEA-2038: resolve git ONCE per thread. `resolveBinaryFromLoginShellSync`
  // spawns `zsh -l -i`, which on a heavy shell profile blocks for seconds, and
  // `onPostImport` calls it per imported session. The cache lives here, with the
  // only caller, so the single-worker rule keeps it a single cache — a pool would
  // multiply the login-shell spawns by its width (PLN-1837 §1.10).
  const cachedBinaryPaths = new Map<string, string>();

  // ISS-6168 — repair unowned sessions when an identity arrives AFTER the store
  // opened (the normal cold-start case). It lives on THIS thread, not the
  // dispatcher, because `claim` is a direct store call: routing it back through
  // the invoke path would buy nothing and add a round trip to a retry loop.
  const sessionOwnerClaimTracker = createSessionOwnerClaimTracker({
    claim: (identity) => agentDatabase?.claimSessionOwnerIdentity(identity),
    log: storeLog,
  });

  const publishMemorySample = (): void => {
    const { heapUsed, rss } = process.memoryUsage();
    deps.post({ kind: DbStoreResponseKind.Heap, heapUsed, rss });
  };

  const resolveCachedBinaryPath = (binary: "git"): string => {
    const cached = cachedBinaryPaths.get(binary);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = resolveBinaryFromLoginShellSync(binary).path;
    cachedBinaryPaths.set(binary, resolved);
    return resolved;
  };

  const open = async (options: DbHostInitOptions): Promise<void> => {
    currentIdentity = options.identity ?? null;
    setEffectiveParsePolicy(readParsePolicy(options.parsePolicy));
    agentDatabase = await openSqliteAgentDatabase({
      dataDir: options.dataDir,
      staleMinutes: options.staleMinutes,
      detectBillingMode,
      emit: (sessionId: string) => {
        // The re-entrant store call stays THREAD-LOCAL; only the notification
        // crosses to the dispatcher (PLN-1837 §1.10).
        agentDatabase?.sessions
          .handleSessionMutation(sessionId)
          .catch(() => undefined);
        deps.post({ kind: DbStoreResponseKind.Emit, sessionId });
      },
      // ISS-7110 — the cache-invalidation boundary. `InsightsResultCache` lives
      // on the DISPATCHER now, so what used to be a direct `bumpDataEpoch()`
      // call is a message — and its ORDER against the write's own `Result` is
      // the contract, not merely its delivery. The observer fires BEFORE the
      // write call returns, so posting here puts `CommittedWrite` ahead of
      // `Result` in this port's FIFO, which is what lets the dispatcher apply
      // the bump first. Without that, an insights read issued right after a
      // write could still reuse the pre-write cache and the ISS-7110
      // onboarding-zeros class would survive the move.
      onCommittedWrite: () =>
        deps.post({ kind: DbStoreResponseKind.CommittedWrite }),
      // ISS-7256 (whitlockk review) — publish every tokened write-queue transition
      // so the DISPATCHER can answer `importer.hasUndispatchedWrite` out of its
      // own mirror. The `dispatched` notice is posted before the task's `fn`
      // runs, which is before a synchronous libSQL call can park this thread, so
      // it is already across the port when the window the bound asks about
      // begins. A pull would arrive during that window and be answered by
      // nothing — see `write-dispatch-mirror.ts`.
      onWriteTaskPhase: (token, phase, taskSeq) =>
        deps.post({
          kind: DbStoreResponseKind.WriteTask,
          token,
          phase,
          taskSeq,
        }),
      onSessionTerminal: (notice) =>
        deps.post({
          kind: DbStoreResponseKind.SessionTerminal,
          sessionId: notice.sessionId,
          status: notice.status,
        }),
      getUserIdentity: () => currentIdentity,
      resolveGitPath: () => resolveCachedBinaryPath("git"),
      log: storeLog,
    });
    storeOps = createDbStoreOps({ log: storeLog });
    heapTimer = setInterval(publishMemorySample, HEAP_PUBLISH_INTERVAL_MS);
    // Never hold the process open on this sampler alone.
    heapTimer.unref?.();
  };

  const execute = async (op: string, args: unknown[]): Promise<unknown> => {
    const db = agentDatabase;
    const ops = storeOps;
    if (!(db && ops)) {
      // Same message the dispatcher's own pre-flight check raises, so a caller
      // cannot tell which side refused.
      throw new Error("db-host not initialized");
    }
    if (op.startsWith(DB_HOST_STORE_OP_PREFIX)) {
      return await dispatchDbHostStoreOp(ops, db, op, args);
    }
    return await callDbHostOp(db, op, args);
  };

  const setIdentity = (identity: DbHostUserIdentity): void => {
    currentIdentity = identity;
    sessionOwnerClaimTracker.onIdentity(identity);
  };

  const close = async (): Promise<void> => {
    if (heapTimer) {
      clearInterval(heapTimer);
      heapTimer = null;
    }
    // `close()` is the whole store teardown: write-queue drain, Prisma
    // disconnect, then the migration handle. Best-effort, because
    // the dispatcher acks main and exits either way.
    await agentDatabase?.close();
    agentDatabase = null;
    storeOps = null;
  };

  return {
    open,
    execute,
    setIdentity,
    close,
    publishMemorySample,
  };
}
