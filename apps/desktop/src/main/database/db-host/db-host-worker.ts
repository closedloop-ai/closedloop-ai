/**
 * FEA-2038 / ISS-8246 M1 — DB host utilityProcess entry, now a DISPATCHER.
 *
 * It used to own the SQLite runtime and execute every op on this thread. That is
 * what made the db-host go silent: `@libsql/client` executes synchronously, so
 * while a long statement ran, this loop answered nothing — no renderer read, no
 * parent IPC, no cancel, no health probe. Measured at ZERO loop turns across a
 * 61 s import.
 *
 * The store now lives on a `node:worker_threads` thread (`db-store-worker.ts`),
 * and this module keeps only what must answer promptly:
 *
 *   - the `process.parentPort` message loop and the relay to main
 *   - the admission lanes (`db-host-op-lanes.ts`) and the pending-op queue
 *   - the FEA-2055 insights cache, and with it the ISS-7110 epoch
 *   - the FEA-3072 heap watchdog and the ISS-4823 pressure publication
 *   - the ISS-4430 profiler
 *
 * Everything that touches the database moved: `db-store-host.ts` opens it,
 * `db-store-ops.ts` holds the `store:` bodies, and `db-store-client.ts` is this
 * side's handle on that thread.
 *
 * What this dispatcher CANNOT do is preempt the store thread. Being responsive
 * means it always accepts and forwards a message, not that the store will see
 * one promptly: an `Execute` sits in the inner port's buffer until that thread's
 * loop turns, and a synchronous libSQL call gives it no turn. So a write
 * eviction (`importer.cancelInFlightWrite`) is not made prompt by the split — it
 * is an ordinary op on the same path as every other, which is why
 * `IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS` is still load-bearing (ISS-8246 M3), and
 * why the FEA-2264 cooperative yields inside the store ops still buy queued
 * reads their turn (ISS-8246 M2, measured).
 *
 * ISS-7256 carves out the one exception, and only for a READ. The eviction still
 * forwards, because mutating the queue belongs to the thread that owns it; the
 * read-only `importer.hasUndispatchedWrite` probe is answered HERE, off
 * `writeDispatchMirror`, because it is asked exactly during the window in which
 * forwarding it would return no answer at all.
 *
 * Reverse channel: unchanged as far as main is concerned. The main ↔ db-host
 * protocol (`db-host-protocol.ts`) did not move a field in this milestone, which
 * is why `db-host-client.ts` needed no edit — what changed is that a
 * worker-origin notification now travels store → dispatcher → main instead of
 * child → main.
 */

import {
  isStoreOpenTimeoutError,
  STORE_OPEN_TIMEOUT_EXIT_CODE,
} from "../../../shared/transient-db-host-error.js";
import { routeDurableLogsToSink } from "../../logging/durable-log-sink.js";
import { startDbHostProfiling } from "../../profiling/db-host-profiling.js";
import { setTelemetryRelaySink } from "../../telemetry/telemetry-relay-sink.js";
import { runDbHostCloseSequence } from "./db-host-close-sequence.js";
import { createDbHostDurableLogRelay } from "./db-host-durable-log.js";
import {
  type DbHostInvokeDeps,
  dispatchDbHostInvoke,
  PRISMA_SHRINK_MEMORY_OP,
} from "./db-host-invoke-dispatch.js";
import {
  getMemoryPressure,
  type HeapWatchdog,
  installProcessCrashLogging,
  measureOp,
  startHeapWatchdog,
} from "./db-host-memory-watchdog.js";
import { createDbHostOpLanes } from "./db-host-op-lanes.js";
import {
  type DbHostInitOptions,
  type DbHostRequest,
  DbHostRequestKind,
  type DbHostResponse,
  DbHostResponseKind,
  isDbHostRequest,
  serializeDbHostError,
} from "./db-host-protocol.js";
import { createDbHostResultDelivery } from "./db-host-result-delivery.js";
import { createDbHostStoreRelay } from "./db-host-store-relay.js";
import { createDbHostTelemetryRelaySink } from "./db-host-telemetry-relay.js";
import {
  createDbStoreClient,
  type DbStoreClient,
  serializedDbStoreError,
} from "./db-store-client.js";
import { InsightsResultCache, insightsCacheKey } from "./insights-cache.js";
import { createWriteDispatchMirror } from "./write-dispatch-mirror.js";
import { awaitMemoryPressureClearForAdmission } from "./yield-db-host-loop.js";

let storeClient: DbStoreClient | null = null;
/** True once the store thread reported a successful open. */
let storeOpen = false;
/** True from the moment main asks to Close, so a store exit is not a crash. */
let closing = false;
let heapWatchdog: HeapWatchdog | null = null;

// ISS-7882 — route THIS thread's durable main-log lines to main, which owns the
// only initialised file transport. The store thread installs its own copy of
// this sink into its own isolate and relays through `onDurableLog` below; both
// are needed, because a module-level singleton is per-isolate and this one drops
// lines in silence when un-installed.
//
// Installed FIRST at module load, before the crash logger and the profiler, so
// there is no window in which this process writes a durable line into the void;
// the install also replays whatever the imports above already buffered.
routeDurableLogsToSink(createDbHostDurableLogRelay({ post }));

// FEA-3072 — report OOM-adjacent throws/rejections to main before the process is
// killed. Installed once at module load (utilityProcess entry runs once).
installProcessCrashLogging(childLog);

// ISS-7109 — route this thread's telemetry to main, which owns the only
// initialised transport. Same per-isolate caveat as the durable-log sink above:
// the store thread has its own, relayed through `onTelemetry`.
setTelemetryRelaySink(createDbHostTelemetryRelaySink({ post, log: childLog }));

// ISS-4430 — env-gated profiling. `utilityProcess.fork` inherits the parent env,
// so the gate is read off `process.env` here rather than threaded through the
// fork options or Init.
const dbHostProfiling = startDbHostProfiling(process.env, childLog);

/**
 * FEA-2055 — caches `dashboard.getInsights` results, invalidates them on each
 * committed write (ISS-7110), debounces recompute during backfill, and
 * single-flights + concurrency-bounds the heavy computation.
 *
 * It stays on the DISPATCHER after ISS-8246 M1, which is what makes the epoch
 * bump an ordering contract rather than a function call — see
 * `handleCommittedWrite`.
 */
const insightsCache = new InsightsResultCache();

/**
 * ISS-7256 (whitlockk review) — the dispatcher's mirror of the store thread's write
 * queue, fed by `WriteTask` notices and read by the `hasUndispatchedWrite`
 * branch of the invoke dispatch.
 *
 * It lives on the DISPATCHER for the same structural reason `insightsCache`
 * does, and for a sharper one: the whole point is to hold an answer on the
 * thread that is still turning while the store thread is parked inside a
 * synchronous statement. See `write-dispatch-mirror.ts`.
 */
const writeDispatchMirror = createWriteDispatchMirror();

// The admission lanes. Which ops are exclusive, which take the bounded read
// lane, and which run ungated is decided in `db-host-op-lanes.ts`.
//
// Every lane shares the one FEA-3150 `admit` gate: a bounded, memory-aware
// pre-admission wait that keeps a heavy op from starting on top of an existing
// RSS/heap high-water. It defers, never deadlocks.
//
// ISS-8246 M1 — `admit` is given an explicit pressure reader. The default one
// reads `process.memoryUsage()`, whose `heapUsed` is PER-ISOLATE, and after the
// split this isolate allocates almost nothing: left alone, the gate's heap arm
// would silently stop firing while the heap it exists to protect grew a thread
// away. See `readCombinedMemoryUsage`.
const opLanes = createDbHostOpLanes({
  admit: () =>
    awaitMemoryPressureClearForAdmission({
      getPressure: () => getMemoryPressure(readCombinedMemoryUsage()),
      log: childLog,
    }),
  onBoundedTiming: dbHostProfiling?.onBoundedTiming,
  // ISS-12023 (PRD-785) — a whole-corpus scan has just finished, so hand its
  // 16 MiB-per-connection page cache back. The store owns the connections, so
  // this is one fire-and-forget hop to that thread; a store that is gone or not
  // yet open rejects and the reclaim is simply skipped, which is the correct
  // no-op rather than a failure worth surfacing.
  onExclusiveSettled: () => {
    storeClient?.execute(PRISMA_SHRINK_MEMORY_OP, []).catch(() => undefined);
  },
});

function post(message: DbHostResponse): void {
  process.parentPort.postMessage(message);
}

// ISS-12022 — posts each result as the bytes the store thread encoded, paged
// past one page and only as main pulls.
const resultDelivery = createDbHostResultDelivery({ post, log: childLog });

function childLog(message: string): void {
  post({ kind: DbHostResponseKind.Log, message });
}

/**
 * The memory sample every pressure decision in this process is made against.
 *
 * `heapUsed` takes the MAX of the two isolates rather than their sum, because
 * the threshold it is compared against (`DEFAULT_WARN_HEAP_BYTES`, 80% of
 * `heap_size_limit`) is itself per-isolate — each thread gets its own ~4 GiB
 * pointer-compression cage. Summing would compare two heaps against one cage
 * and report pressure that does not exist; taking the max asks the real
 * question, "is either isolate near ITS ceiling".
 *
 * `rss` comes from this thread only, because RSS is process-wide: both threads
 * observe the same number, and the local read is always the fresher of the two.
 *
 * Before the store publishes its first sample this degrades to exactly the old
 * behaviour — this thread's own figures — which is the correct no-evidence
 * default rather than a fabricated one.
 */
function readCombinedMemoryUsage(): { heapUsed: number; rss: number } {
  const own = process.memoryUsage();
  const store = storeClient?.latestStoreMemory();
  return {
    heapUsed: store ? Math.max(own.heapUsed, store.heapUsed) : own.heapUsed,
    rss: own.rss,
  };
}

/**
 * ISS-7110 / PLN-1837 §1.5 — apply the store thread's committed-write bump.
 *
 * SYNCHRONOUS, and that is the contract. The store fires its committed-write
 * observer BEFORE the write call returns, so `CommittedWrite` is queued on the
 * inner port ahead of that write's own `Result`; handling it without awaiting
 * means the epoch has already moved by the time the result is delivered to
 * main. An insights read issued immediately after a write therefore cannot
 * reuse the pre-write cache, which is what keeps the ISS-7110 onboarding-zeros
 * class from surviving the move.
 */
function handleCommittedWrite(): void {
  insightsCache.bumpDataEpoch();
}

/**
 * PLN-1837 §1.3 — the store thread died, so this process does too.
 *
 * Respawning the thread in place was the alternative and was rejected: it saves
 * a `utilityProcess.fork` and some dispatcher cache warmth, and nothing else — a
 * respawned store re-runs `openSqliteAgentDatabase`, the migration check and the
 * six awaited boot heals, which dominate either way. Against that it would owe
 * pending-request rejection, ready/init state, identity replay and stale-reply
 * fencing, all of it new code (ISS-5715,
 * ISS-5262, ISS-4713).
 *
 * Exiting reuses all of it instead: `DbHostClient.handleExit` rejects the
 * pending invokes with a typed `DbHostExitError` carrying whether a restart is
 * scheduled, clears the cached memory pressure, emits the exit telemetry, and
 * re-forks on the FEA-3072 crash-window ladder.
 *
 * Probe 8 is why this needs wiring at all: `process.exit()` inside a worker
 * stops the THREAD, so the store's own crash handler cannot reach the
 * supervisor. The exit is deferred one tick for the same reason
 * `installProcessCrashLogging` defers its own — `childLog` posts over parentPort
 * IPC, which flushes on the next loop turn, and a synchronous exit would drop
 * the line naming what happened.
 */
function handleStoreDeath(reason: string): void {
  if (closing) {
    return;
  }
  childLog(`db-host store thread lost: ${reason}`);
  setImmediate(() =>
    process.exit(
      isStoreOpenTimeoutError(reason) ? STORE_OPEN_TIMEOUT_EXIT_CODE : 1
    )
  );
}

/**
 * ISS-5941 — the dispatch body lives in `db-host-invoke-dispatch.ts` so a test
 * can drive the real routing branches; this module cannot be imported (it
 * registers a `parentPort` listener at load). Everything the dispatch needs
 * from here is injected below.
 *
 * `deliver` is the success-result post, and the dispatch awaits it INSIDE the
 * op's lane permit so the permit spans BOTH hops the result crosses — see that
 * file's header.
 */
function invokeDeps(
  deliver: (value: unknown) => Promise<void>
): DbHostInvokeDeps {
  return {
    lanes: opLanes,
    isOpen: () => storeOpen && storeClient !== null,
    runOnStore: (op: string, args: unknown[], cancellationToken?: string) => {
      const client = storeClient;
      if (!client) {
        return Promise.reject(new Error("db-host not initialized"));
      }
      return client.execute(op, args, cancellationToken);
    },
    probeUndispatchedWrite: (token) => writeDispatchMirror.probe(token),
    getInsights: (args, compute) =>
      insightsCache.get(insightsCacheKey(args), compute),
    deliver,
  };
}

async function handleInvoke(
  op: string,
  args: unknown[],
  deliver: (value: unknown) => Promise<void>,
  // ISS-6079: forwarded from the request. Absent => interactive.
  // ISS-9802: `cancellationToken` likewise — absent => uncancellable.
  options?: { background?: boolean; cancellationToken?: string }
): Promise<void> {
  // FEA-3072 — name the op in the log when it allocates heavily or leaves the
  // heap under pressure, so the recurring exit-code-5 crash stops being
  // anonymous.
  // ISS-4430 — the same wrapper records per-op wall time when profiling is on.
  // ISS-8246 M1 — the heap arm reads the COMBINED sample, or it would report
  // this thread's near-flat heap and never name the op that actually allocated.
  // The store publishes a fresh sample immediately before each result, so the
  // post-op figure is the op's own rather than one sampling tick old.
  const run = () =>
    dispatchDbHostInvoke(op, args, invokeDeps(deliver), options);
  await measureOp(op, childLog, run, {
    ...dbHostProfiling?.measureOpOptions,
    readMemoryUsage: readCombinedMemoryUsage,
  });
}

/**
 * Spawn the store thread and open the database on it.
 *
 * The store worker calls `openSqliteAgentDatabase` UNCHANGED: migrations, the
 * six awaited boot heals, connection construction and the PRAGMAs keep their
 * order, inside one function, on one thread. This milestone is a re-host, not a
 * resequencing.
 */
async function openStore(options: DbHostInitOptions): Promise<void> {
  // A second Init would otherwise leave the previous thread alive holding the
  // writer connection, which is the FEA-3628 single-writer invariant broken by
  // bookkeeping rather than by design.
  await storeClient?.terminate();
  storeOpen = false;
  // The queue this mirrors died with the thread that owned it; a retained entry
  // would be an answer about a task that no longer exists.
  writeDispatchMirror.reset();
  const client = createDbStoreClient(
    // PLN-1837 §1.4 — the whole relay table lives in `db-host-store-relay.ts`,
    // where a test can drive store → dispatcher → main end to end. This module
    // cannot be imported by one.
    createDbHostStoreRelay({
      post,
      onCommittedWrite: handleCommittedWrite,
      onWriteTask: (token, phase, taskSeq) =>
        writeDispatchMirror.observe(token, phase, taskSeq),
      onDeath: handleStoreDeath,
    })
  );
  storeClient = client;
  await client.open(options);
  storeOpen = true;
}

async function handleMessage(request: DbHostRequest): Promise<void> {
  switch (request.kind) {
    case DbHostRequestKind.Init: {
      try {
        await openStore(request.options);
        // FEA-3072 — begin heap-pressure sampling once the DB is open (the heavy
        // backfill/sync/read work starts after Ready). Re-init after a restart
        // replaces any prior watchdog.
        heapWatchdog?.stop();
        heapWatchdog = startHeapWatchdog({
          log: childLog,
          snapshotDir: request.options.dataDir,
          // ISS-8246 M1 — sample BOTH isolates. Without this the watchdog would
          // observe the dispatcher's near-empty heap and publish `"ok"` while
          // the store thread ran at its ceiling, silently disabling the ISS-4823
          // back-pressure arm the main-process DATA_REVISION rebuild consults.
          readMemoryUsage: readCombinedMemoryUsage,
          // ISS-4823 — publish this host's pressure level to main, which the
          // rebuild's adaptive write-pause gate reads.
          onPressureChange: (level) =>
            post({ kind: DbHostResponseKind.MemoryPressure, level }),
        });
        post({ kind: DbHostResponseKind.Ready, id: request.id });
      } catch (error) {
        // Main must observe the process exit before retrying against its SQLite file.
        if (isStoreOpenTimeoutError(error)) {
          return;
        }
        // PLN-1837 §1.2 — answer with an error and STAY ALIVE. A migration
        // refusal is deterministic, so exiting here would refuse again on every
        // restart; boot instead surfaces an Agent Monitor failure and registers
        // disabled DB IPC. `refusalKind` survives both hops, so
        // `db-host-client.ts` still rebuilds a typed `DesktopMigrationError`.
        post({
          kind: DbHostResponseKind.Ready,
          id: request.id,
          // Forward the store thread's own serialization when the failure came
          // from over there. Re-serializing a rebuilt Error would drop
          // ISS-4714's `refusalKind` — exactly the field `db-host-client.ts`
          // needs to rebuild a typed `DesktopMigrationError` — because
          // `serializeDbHostError` reads it off a real instance and this side
          // has none. Same for ISS-6337's `storageExhaustionReason`.
          error: serializedDbStoreError(error) ?? serializeDbHostError(error),
        });
      }
      return;
    }
    case DbHostRequestKind.Invoke: {
      try {
        // ISS-5941 — the success post is handed DOWN so it happens inside the
        // op's lane permit: the bytes it posts are the corpus-sized result the
        // lane's heap bound is meant to cover, until main has pulled them all.
        await handleInvoke(
          request.op,
          request.args,
          (value) => resultDelivery.deliver(request.id, value),
          {
            background: request.background === true,
            // Omitted rather than passed as `undefined`, so the store thread's
            // Execute keeps the shape it has today for an uncancellable op.
            ...(request.cancellationToken === undefined
              ? {}
              : { cancellationToken: request.cancellationToken }),
          }
        );
      } catch (error) {
        post({
          kind: DbHostResponseKind.Result,
          id: request.id,
          ok: false,
          // Lossless for the same reason as the Ready branch above: a disk-full
          // verdict is classified on the store thread, where the driver's
          // result code still exists.
          error: serializedDbStoreError(error) ?? serializeDbHostError(error),
        });
      }
      return;
    }
    case DbHostRequestKind.ResultPagePull: {
      resultDelivery.pull(request.id, request.offset);
      return;
    }
    case DbHostRequestKind.CancelRead: {
      // ISS-9802: only the store thread can abandon the work, so this hop just
      // forwards. Nothing is answered — the cancelled read rejects through its
      // own Invoke correlation — and a cancel that arrives after the op settled
      // finds no registered token and does nothing.
      storeClient?.cancelRead(request.token);
      return;
    }
    case DbHostRequestKind.SetUserIdentity: {
      // The identity mirror and the ISS-6168 unowned-session claim both live on
      // the store thread, which is the only side that can act on them.
      storeClient?.setIdentity(request.identity);
      return;
    }
    case DbHostRequestKind.Close: {
      // PLN-1837 §1.7. Set first: the store thread is about to exit on purpose,
      // and `handleStoreDeath` must not read that as a crash.
      closing = true;
      heapWatchdog?.stop();
      heapWatchdog = null;
      // Order is load-bearing — see `db-host-close-sequence.ts`. The diagnostics
      // artifact goes first BECAUSE closing the store drains the write queue and
      // can outlive main's 2s ack budget; that reasoning is unchanged by the
      // store being a thread away, so the same sequence still governs, with the
      // inner close bounded by `STORE_CLOSE_DEADLINE_MS` so this side can still
      // ack even when the store cannot finish.
      await runDbHostCloseSequence({
        stopProfiling: () => dbHostProfiling?.stop() ?? Promise.resolve(),
        closeDatabase: () => storeClient?.close() ?? Promise.resolve(),
      });
      // Terminate BEFORE acking main: the ack is main's signal that this host has
      // reached the shutdown point the single-process db-host used to reach, and
      // it must not be emitted while a store thread is still live.
      await storeClient?.terminate();
      storeClient = null;
      storeOpen = false;
      post({ kind: DbHostResponseKind.Result, id: request.id, ok: true });
      process.exit(0);
      return;
    }
    default:
      return;
  }
}

process.parentPort.on("message", (messageEvent) => {
  const data: unknown = messageEvent.data;
  if (!isDbHostRequest(data)) {
    return;
  }
  handleMessage(data).catch((error: unknown) => {
    post({
      kind: DbHostResponseKind.Log,
      message: serializeDbHostError(error).message,
    });
  });
});
