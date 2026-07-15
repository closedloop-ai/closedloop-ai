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

import type { Config } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import {
  connectionPragmaStatements,
  DEFAULT_READER_POOL_SIZE,
  WAL_TRUNCATE_CHECKPOINT_SQL,
  WAL_TRUNCATE_INTERVAL_MS,
} from "./connection-pragmas.js";
import { PrismaClient } from "./generated/client.js";

/**
 * The subset of the sqlite.ts write queue the factory needs. Kept structural so
 * the factory does not depend on the queue's concrete module.
 */
export type WriteSerializer = {
  run<T>(fn: () => Promise<T>): Promise<T>;
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
   * through {@link DesktopPrisma.write}. For heavy or independent reads that
   * must run CONCURRENTLY with the first-launch backfill writer, use
   * {@link DesktopPrisma.read}, which dispatches to the reader pool.
   */
  readonly client: DesktopPrismaReader;
  /**
   * Run a unit of Prisma work — a write or `$transaction` — serialized through
   * the shared write queue. This is the structural enforcement point for the
   * "all Prisma writes go through the queue" rule; the callback receives the
   * full, mutation-capable client.
   */
  write<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T>;
  /**
   * Run a READ against the reader pool: the call is dispatched round-robin to
   * one of the dedicated `query_only` reader connections, which read a committed
   * WAL snapshot CONCURRENTLY with the writer (no serialization behind the
   * backfill). Each reader connection self-serializes its own statements via the
   * adapter's per-connection mutex, so concurrent `read()` calls fan out across
   * the pool without ever running two statements on one connection. The callback
   * receives a read-only client (see {@link DesktopPrismaReadClient}).
   */
  read<T>(fn: (client: DesktopPrismaReadClient) => Promise<T>): Promise<T>;
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

/**
 * Coerce a single raw-SQL bind argument to a libSQL-bindable value (mirrors the
 * boot connection's `coerceArg` in `migration-executor.ts`). The Prisma libSQL
 * adapter binds args straight through to the driver, which only accepts numbers,
 * strings, bigints, buffers, and null — so without this, a `boolean`/`Date`/plain
 * object/`undefined` bound by a `$executeRawUnsafe`/`$queryRawUnsafe` call throws
 * "SQLite3 can only bind numbers, strings, bigints, buffers, and null" and rolls
 * back the whole transaction. Booleans become 0/1 (the adapter doesn't accept
 * booleans directly), Dates become ISO strings, plain objects become their JSON
 * form (json/jsonb columns are TEXT in SQLite), and `undefined` becomes null.
 */
function coerceRawArg(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "object") {
    // json/jsonb columns are TEXT in SQLite. A value read back through the
    // Prisma raw path surfaces `BIGINT`-declared columns (e.g. the token-count
    // columns) as `bigint`, so an object built from such a read can carry
    // bigints that plain JSON.stringify rejects
    // ("Do not know how to serialize a BigInt"). Token-count-scale bigints fit
    // in a JS number, so coerce them.
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? Number(nested) : nested
    );
  }
  return value;
}

const RAW_UNSAFE_METHODS = new Set(["$executeRawUnsafe", "$queryRawUnsafe"]);

/**
 * Translate Postgres-style `$1` placeholders to SQLite numbered `?1` ones,
 * mirroring `migration-executor.ts`'s `translateParams`. This is NOT
 * cosmetic: SQLite treats `$1` as a *named* parameter bound by order of first
 * appearance, so a query whose params appear out of numeric order (e.g.
 * `updateSessionCostRollup`, where `$2`/`$3` appear in the SELECT before `$1`
 * in the WHERE) binds the positional args to the wrong placeholders and
 * silently returns wrong results. `?1`/`?2` are numbered and bound by the
 * explicit index regardless of textual order, which is what the converted
 * `$N`-style SQL assumes.
 */
function translateNumberedParams(sql: string): string {
  return sql.replace(/\$(\d+)/g, "?$1");
}

/**
 * Wrap a Prisma client (or interactive-transaction client) so the positional
 * raw escape hatches coerce their bind args via {@link coerceRawArg}, applying
 * the coercion contract at the single point the stores reach raw SQL.
 * `$transaction(callback)` is re-wrapped so the `tx` the callback receives
 * carries the same coercion; the array form and every typed delegate pass
 * straight through (Prisma binds those itself).
 */
function wrapRawCoercion<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop) {
      const original = Reflect.get(obj, prop);
      if (typeof prop === "string" && RAW_UNSAFE_METHODS.has(prop)) {
        return (sql: string, ...args: unknown[]) =>
          (original as (sql: string, ...a: unknown[]) => unknown).call(
            obj,
            translateNumberedParams(sql),
            ...args.map(coerceRawArg)
          );
      }
      if (prop === "$transaction") {
        return (arg: unknown, ...rest: unknown[]) => {
          const run = original as (...a: unknown[]) => unknown;
          if (typeof arg === "function") {
            const callback = arg as (tx: object) => unknown;
            return run.call(
              obj,
              (tx: object) => callback(wrapRawCoercion(tx)),
              ...rest
            );
          }
          return run.call(obj, arg, ...rest);
        };
      }
      if (typeof original === "function") {
        return original.bind(obj);
      }
      return original;
    },
  });
}

/** Open one PrismaClient over its OWN libSQL connection and apply the role's
 * PRAGMAs. Each PrismaClient = one adapter = one libSQL connection = one
 * per-connection mutex, so a writer and N readers are genuinely independent
 * connections over the same WAL file (verified: a reader reads a committed
 * snapshot while the writer holds an open write transaction). */
// Prisma's interactive `$transaction` defaults (maxWait 2s, timeout 5s) would
// kill exactly the backfill-concurrent analytics GROUP BY scans this pool exists
// to serve (and the importer's write transactions), so we use a generous ceiling
// that still bounds a genuinely hung transaction (LOCK waits are separately
// bounded by the 15s busy_timeout). Applies to every `$transaction` on the
// client — the reader snapshot aggregations and the writer import txs.
const TRANSACTION_MAX_WAIT_MS = 30_000;
const TRANSACTION_TIMEOUT_MS = 120_000;

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
  role: "writer" | "reader"
): Promise<PrismaClient> {
  // The adapter's `@libsql/client` is PATCHED (patches/@libsql__client@0.17.3.patch):
  // stock `transaction()` detaches the native connection and never closes it, so
  // every Prisma `$transaction` leaked a connection (~2 fds + native buffers)
  // until fd/memory exhaustion killed the db-host (the exit-code-5 crash storm)
  // AND silently shed this module's per-connection PRAGMAs — `query_only`,
  // `busy_timeout`, the WAL checkpoint bounds — on the lazily recreated
  // replacement. The patch keeps ONE native connection per client for its whole
  // lifetime, which the per-connection mutex already serializes.
  const client = new PrismaClient({
    adapter: new PrismaLibSql(config),
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
 * through `queue`; a throttled TRUNCATE checkpoint runs after writes to bound
 * WAL/RSS during the backfill.
 *
 * Async because each connection applies its PRAGMAs before serving work.
 */
export type CreateDesktopPrismaOptions = {
  readerPoolSize?: number;
  readerRecycleIntervalMs?: number;
  /**
   * Test/observability hook fired AFTER a reader slot has been successfully
   * recycled (idle reader swapped for a fresh `query_only` connection). Lets a
   * test wait on an OBSERVED recycle rather than a fixed sleep, so a regression
   * that stops recycling fails the test instead of silently passing. Not used in
   * production wiring.
   */
  onReaderRecycle?: (slot: number) => void;
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
  const open = async (role: "writer" | "reader"): Promise<PrismaClient> => {
    const client = await openPrismaConnection(config, role);
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
            fresh = await openPrismaConnection(config, "reader");
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
    let lastWalTruncateAt = 0;
    let walTruncateTail: Promise<unknown> = Promise.resolve();
    const maybeTruncateWal = (): void => {
      const now = Date.now();
      if (now - lastWalTruncateAt < WAL_TRUNCATE_INTERVAL_MS) {
        return;
      }
      lastWalTruncateAt = now;
      walTruncateTail = writerRaw
        .$executeRawUnsafe(WAL_TRUNCATE_CHECKPOINT_SQL)
        .then(
          () => undefined,
          () => undefined
        );
    };

    return {
      client: writer,
      write: (fn) => {
        const result = queue.run(() => fn(writer));
        result.then(maybeTruncateWal, maybeTruncateWal);
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
        return Promise.resolve()
          .then(() => fn(reader))
          .finally(() => {
            inFlight[slot] -= 1;
          });
      },
      disconnect: async () => {
        closed = true;
        clearInterval(recycleTimer);
        // Drain a recycle tick that may be paused mid-open: with `closed` set it
        // now closes its spare instead of swapping it into the pool, so no fresh
        // reader handle survives this teardown.
        await activeRecycle;
        // Drain any in-flight maintenance checkpoint before tearing down the
        // writer connection (disconnect runs after the write queue drains, so no
        // write is in flight; the checkpoint resolves promptly).
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
