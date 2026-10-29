/**
 * @file prisma-client.ts
 * @description The single Prisma client for the desktop SQLite store.
 *
 * Wires `@prisma/adapter-libsql` onto the ALREADY-OPEN SQLite handle: one SQLite
 * instance, one writer client. The writer holds a single physical connection
 * (SQLite is single-connection), so every Prisma write and `$transaction` MUST
 * serialize through the write queue. That rule is TYPE-enforced: the public
 * `client` is a read-only facade ({@link DesktopPrismaReader}) on which mutation
 * methods don't exist, so the mutation-capable client is reachable only inside
 * `write(fn)`.
 *
 * The adapter is a single-maintainer community package: it is pinned to an
 * exact version (see apps/desktop/package.json) and confined to THIS module so
 * a swap to the FEA-1736 pre-approved in-house `SqlDriverAdapter` fallback
 * touches one file. Nothing outside this module imports the adapter.
 */

import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Config } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import {
  createStorageExhaustionTally,
  type StorageExhaustionHealth,
} from "../../shared/storage-exhaustion.js";
import { WalProbeAnomalyReason } from "../telemetry/telemetry-protocol.js";
import {
  connectionPragmaStatements,
  DEFAULT_READER_POOL_SIZE,
  IDLE_SHRINK_MEMORY_INTERVAL_MS,
  SQLITE_DEFAULT_PAGE_SIZE_BYTES,
  SQLITE_PAGE_SIZE_SQL,
  SQLITE_SHRINK_MEMORY_SQL,
  WAL_FILE_HEADER_BYTES,
  WAL_FRAME_HEADER_BYTES,
  WAL_TRUNCATE_CHECKPOINT_SQL,
  WAL_TRUNCATE_FRAME_CEILING,
  WAL_TRUNCATE_INTERVAL_MS,
  WAL_TRUNCATE_WRITE_COUNT,
} from "./connection-pragmas.js";
import { PrismaClient } from "./generated/client.js";
import {
  wrapRawCoercion,
  wrapWriterActivity,
} from "./prisma-client-proxies.js";
import {
  type CapturedStatement,
  hasStatementObserver,
  isThenable,
  type StatementObservers,
  withStatementSpy,
} from "./prisma-statement-observers.js";
import type { WriteQueueRunOptions } from "./write-queue.js";

/**
 * The subset of the sqlite.ts write queue the factory needs. Kept structural so
 * the factory does not depend on the queue's concrete module. `token` (ISS-4572)
 * tags a write with its owner so the queue's task-scoped `cancel(token)` can evict
 * exactly that owner's queued/in-flight write — the importer passes the session id.
 * `opts.class` (ISS-4710) picks the two-class fairness class; see
 * {@link WriteQueueRunOptions}.
 */
export type WriteSerializer = {
  run<T>(
    fn: () => Promise<T>,
    token?: string,
    opts?: WriteQueueRunOptions
  ): Promise<T>;
};

/** The read-only methods on a Prisma model delegate. */
type ReadDelegateMethod =
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
  | "findUnique"
  | "findUniqueOrThrow"
  | "aggregate"
  | "count"
  | "groupBy";

/** A model delegate narrowed to its read-only methods. */
type ReadDelegate<TDelegate> = Pick<
  TDelegate,
  Extract<keyof TDelegate, ReadDelegateMethod>
>;

/**
 * The Prisma client narrowed to reads: each model delegate exposes only its
 * read methods, and the write `$`-operations (`$transaction`, `$executeRaw*`,
 * `$queryRawTyped`, …) are dropped. This keeps the "writes go through the queue"
 * rule **type-enforced** for the typed surface — `prisma.client.x.create(...)`,
 * `$transaction`, and `$executeRaw*` are compile errors; mutations are reachable
 * only via {@link DesktopPrisma.write}.
 *
 * The exception is the raw READ escape hatch: `$queryRaw` / `$queryRawUnsafe`
 * are re-exposed for the aggregation / window / recursive-CTE SQL that has no
 * clean typed-delegate form (e.g. `COUNT(DISTINCT …)`, `GROUP BY`), so those
 * reads run on this one client. The read-vs-write split here is by convention —
 * SQL can't be statically classified — so raw **writes** must still go through
 * {@link DesktopPrisma.write}; do not smuggle a mutation through `$queryRaw*`.
 */
export type DesktopPrismaReader = {
  [K in keyof PrismaClient as K extends string
    ? K extends `$${string}`
      ? never
      : K
    : never]: ReadDelegate<PrismaClient[K]>;
} & Pick<PrismaClient, "$queryRaw" | "$queryRawUnsafe">;

/**
 * The client handed to {@link DesktopPrisma.read} — the read-only facade plus a
 * read-scoped interactive `$transaction`. A reader connection is `query_only`
 * (writes fault at the engine), and the transaction's `tx` is itself a
 * {@link DesktopPrismaReader}, so a write through the reader path is a compile
 * error AND a runtime fault. `$transaction` is needed because some pooled reads
 * (the analytics aggregation) run several `$queryRawUnsafe` reads that must see
 * ONE committed snapshot — a libSQL `deferred` read transaction pins it.
 */
export type DesktopPrismaReadClient = DesktopPrismaReader & {
  $transaction<T>(fn: (tx: DesktopPrismaReader) => Promise<T>): Promise<T>;
};

export type DesktopPrisma = {
  /**
   * The typed client narrowed to reads (see {@link DesktopPrismaReader}), bound
   * to the PRIMARY (writer) connection. Use for light reads co-located with
   * writes (read-your-writes). Mutations are a compile error here — route them
   * through {@link DesktopPrisma.write}. Reads that must not block on the backfill
   * writer's LOCKS go to {@link DesktopPrisma.read}, which defines "concurrent".
   */
  readonly client: DesktopPrismaReader;
  /**
   * Run a unit of Prisma work — a write or `$transaction` — serialized through
   * the shared write queue. This is the structural enforcement point for the
   * "all Prisma writes go through the queue" rule; the callback receives the
   * full, mutation-capable client.
   *
   * ISS-4572: `token` tags the queued write with its owner (the session id on the
   * historical-import path) so a per-session timeout can evict exactly that
   * session's write via `cancelInFlightWrite` — never an unrelated one at the
   * queue head. Omit it for writes that must never be evicted (live hooks,
   * maintenance).
   *
   * ISS-4710: `opts.class` tags the write's fairness class. Bulk backfill/rebuild
   * writes pass `class: "bulk"` so the writer's weighted round-robin lets the
   * hot-path transcript/component `interactive` writes (the default) keep making
   * progress during a rebuild instead of queueing behind the whole backfill.
   */
  write<T>(
    fn: (client: PrismaClient) => Promise<T>,
    token?: string,
    opts?: WriteQueueRunOptions
  ): Promise<T>;
  /**
   * Run a READ against the reader pool: round-robin to a dedicated `query_only`
   * reader connection, each reading a committed WAL snapshot that never waits on
   * the writer's locks and self-serializing its statements via the adapter's
   * per-connection mutex. Callback gets a {@link DesktopPrismaReadClient}.
   * ISS-8246 M4 — that is lock-freedom, NOT concurrent execution: one JS thread
   * drives every connection and libSQL is synchronous, so a read runs AFTER the
   * owning statement. The FEA-2264 yields interleave; see the AGENTS.md here.
   */
  read<T>(fn: (client: DesktopPrismaReadClient) => Promise<T>): Promise<T>;
  /**
   * ISS-4818: health of the WAL-depth probe that backs the checkpoint cadence's
   * ceiling backstop, for the window SINCE THE PREVIOUS CALL. Synchronous and
   * store-free (it reads in-process counters), but NOT idempotent: each call
   * consumes the window it reports, so there is exactly one consumer — the
   * store-integrity probe. See {@link WalProbeHealth} and the implementation
   * comment for why a lifetime tally would make the health state unrecoverable.
   */
  readWalProbeHealth(): WalProbeHealth;
  /**
   * ISS-6337: write failures classified as an out-of-space condition, for the
   * window SINCE THE PREVIOUS CALL. Same consuming-read contract (and the same
   * reason for it) as {@link readWalProbeHealth}; see
   * {@link createStorageExhaustionTally}.
   */
  readStorageExhaustionHealth(): StorageExhaustionHealth;
  /**
   * ISS-12023 (PRD-785): run `PRAGMA shrink_memory` on every connection this
   * client owns — the writer plus each reader — releasing the page cache
   * `connection-pragmas.ts` sizes at 16 MiB per connection. Skips any connection
   * with work in flight, since a shrink there would free nothing it is not about
   * to re-read.
   *
   * Clone-safe (no args, no result), so it is callable as the dotted db-host op
   * `prisma.shrinkMemory` — which is how the dispatcher reclaims after a
   * heavy-gate op. The idle path needs no caller: this client runs its own timer
   * (see `IDLE_SHRINK_MEMORY_INTERVAL_MS`).
   *
   * Best-effort by design: a connection whose pragma fails is left alone and the
   * next pass retries it, so in production wiring this never rejects — the only
   * throw path is the test-only `onShrinkMemory` hook.
   */
  shrinkMemory(): Promise<void>;
  /**
   * Release every Prisma client's pooled state (writer + reader pool). The
   * boot-time migration handle is owned and closed separately by
   * openSqliteAgentDatabase.
   */
  disconnect(): Promise<void>;
};

/**
 * The MAIN-process view of {@link DesktopPrisma} reached through the db-host
 * forwarding proxy (FEA-2038). Narrowed to ONLY the clone-safe `client` reads
 * (forwarded op-by-op). `read(fn)` / `write(fn)` take callbacks that cannot be
 * structured-cloned across the IPC boundary, and `disconnect()` would let main
 * close the child's Prisma clients out from under the still-live db host, so all
 * three are omitted: using any of them over the proxy is a COMPILE error rather
 * than a runtime hazard. Writes from main must run in the child via a clone-safe
 * SqliteAgentDatabase method or a store op.
 */
export type DbHostPrisma = Pick<DesktopPrisma, "client">;

/**
 * Compile-time guard: {@link DesktopPrismaReader} must expose NO mutation
 * methods. If a future Prisma/type change ever leaks one onto a model delegate,
 * `AssertTrue` receives `false` and this fails to build — keeping
 * "type-enforced read-only" literally true.
 */
type AssertTrue<T extends true> = T;
type DelegateHasNoMutations<TDelegate> =
  Extract<
    keyof TDelegate,
    | "create"
    | "createMany"
    | "update"
    | "updateMany"
    | "upsert"
    | "delete"
    | "deleteMany"
  > extends never
    ? true
    : false;
export type _DesktopPrismaReaderIsReadOnly = AssertTrue<
  DelegateHasNoMutations<DesktopPrismaReader["packCatalog"]>
>;

/** Open one PrismaClient over its OWN libSQL connection and apply the role's
 * PRAGMAs. Each PrismaClient = one adapter = one libSQL connection = one
 * per-connection mutex, so a writer and N readers are genuinely independent
 * connections over the same WAL file (verified: a reader reads a committed
 * snapshot while the writer holds an open write transaction) — but independent
 * CONNECTIONS, not independent execution: one JS thread drives them all. */
// Prisma's interactive `$transaction` defaults (maxWait 2s, timeout 5s) would
// kill exactly the backfill-concurrent analytics GROUP BY scans this pool exists
// to serve (and the importer's write transactions), so we use a generous ceiling
// that still bounds a genuinely hung transaction (LOCK waits are separately
// bounded by the 15s busy_timeout). Applies to every `$transaction` on the
// client — the reader snapshot aggregations and the writer import txs.
const TRANSACTION_MAX_WAIT_MS = 30_000;
/**
 * Exported so a caller layering its OWN deadline on top can compare against the
 * real value rather than a copy — `db-store-deadlines.ts` derives
 * `STORE_INVOKE_DEADLINE_MS` from it, and its test asserts the ordering.
 */
export const TRANSACTION_TIMEOUT_MS = 120_000;

// FEA-3132 (D4/D5): how often to recycle IDLE reader connections. Each reader in
// WAL mode holds a committed snapshot; a reader that finished a query but hasn't
// been reused keeps pinning the WAL frames back to its snapshot, so the throttled
// TRUNCATE checkpoint can't reclaim and the -wal grows (the 26 GB / RSS mode,
// invisible to heapUsed). Recycling an idle reader (disconnect + reopen) releases
// its snapshot so the next checkpoint reclaims. A wall-clock cap that ABORTED a
// running query would NOT help — the statement keeps executing and pinning the
// snapshot (see FEA-3139); recycling only touches IDLE connections, never an
// in-flight read.
const DEFAULT_READER_RECYCLE_INTERVAL_MS = 30_000;

async function openPrismaConnection(
  config: Config,
  role: "writer" | "reader",
  observers: StatementObservers = {}
): Promise<PrismaClient> {
  // The adapter's `@libsql/client` is PATCHED (patches/@libsql__client@0.17.3.patch):
  // stock `transaction()` detaches the native connection and never closes it, so
  // every Prisma `$transaction` leaked a connection (~2 fds + native buffers)
  // until fd/memory exhaustion killed the db-host (the exit-code-5 crash storm)
  // AND silently shed this module's per-connection PRAGMAs — `query_only`,
  // `busy_timeout`, the WAL checkpoint bounds — on the lazily recreated
  // replacement. The patch keeps ONE native connection per client for its whole
  // lifetime, which the per-connection mutex already serializes.
  const factory = new PrismaLibSql(config);
  const client = new PrismaClient({
    adapter: hasStatementObserver(observers)
      ? withStatementSpy(factory, observers)
      : factory,
    transactionOptions: {
      maxWait: TRANSACTION_MAX_WAIT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    },
  });
  // Apply on the raw client: PRAGMA goes through $executeRawUnsafe (a mutation
  // method the read facade hides), and these statements carry no `$N` params, so
  // the coercion wrapper is unnecessary here. The first statement also forces the
  // adapter's lazy connect, so the connection is live before it serves work.
  for (const statement of connectionPragmaStatements(role)) {
    await client.$executeRawUnsafe(statement);
  }
  return client;
}

/**
 * Narrow a writer-capable PrismaClient to the read-only client handed to
 * {@link DesktopPrisma.read}. The downcast is SOUND, not a bypass: the wrapper
 * returns the SAME runtime object (a full PrismaClient), and
 * {@link DesktopPrismaReadClient} is a structural SUBSET of it — read delegates
 * + `$queryRaw*` + a callback-only `$transaction`. The compiler can't verify the
 * `$transaction` overload narrowing (PrismaClient's also accepts the array
 * form), so the one cast is localized here; the read-only-ness of the delegate
 * surface is separately compile-asserted by {@link _DesktopPrismaReaderIsReadOnly},
 * and `query_only=ON` backstops any write at the engine.
 */
function asReadClient(raw: PrismaClient): DesktopPrismaReadClient {
  return wrapRawCoercion(raw) as DesktopPrismaReadClient;
}

/**
 * Build the desktop Prisma layer over the libSQL `config`: ONE writer connection
 * (all writes + primary-connection reads via `client`) plus a small pool of
 * `query_only` reader connections (concurrent reads via `read`). This is the
 * single owner of the desktop store's connection topology. Writes serialize
 * through `queue`; a time-gated TRUNCATE checkpoint (with a write-count floor that
 * can only suppress a timer-eligible fire, plus a WAL-frame ceiling backstop —
 * ISS-4723 / ISS-4819) runs after writes to bound WAL/RSS during the backfill,
 * firing at most once per WAL_TRUNCATE_INTERVAL_MS.
 *
 * Async because each connection applies its PRAGMAs before serving work.
 */
export type CreateDesktopPrismaOptions = {
  readerPoolSize?: number;
  readerRecycleIntervalMs?: number;
  /**
   * ISS-12023: override for BOTH halves of the idle shrink cadence — how long
   * the store must be quiet before its connections release their caches, and how
   * often that idleness is re-checked. One knob, as
   * {@link IDLE_SHRINK_MEMORY_INTERVAL_MS} explains; a test shortens it so the
   * idle path is exercised without a long wait.
   */
  idleShrinkIntervalMs?: number;
  /**
   * ISS-12023: test/observability hook fired when a `PRAGMA shrink_memory` pass
   * has fully settled, with the NUMBER OF CONNECTIONS whose pragma succeeded
   * (mirrors {@link onReaderRecycle} / {@link onWalTruncate}). Fires on every
   * pass, including one that shrank nothing because every connection was busy.
   *
   * The count is the assertion that makes "each connection" testable: a pass
   * over a writer plus a 2-reader pool reports 3, and a pragma the engine
   * rejected on one of them — the real risk, since readers are `query_only` —
   * reports fewer instead of failing silently. Not used in production wiring.
   */
  onShrinkMemory?: (shrunk: number) => void;
  /**
   * ISS-5336: test/observability hook fired with each statement a connection
   * hands the driver adapter's `queryRaw`, JUST BEFORE it runs. The planner
   * guard (`test/import-pending-sentinel-scan.test.ts`) captures the
   * import-health probe's real statement here and EXPLAINs THAT, so a Prisma
   * upgrade or a `findMany` edit that changes the emitted SQL moves the
   * assertion with it instead of leaving a hand-copied statement green while the
   * production probe drifts back onto a table scan.
   *
   * Scope is the adapter's `queryRaw` entry point — every statement the engine
   * plans as a row-returning query, INCLUDING the ones an interactive
   * transaction serves through its own `Transaction` object (ISS-9117: a read
   * that takes a snapshot to bound what it materializes would otherwise go
   * invisible here, and "0 statements" is indistinguishable from "the read never
   * ran"). NOT `executeRaw` — PRAGMAs and row-count-only statements — and not
   * the `BEGIN`/`COMMIT` the adapter issues around a transaction, which are not
   * row-returning queries. The spy reaches the factory through a Proxy's default
   * traps, so an adapter or Prisma upgrade that changes how the client consumes
   * the factory should re-verify it still fires. Not used in production wiring.
   */
  onStatement?: (statement: CapturedStatement) => void;
  /**
   * ISS-6339: production observability hook fired when a statement SETTLES —
   * the same adapter `queryRaw` boundary {@link onStatement} watches, but after
   * the driver has resolved or rejected it, with the elapsed milliseconds.
   *
   * Deliberately `(sql, durationMs)` and NOT a {@link CapturedStatement}: this
   * one IS wired in production, on every statement the store runs, so it must
   * not allocate an object and a copy of the bindings per query the way the
   * before-hook does. The recorder behind it classifies `sql` into a bounded
   * statement FAMILY and drops the text — nothing keeps a reference to it.
   *
   * Fires for a REJECTED statement too, with the time spent before the failure.
   * A query that took four seconds and then threw is exactly the query a
   * slow-query signal exists to show.
   */
  onStatementSettled?: (sql: string, durationMs: number) => void;
  /**
   * Test/observability hook fired AFTER a reader slot has been successfully
   * recycled (idle reader swapped for a fresh `query_only` connection). Lets a
   * test wait on an OBSERVED recycle rather than a fixed sleep, so a regression
   * that stops recycling fails the test instead of silently passing. Not used in
   * production wiring.
   */
  onReaderRecycle?: (slot: number) => void;
  /**
   * ISS-4723 / ISS-4819: injectable clock for the TRUNCATE-checkpoint cadence's
   * time floor. Defaults to the MONOTONIC `performance.now()` — NOT `Date.now()`.
   * The cadence compares an elapsed span against a stamp taken on a previous
   * write, and a wall clock can step BACKWARD (NTP correction, a user changing
   * the system clock, a laptop resuming from sleep with a corrected clock). Under
   * a wall clock a backward step makes every subsequent `now() - lastTruncateAt`
   * negative, so the time floor never opens and the cadence stops reclaiming
   * entirely until wall time catches up — a strictly worse outcome than the base
   * cadence. `performance.now()` is monotonic within the process and cannot
   * regress, so the production path is immune by construction; the gate ALSO
   * recovers explicitly from a regression (see `maybeTruncateWal`) so an injected
   * or otherwise non-monotonic clock can never wedge it either. A test injects a
   * fake clock so the time floor is exercised deterministically without a
   * wall-clock sleep.
   */
  now?: () => number;
  /**
   * ISS-4723 / ISS-4819: test/observability hook fired each time the throttled
   * `wal_checkpoint(TRUNCATE)` is DISPATCHED (mirrors {@link onReaderRecycle}).
   * Lets a test count fires against the time/count/ceiling gate instead of
   * asserting on wall-clock timing. Not used in production wiring.
   */
  onWalTruncate?: () => void;
  /**
   * ISS-4819: test/observability hook fired when a write's maintenance pass has
   * fully SETTLED — after the time/count gate, any WAL-size probe it awaited, and
   * any TRUNCATE dispatch — including the early-return paths that do nothing. The
   * maintenance continuation is chained off the write's own promise and may await
   * the size probe, so it settles an indeterminate number of microtasks after the
   * write resolves; a test that flushes a FIXED tick count is a bounded poll that
   * can land short and flake (it did). This is the real completion signal the
   * desktop `test:node` determinism rule requires a test to synchronize on. Not
   * used in production wiring.
   */
  onWalMaintenanceSettled?: () => void;
  /**
   * ISS-4723 / ISS-4819: override for the WAL-depth read. Production measures the
   * `-wal` sidecar FILE SIZE (a pure `fs.stat`, never a checkpoint) and converts
   * bytes to frames with the store's real page size; a test injects a fixed frame
   * count so the ceiling-force branch can be exercised deterministically (a test
   * store's WAL never naturally reaches the ceiling). Not used in production
   * wiring.
   */
  probeWalFrames?: () => number | Promise<number>;
};

export async function createDesktopPrisma(
  config: Config,
  queue: WriteSerializer,
  options?: CreateDesktopPrismaOptions
): Promise<DesktopPrisma> {
  // Track every client we open so a failure PART-WAY through construction (a
  // reader connection or one of its PRAGMAs throwing) doesn't leak the
  // already-opened writer/readers — their handles + WAL/-shm files would stay
  // pinned. Disconnect them all before rethrowing.
  const opened: PrismaClient[] = [];
  // ISS-6339: built ONCE and reused by every connection this factory opens —
  // including a recycled reader. Rebuilding it per call site is how the ISS-5336
  // before-hook ended up on the initial readers but not on their replacements,
  // so a recycled slot ran unobserved for the rest of the process.
  const observers: StatementObservers = {
    onStatement: options?.onStatement,
    onStatementSettled: options?.onStatementSettled,
  };
  const open = async (role: "writer" | "reader"): Promise<PrismaClient> => {
    const client = await openPrismaConnection(config, role, observers);
    opened.push(client);
    return client;
  };

  try {
    const writerRaw = await open("writer");
    const writer = wrapRawCoercion(writerRaw);

    const poolSize = Math.max(
      1,
      options?.readerPoolSize ?? DEFAULT_READER_POOL_SIZE
    );
    const readerRaws: PrismaClient[] = [];
    for (let i = 0; i < poolSize; i++) {
      readerRaws.push(await open("reader"));
    }
    const readers = readerRaws.map(asReadClient);
    let readerCursor = 0;

    // FEA-3132 (D4/D5): idle-reader recycling. `inFlight[i]` counts the reads
    // currently running on reader slot `i`; only slots with 0 in-flight reads are
    // recycled, so an in-progress query is never torn out from under a caller.
    const inFlight = new Array<number>(poolSize).fill(0);
    const recycleIntervalMs =
      options?.readerRecycleIntervalMs ?? DEFAULT_READER_RECYCLE_INTERVAL_MS;
    let recycling = false;
    // Set once disconnect() begins. A recycle tick paused in its `await
    // openPrismaConnection` below must NOT swap its freshly-opened handle into a
    // pool that disconnect() has already torn down — that would leave the new
    // Prisma/libSQL handle (and its WAL/-shm files) open past teardown. The flag
    // makes the post-await continuation close `fresh` instead of swapping.
    let closed = false;
    // The promise for the recycle tick currently in flight (if any), so
    // disconnect() can await it after setting `closed` — guaranteeing any
    // paused continuation has closed its spare before the pool is torn down.
    let activeRecycle: Promise<void> = Promise.resolve();
    const recycleIdleReaders = async (): Promise<void> => {
      if (recycling || closed) {
        return;
      }
      recycling = true;
      try {
        for (let i = 0; i < poolSize; i++) {
          if (inFlight[i] !== 0) {
            continue;
          }
          // Open the replacement FIRST — the only await — so the recheck + swap +
          // old-disconnect below run synchronously and cannot race a read that
          // grabs this slot. A transient open failure keeps the existing reader.
          let fresh: PrismaClient;
          try {
            fresh = await openPrismaConnection(config, "reader", observers);
          } catch {
            continue;
          }
          // Shutdown may have begun while this tick was paused in the await
          // above; the pool is already (or about to be) disconnected, so close
          // the spare instead of swapping it in and leaking its handle.
          if (closed) {
            fresh.$disconnect().catch(() => undefined);
            continue;
          }
          if (inFlight[i] === 0) {
            const old = readerRaws[i];
            readerRaws[i] = fresh;
            readers[i] = asReadClient(fresh);
            old.$disconnect().catch(() => undefined);
            options?.onReaderRecycle?.(i);
          } else {
            // A read claimed this slot during open(); drop the spare.
            fresh.$disconnect().catch(() => undefined);
          }
        }
      } finally {
        recycling = false;
      }
    };
    const recycleTimer = setInterval(() => {
      activeRecycle = recycleIdleReaders().catch(() => undefined);
    }, recycleIntervalMs);
    // Don't keep the process alive solely for reader recycling.
    recycleTimer.unref?.();

    // Throttled TRUNCATE checkpoint on the writer connection. It runs DIRECTLY on
    // the writer client (not through the write queue): the adapter's
    // per-connection mutex already serializes it against any open write
    // transaction on that connection, so it cannot collide — and routing it
    // through the queue would (a) needlessly block queued writes behind a
    // checkpoint and (b) count as a write to the queue. A BUSY result (a reader
    // still pinning the WAL tail) is swallowed — autocheckpoint retries and the
    // next write reschedules. Fire-and-forget so it never delays the write whose
    // completion triggered it, but the latest in-flight checkpoint is tracked in
    // `walTruncateTail` so `disconnect()` can drain it before tearing down.
    //
    // ISS-4723 / ISS-4819: the TRUNCATE no longer fires after EVERY settled write
    // (which walked the whole WAL each time on a ~1 GB store). The reclaim rate is
    // bounded by TIME as the PRIMARY floor: a TRUNCATE fires at most once per
    // WAL_TRUNCATE_INTERVAL_MS — exactly the throttle the pre-ISS-4723 cadence had.
    // ISS-4819 corrects the count gate to an AND that can only SUPPRESS a
    // timer-eligible fire, never add one (the earlier `||` term could fire MORE
    // often than the base whenever a burst of writes landed inside a 5s window —
    // the opposite of reducing the tax): once the interval has elapsed, the
    // TRUNCATE fires only if WAL_TRUNCATE_WRITE_COUNT writes also accumulated,
    // otherwise the low-value reclaim is HELD. A WAL-frame ceiling is the only
    // off-floor trigger: on a held interval the WAL depth is read and a runaway WAL
    // is force-reclaimed, so holding can never let it grow.
    //
    // That depth read is a `-wal` FILE STAT, never a `wal_checkpoint(PASSIVE)`.
    // Reading the depth from PASSIVE would itself perform a checkpoint, so a held
    // interval that then force-fired would cost a PASSIVE **plus** a TRUNCATE — two
    // checkpoint operations where the base 5s throttle did one, inverting the goal.
    // With a free size signal the ONLY checkpoint operation this cadence can
    // perform is the TRUNCATE itself, at most once per interval, so the
    // fewer-or-equal claim holds on every workload including a single large
    // transaction landing on an elapsed interval. Net effect vs the base: on a busy
    // store the write floor is met every interval so the reclaim rate is unchanged;
    // on a quiet tail the hold drops reclaims the base would have run. The passive
    // wal_autocheckpoint=256 + journal_size_limit remain the actual RSS bounds —
    // this only changes how often the file is reclaimed to zero, and only downward.
    // Monotonic by default (see the `now` option's note): the cadence's floors are
    // elapsed-span comparisons against a stamp, and a wall clock that steps
    // backward would make every span negative and wedge the gate shut.
    const now = options?.now ?? (() => performance.now());
    let lastWalTruncateAt = 0;
    let writesSinceCheckpoint = 0;
    let walTruncateTail: Promise<unknown> = Promise.resolve();
    // The latest in-flight `maybeTruncateWal` run. Unlike `walTruncateTail` (only
    // set when a TRUNCATE actually fires), this tracks the whole maintenance
    // continuation — including the awaited WAL-size read — so `disconnect()` can
    // drain a read that is suspended mid-round-trip and never close `writerRaw`
    // out from under it.
    let walMaintenanceTail: Promise<unknown> = Promise.resolve();
    // The `-wal` sidecar this store's WAL lives in, or null for a config with no
    // local file to measure (in-memory / remote), where the depth is unknowable.
    const walPath = walSidecarPath(config.url);
    // ISS-4818: is this store's WAL depth measurable AT ALL? Only a measurable
    // store can produce a MALFORMED depth read, so this scopes the anomaly tally
    // (see `walSizeVerdict`). A test that injects `probeWalFrames` opts in
    // deliberately, so an injected probe is treated as measurable.
    const walDepthMeasurable =
      walPath !== null || Boolean(options?.probeWalFrames);
    // ISS-4818: WAL-depth-probe health. The correctness half (never read a bad
    // value as an empty WAL) landed in ISS-4723 PR1 / ISS-4819 — the parse returns
    // `null` and the cadence takes the explicit unknown fallback. But that
    // degraded silently, so a store whose depth read is CHRONICALLY broken runs
    // with the WAL ceiling backstop permanently disabled and nothing says so.
    // These counters are the boundary evidence, surfaced through the clone-safe
    // `readWalProbeHealth` below and classified by the FEA-1999 store-integrity
    // probe into the ALREADY-MONITORED `Observability.storeIntegrityResult`
    // event — which owns its own detected/persistent/recovered emit cadence, so
    // this needs no rate limiter of its own. Nothing is persisted: a bad read
    // yields a tally, never a stored record.
    let walProbeAttempts = 0;
    let walProbeAnomalies = 0;
    let lastWalProbeAnomalyReason: WalProbeAnomalyReason | null = null;
    // ISS-4818 follow-up: how much of the tallies a previous `readWalProbeHealth`
    // has already reported. The raw counters stay monotonic (they are the honest
    // since-boot record), but the READ is windowed — see that method for why a
    // lifetime tally cannot be used as a point-in-time verdict.
    let walProbeAttemptsReported = 0;
    let walProbeAnomaliesReported = 0;
    const recordWalProbeAnomaly = (reason: WalProbeAnomalyReason): void => {
      walProbeAnomalies += 1;
      lastWalProbeAnomalyReason = reason;
    };
    // The store's page size, needed to convert the sidecar's byte size to frames.
    // Read ONCE from the store and cached — `PRAGMA page_size` is a plain read, not
    // a checkpoint — so the conversion is exact instead of assuming the 4 KiB
    // default. Falls back to that default if the read is unavailable.
    let pageSizeBytes: number | null = null;
    const readPageSizeBytes = async (): Promise<number> => {
      if (pageSizeBytes !== null) {
        return pageSizeBytes;
      }
      let resolved: number | null = null;
      try {
        const rows =
          await writerRaw.$queryRawUnsafe<unknown[]>(SQLITE_PAGE_SIZE_SQL);
        resolved = readPragmaNumber(rows, "page_size");
      } catch {
        resolved = null;
      }
      pageSizeBytes =
        resolved === null || resolved <= 0
          ? SQLITE_DEFAULT_PAGE_SIZE_BYTES
          : resolved;
      return pageSizeBytes;
    };
    const fireWalTruncate = (): void => {
      lastWalTruncateAt = now();
      writesSinceCheckpoint = 0;
      options?.onWalTruncate?.();
      walTruncateTail = writerRaw
        .$executeRawUnsafe(WAL_TRUNCATE_CHECKPOINT_SQL)
        .then(
          () => undefined,
          () => undefined
        );
    };
    // Read the current WAL depth in frames. Production measures the `-wal` sidecar
    // FILE SIZE — a pure `fs.stat`, NOT a checkpoint (see the note on
    // WAL_FILE_HEADER_BYTES) — and converts bytes to frames with the store's real
    // page size. A missing sidecar means the WAL has been fully reclaimed, which is
    // a genuine depth of 0, not an unknown. Yields `null` only when the depth is
    // genuinely UNKNOWABLE (no local file to measure, or the stat failed for a
    // reason other than the file being absent) so the caller can take the explicit
    // unknown fallback rather than read a failure as an empty WAL. A test injects
    // `probeWalFrames` to drive the ceiling branch deterministically.
    const probeWalFrames: () => number | null | Promise<number | null> =
      options?.probeWalFrames ??
      (async (): Promise<number | null> => {
        if (walPath === null) {
          return null;
        }
        let sizeBytes: number;
        try {
          sizeBytes = (await stat(walPath)).size;
        } catch (error) {
          return isMissingFileError(error) ? 0 : null;
        }
        return walFramesFromFileBytes(sizeBytes, await readPageSizeBytes());
      });
    // The hold-vs-force decision: the time floor has elapsed but the write floor is
    // short, so the cadence is about to HOLD this interval's reclaim. Read the WAL
    // depth and force a TRUNCATE only if it is over the ceiling — the sole memory
    // backstop that keeps a quiet-but-ballooning WAL bounded.
    //
    // Because the depth read is a file stat rather than a PASSIVE checkpoint, it is
    // FREE: consulting it costs no SQLite work, holds no lock, and walks no pages.
    // That is what makes the cadence's bound hold — the only checkpoint operation
    // this cadence can ever perform is the TRUNCATE itself, at most once per
    // interval, so it is provably ≤ the base 5s throttle on every workload. It also
    // removes the need for a separate probe throttle: the decision can be re-taken
    // on every write past the time floor without accumulating any checkpoint tax.
    //
    // UNKNOWN is NOT treated as "under the ceiling". A failed read is not evidence
    // that the WAL is small, and swallowing it would leave a large final
    // transaction with no reclaim at all and no retry unless another write happened
    // to arrive. On unknown the cadence falls back to exactly what the base 5s
    // throttle did at this point — fire the timer TRUNCATE — which is by
    // construction never MORE work than the base.
    const walSizeVerdict = async (): Promise<WalSizeVerdict> => {
      // ISS-4818: only a store with a `-wal` sidecar to measure can produce a
      // MALFORMED depth read. For an in-memory/remote store `walPath` is null and
      // an unknown depth is the correct, expected answer — tallying it would
      // report a permanent anomaly on every such store and drown the real signal.
      // So the tally is taken strictly inside the measurable branch, per the
      // "increment only where the precondition held" rule.
      if (!walDepthMeasurable) {
        return WalSizeVerdict.Unknown;
      }
      walProbeAttempts += 1;
      try {
        const raw = await probeWalFrames();
        const frames = raw === null ? null : toWalFrameCount(raw);
        if (frames === null) {
          // The read completed against a measurable store but yielded no usable
          // frame count: a stat failure other than "file absent", or a
          // missing/renamed/negative/non-numeric value from an injected probe.
          // The graceful fallback below is unchanged — this only makes a
          // CHRONICALLY failing probe (and therefore a disabled ceiling backstop)
          // observable instead of silent.
          recordWalProbeAnomaly(WalProbeAnomalyReason.MalformedRow);
          return WalSizeVerdict.Unknown;
        }
        return frames > WAL_TRUNCATE_FRAME_CEILING
          ? WalSizeVerdict.Over
          : WalSizeVerdict.Under;
      } catch {
        recordWalProbeAnomaly(WalProbeAnomalyReason.ProbeThrew);
        return WalSizeVerdict.Unknown;
      }
    };
    const runWalMaintenance = async (): Promise<void> => {
      // `maybeTruncateWal` is fire-and-forget off each settled write and may await
      // the WAL-frame probe, so a continuation can resume AFTER disconnect() set
      // `closed` and began tearing down the writer connection. Bail on `closed` at
      // both suspension points so a probe/TRUNCATE never runs against a closing
      // handle (the queries would reject and be swallowed, but skipping them keeps
      // disconnect's walTruncateTail drain a real guarantee).
      if (closed) {
        return;
      }
      writesSinceCheckpoint += 1;
      const at = now();
      // Clock-regression recovery. The production clock is monotonic so this
      // cannot trigger there, but the cadence must never DEPEND on that: if the
      // clock ever moves backward, `at` lands before a stamp taken on an earlier
      // write, every elapsed span goes negative, and the time floor below would
      // stay shut for as long as the regression lasts — suppressing not just the
      // timer reclaim but (because they sit behind the same floor) the write-count
      // path and the WAL-size backstop with it, letting the WAL grow unchecked.
      // A stamp in the future is by definition unusable, so re-anchor it to
      // exactly one interval ago: the gate resumes on THIS write and the normal
      // count/size logic decides, rather than the cadence going dark.
      if (at < lastWalTruncateAt) {
        lastWalTruncateAt = at - WAL_TRUNCATE_INTERVAL_MS;
      }
      // Primary floor: never reclaim more than once per interval. Below it, do
      // nothing at all — no size read, no TRUNCATE — exactly like the base cadence,
      // so the busy write path adds ZERO work until the interval elapses.
      if (at - lastWalTruncateAt < WAL_TRUNCATE_INTERVAL_MS) {
        return;
      }
      // Interval elapsed. If enough writes accumulated, reclaim now (this is the
      // busy-store path — it never reads the WAL size). The count floor is an AND
      // on top of the time floor, so it can only SUPPRESS a fire the base would
      // have run.
      if (writesSinceCheckpoint >= WAL_TRUNCATE_WRITE_COUNT) {
        fireWalTruncate();
        return;
      }
      // Interval elapsed but few writes: HOLD this low-value reclaim only if the
      // free size read positively confirms the WAL is under the ceiling. Over the
      // ceiling is the memory backstop; UNKNOWN falls back to the base timer
      // TRUNCATE rather than assuming the WAL is small (see `walSizeVerdict`).
      const verdict = await walSizeVerdict();
      if (closed || verdict === WalSizeVerdict.Under) {
        return;
      }
      fireWalTruncate();
    };
    // Wrap the pass so the settled signal fires on EVERY path — including the
    // early returns that do no work — giving a test one deterministic point to
    // await instead of guessing how many microtasks the pass consumed.
    const maybeTruncateWal = async (): Promise<void> => {
      try {
        await runWalMaintenance();
      } finally {
        options?.onWalMaintenanceSettled?.();
      }
    };

    // ISS-6337 — disk-full tally for this client lifetime, kept next to the
    // write boundary that produces the failures (the layer with the actionable
    // detail). Bounded by construction: two scalars, never a per-error map.
    const storageExhaustion = createStorageExhaustionTally();

    // ISS-12023 (PRD-785) — page-cache reclaim. `cache_size=-16384` gives every
    // connection a 16 MiB page cache, and nothing ever gave it back: an idle
    // reader loses its cache only as a side effect of the FEA-3132 recycle
    // (reopening the connection drops it), and the WRITER is never recycled, so
    // it held whatever the last backfill or aggregation touched for the life of
    // the db-host. `PRAGMA shrink_memory` releases it on all of them without
    // closing anything.
    //
    // Two triggers, both from the ticket: a quiet-store timer here, and the
    // dispatcher's post-heavy-gate call into `shrinkMemory` (the dotted
    // `prisma.shrinkMemory` op). The timer is what PRD-785's "minimal in the
    // background" asks for; the heavy-gate call is what stops a whole-corpus scan
    // from leaving its cache resident until the app happens to go idle.
    //
    // `writerInFlight` counts work the writer connection has accepted but not
    // settled: writes the queue holds (queued ones included) AND reads issued
    // through the exposed `client`, which is bound to this same connection and is
    // the store's dominant read path. Shrinking under either frees almost nothing
    // (the pages it holds are pinned or about to be re-read) while taking the
    // writer's per-connection mutex, so a busy writer is simply skipped and the
    // next pass takes it.
    let writerInFlight = 0;
    let lastStoreActivityAt = now();
    // Fires at most once per idle stretch: the timer sets it, the next read or
    // write clears it. Without it a store nobody touches pays a pragma per
    // connection every interval forever, for nothing left to release.
    let shrunkSinceActivity = false;
    let shrinkTail: Promise<unknown> = Promise.resolve();
    const markStoreActivity = (): void => {
      lastStoreActivityAt = now();
      shrunkSinceActivity = false;
    };
    // 1 when the pragma ran, 0 when the engine refused it. Swallowed for the same
    // reason `fireWalTruncate` swallows a BUSY TRUNCATE: this is reclaim, never
    // correctness, and the next pass retries. The count is what makes a chronic
    // refusal visible to a test instead of silent (see `onShrinkMemory`).
    const shrinkConnection = async (client: PrismaClient): Promise<number> => {
      try {
        await client.$executeRawUnsafe(SQLITE_SHRINK_MEMORY_SQL);
        return 1;
      } catch {
        return 0;
      }
    };
    const runOneShrinkPass = async (): Promise<void> => {
      let shrunk = 0;
      if (!closed && writerInFlight === 0) {
        shrunk += await shrinkConnection(writerRaw);
      }
      for (let slot = 0; slot < readerRaws.length; slot++) {
        if (closed || inFlight[slot] !== 0) {
          continue;
        }
        // Claim the slot the same way `read` does, BEFORE the await: an idle slot
        // is exactly what the recycler disconnects, and a recycle landing inside
        // this pragma would reject it against a closed handle. Marking it
        // in-flight makes the recycler skip the slot instead.
        const reader = readerRaws[slot];
        inFlight[slot] += 1;
        try {
          shrunk += await shrinkConnection(reader);
        } finally {
          inFlight[slot] -= 1;
        }
      }
      options?.onShrinkMemory?.(shrunk);
    };
    // One pass at a time. Two exclusive ops back to back, or a heavy-gate op
    // settling while an idle pass is suspended, would otherwise start a second
    // pass and leave `shrinkTail` tracking only that one — `disconnect()` would
    // then drain the second while `$disconnect`ing a reader the first is still
    // inside, which is exactly the case the drain comment claims cannot happen.
    // A second caller joins the running pass instead.
    let activeShrinkPass: Promise<void> | null = null;
    const runShrinkPass = (): Promise<void> => {
      activeShrinkPass ??= runOneShrinkPass().finally(() => {
        activeShrinkPass = null;
      });
      return activeShrinkPass;
    };
    // Every call the exposed `client` issues runs on the writer connection, so it
    // is both store activity and writer work in flight. `write` keeps its own
    // increment: a QUEUED write holds the writer before any statement exists.
    const trackWriterActivity = <T>(run: () => T): T => {
      writerInFlight += 1;
      markStoreActivity();
      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        writerInFlight -= 1;
        markStoreActivity();
      };
      try {
        const result = run();
        if (isThenable(result)) {
          // The caller's own promise is returned unchanged, so its rejection and
          // its error ownership are untouched; `release` cannot throw, so this
          // observer promise cannot become an unhandled rejection.
          result.then(release, release);
          return result;
        }
        release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    };
    const idleShrinkIntervalMs =
      options?.idleShrinkIntervalMs ?? IDLE_SHRINK_MEMORY_INTERVAL_MS;
    const shrinkTimer = setInterval(() => {
      if (closed || shrunkSinceActivity) {
        return;
      }
      const at = now();
      // Re-anchor a clock that moved backward, for the reason `runWalMaintenance`
      // does: the production clock is monotonic, but a regression would make
      // every elapsed span negative and the gate below would never open again.
      if (at < lastStoreActivityAt) {
        lastStoreActivityAt = at;
        return;
      }
      if (at - lastStoreActivityAt < idleShrinkIntervalMs) {
        return;
      }
      shrunkSinceActivity = true;
      shrinkTail = runShrinkPass().catch(() => undefined);
    }, idleShrinkIntervalMs);
    // Don't keep the process alive solely to reclaim memory.
    shrinkTimer.unref?.();

    return {
      client: wrapWriterActivity(writer, trackWriterActivity),
      // CONSUMING read: returns the window SINCE THE PREVIOUS CALL, then marks
      // that window consumed. The store-integrity probe is the single consumer
      // and calls this once per run, so each run sees "what happened since the
      // last run" — a point-in-time verdict, which is what its caller needs.
      //
      // A lifetime tally cannot serve that role: `anomalies > 0` would latch on
      // the first transient stat EBUSY or probe throw and hold the whole probe in
      // `failing` for the rest of the client's life. That would fire
      // `store.integrity.failure_persistent` on every heartbeat for a probe that
      // recovered, and — worse — suppress `store.integrity.recovered` for a REAL
      // quick_check or index failure that actually was fixed, because the sticky
      // WAL issue keeps `healthy` false. The sibling classifiers here
      // (quick_check, index presence, token parity) are all point-in-time; this
      // one now matches them.
      //
      // `lastAnomalyReason` is reported only when the window itself carried an
      // anomaly, so a recovered probe cannot ship a stale reason to telemetry.
      readWalProbeHealth: () => {
        const probes = walProbeAttempts - walProbeAttemptsReported;
        const anomalies = walProbeAnomalies - walProbeAnomaliesReported;
        walProbeAttemptsReported = walProbeAttempts;
        walProbeAnomaliesReported = walProbeAnomalies;
        return {
          measurable: walDepthMeasurable,
          probes,
          anomalies,
          lastAnomalyReason: anomalies > 0 ? lastWalProbeAnomalyReason : null,
        };
      },
      // ISS-6337 — the same CONSUMING-read contract, for the same reason: a
      // cleared disk must be able to read healthy again.
      readStorageExhaustionHealth: () => storageExhaustion.read(),
      write: (fn, token, opts) => {
        // ISS-12023: a write in the queue is store activity, and it holds the
        // writer connection the shrink pass would otherwise take.
        writerInFlight += 1;
        markStoreActivity();
        const result = queue.run(() => fn(writer), token, opts);
        // Track the whole maintenance continuation (probe + any TRUNCATE) so
        // disconnect() can drain an in-flight PASSIVE probe, not just a fired
        // TRUNCATE. Swallow inside — maintenance failures never surface to the
        // write's own result.
        //
        // ISS-6337 — the disk-full tally rides THIS handler rather than a second
        // `result.catch(...)`. A separate handler's promise would be tracked by
        // nothing, so a throw while classifying would surface as an unhandled
        // rejection and take the app down: the exact crash this feature removes.
        // Here the failure is already delivered, `walMaintenanceTail` already
        // covers the continuation, and each write costs one fewer promise on the
        // backfill hot path. Observation only — `result` is returned unchanged,
        // so the caller's rejection and the engine's rollback are untouched.
        walMaintenanceTail = result.then(
          () => {
            // A write that SUCCEEDED is the only proof the store can accept one,
            // and so the only thing that clears the exhaustion latch — see
            // `createStorageExhaustionTally`. Without this arm a probe that read
            // one failure would report `recovered` off nothing but an idle
            // interval, on a disk that is still full.
            storageExhaustion.recordSuccess();
            writerInFlight -= 1;
            markStoreActivity();
            return maybeTruncateWal();
          },
          (error: unknown) => {
            storageExhaustion.record(error);
            writerInFlight -= 1;
            markStoreActivity();
            return maybeTruncateWal();
          }
        );
        return result;
      },
      read: (fn) => {
        // Bind the slot + mark it in-flight SYNCHRONOUSLY (before any await) so
        // the recycler never disconnects the connection this read is using, and
        // capture the client so a recycle of any OTHER slot can't affect it.
        const slot = readerCursor % readers.length;
        readerCursor += 1;
        inFlight[slot] += 1;
        const reader = readers[slot];
        // ISS-12023: a read is store activity, so it re-arms the idle gate.
        markStoreActivity();
        return Promise.resolve()
          .then(() => fn(reader))
          .finally(() => {
            inFlight[slot] -= 1;
            markStoreActivity();
          });
      },
      // ISS-12023: the dispatcher's post-heavy-gate reclaim. Tracked in
      // `shrinkTail` on the same grounds as `walTruncateTail` — the caller
      // fire-and-forgets it, so `disconnect()` is the only thing that can
      // guarantee the pragma is not still in flight against a closing handle.
      shrinkMemory: () => {
        const pass = runShrinkPass();
        shrinkTail = pass.catch(() => undefined);
        return pass;
      },
      disconnect: async () => {
        closed = true;
        clearInterval(recycleTimer);
        clearInterval(shrinkTimer);
        // ISS-12023: a shrink pass suspended inside a connection's pragma must
        // finish before that connection is disconnected under it. `closed` stops
        // the pass from taking any FURTHER connection; this drains the one it is
        // already on.
        await shrinkTail;
        // Drain a recycle tick that may be paused mid-open: with `closed` set it
        // now closes its spare instead of swapping it into the pool, so no fresh
        // reader handle survives this teardown.
        await activeRecycle;
        // Drain any in-flight maintenance run before tearing down the writer
        // connection (disconnect runs after the write queue drains, so no write
        // is in flight; the maintenance continuation resolves promptly). Await
        // the maintenance tail FIRST so an in-flight PASSIVE probe finishes
        // against a still-open `writerRaw` — with `closed` now set, its post-probe
        // TRUNCATE is skipped — then drain `walTruncateTail` for a TRUNCATE that
        // fired before `closed`.
        await walMaintenanceTail;
        await walTruncateTail;
        await writerRaw.$disconnect();
        // readerRaws slots may have been swapped by the recycler — disconnect
        // whatever connections the pool currently holds.
        for (const reader of readerRaws) {
          await reader.$disconnect();
        }
      },
    };
  } catch (error) {
    await Promise.all(
      opened.map((client) => client.$disconnect().catch(() => undefined))
    );
    throw error;
  }
}

/** The libSQL URL scheme that denotes a local file-backed store. */
const LIBSQL_FILE_URL_PREFIX = "file:";
/** libSQL's in-memory URL, which has no `-wal` sidecar to measure. */
const LIBSQL_MEMORY_URL_PATH = ":memory:";
/** SQLite's write-ahead-log sidecar suffix, appended to the database path. */
export const WAL_SIDECAR_SUFFIX = "-wal";
/** Node's error code for "no such file or directory". */
const MISSING_FILE_ERROR_CODE = "ENOENT";

/**
 * ISS-4819: how the WAL-size read resolved. Deliberately three-valued — an
 * UNKNOWN depth must not be collapsed into `Under`, because a failed read is not
 * evidence that the WAL is small and treating it as such would silently drop the
 * reclaim (and, for a final transaction, never retry it).
 */
export const WalSizeVerdict = {
  Over: "over",
  Under: "under",
  Unknown: "unknown",
} as const;
export type WalSizeVerdict =
  (typeof WalSizeVerdict)[keyof typeof WalSizeVerdict];

/**
 * ISS-4819: resolve the on-disk `-wal` sidecar path for a libSQL `file:` config.
 * Returns `null` for a config with no local file to measure (in-memory, remote),
 * where the WAL depth is unknowable from the filesystem.
 */
export function walSidecarPath(url: string): string | null {
  if (!url.startsWith(LIBSQL_FILE_URL_PREFIX)) {
    return null;
  }
  const withoutQuery = url.split("?")[0];
  const filePath = withoutQuery.slice(LIBSQL_FILE_URL_PREFIX.length);
  if (filePath.length > 0 && filePath !== LIBSQL_MEMORY_URL_PATH) {
    return `${filePath}${WAL_SIDECAR_SUFFIX}`;
  }
  return null;
}

/**
 * ISS-4819: convert a `-wal` sidecar's byte size to a WAL frame count. The WAL
 * file is a 32-byte header followed by N frames of (24-byte frame header + one
 * database page), so the frame count is `(size - 32) / (24 + pageSize)`. A size
 * at or below the bare header is a genuinely empty WAL (0 frames), NOT unknown.
 * Returns `null` for a nonsensical size or page size so the caller takes the
 * explicit unknown fallback instead of reading garbage as an empty WAL.
 */
export function walFramesFromFileBytes(
  sizeBytes: number,
  pageSizeBytes: number
): number | null {
  if (!(Number.isFinite(sizeBytes) && Number.isFinite(pageSizeBytes))) {
    return null;
  }
  if (sizeBytes < 0 || pageSizeBytes <= 0) {
    return null;
  }
  if (sizeBytes <= WAL_FILE_HEADER_BYTES) {
    return 0;
  }
  const frameBytes = WAL_FRAME_HEADER_BYTES + pageSizeBytes;
  return Math.floor((sizeBytes - WAL_FILE_HEADER_BYTES) / frameBytes);
}

/**
 * ISS-4819: pull a numeric column out of a single-row PRAGMA result. The raw
 * adapter surfaces the row either positionally (an array) or keyed by column
 * name (an object), so read both shapes. Returns `null` — NOT 0 — for a
 * missing/renamed/non-numeric value so the caller takes its explicit fallback
 * rather than reading a bad row as a legitimate zero.
 */
export function readPragmaNumber(rows: unknown[], key: string): number | null {
  const row = rows[0];
  if (Array.isArray(row)) {
    return toWalFrameCount(row[0]);
  }
  if (row !== null && typeof row === "object") {
    return toWalFrameCount((row as Record<string, unknown>)[key]);
  }
  return null;
}

/**
 * Whether a caught filesystem error means the file simply does not exist. For
 * the `-wal` sidecar that is a MEANINGFUL answer (the WAL has been fully
 * reclaimed → depth 0), not a failure, so it must be distinguished from every
 * other stat error, which leaves the depth genuinely unknown.
 */
export function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === MISSING_FILE_ERROR_CODE
  );
}

/**
 * Coerce a read WAL-frame/page value to a non-negative finite number. Returns
 * `null` — NOT 0 — for a missing/negative/non-numeric value so the caller can
 * take the unknown fallback instead of silently reading it as an empty WAL and
 * disabling the ceiling backstop. `0` is reserved for a genuinely-empty WAL.
 */
function toWalFrameCount(value: unknown): number | null {
  const frames = Number(value);
  if (!Number.isFinite(frames) || frames < 0) {
    return null;
  }
  return frames;
}

/**
 * ISS-4818 — WAL-depth-probe health for one client lifetime. Clone-safe (plain
 * scalars) so it can cross the db-host method proxy to the main-process
 * store-integrity probe.
 *
 * `measurable` distinguishes "this store has no `-wal` sidecar to measure"
 * (in-memory/remote — an unknown depth is CORRECT there, and no attempt is
 * counted) from a store whose depth genuinely can be read. `anomalies` counts
 * only reads that were attempted against a measurable store and failed, so
 * `anomalies > 0` always means a real boundary anomaly and `anomalies / probes`
 * is a meaningful rate.
 */
export type WalProbeHealth = {
  measurable: boolean;
  /** Probe attempts in the window since the previous read (never negative). */
  probes: number;
  /** Failed probes in that same window — a point-in-time verdict, not a tally. */
  anomalies: number;
  /** The window's most recent failure mode, or null when the window was clean. */
  lastAnomalyReason: WalProbeAnomalyReason | null;
};
