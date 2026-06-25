/**
 * @file prisma-client.ts
 * @description FEA-1791 / PLN-886 Phase 3 — the single Prisma client for the
 * desktop SQLite store.
 *
 * Wires `@prisma/adapter-libsql` onto the ALREADY-OPEN SQLite handle: one SQLite
 * instance, one Prisma client. The client shares the same physical connection
 * as the raw store path (SQLite is single-connection), so every Prisma write
 * and `$transaction` MUST serialize through the same write queue the raw path
 * uses. That rule is TYPE-enforced: the public `client` is a read-only facade
 * ({@link DesktopPrismaReader}) on which mutation methods don't exist, so the
 * mutation-capable client is reachable only inside `write(fn)`.
 *
 * The adapter is a single-maintainer community package: it is pinned to an
 * exact version (see apps/desktop/package.json) and confined to THIS module so
 * a swap to the FEA-1736 pre-approved in-house `SqlDriverAdapter` fallback
 * touches one file. Nothing outside this module imports the adapter.
 */

import type { Config } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
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
 * reads run on this one client instead of a separate raw handle. Like the prior
 * raw `storeDb` path, the read-vs-write split here is by convention — SQL can't
 * be statically classified — so raw **writes** must still go through
 * {@link DesktopPrisma.write}; do not smuggle a mutation through `$queryRaw*`.
 */
export type DesktopPrismaReader = {
  [K in keyof PrismaClient as K extends string
    ? K extends `$${string}`
      ? never
      : K
    : never]: ReadDelegate<PrismaClient[K]>;
} & Pick<PrismaClient, "$queryRaw" | "$queryRawUnsafe">;

export type DesktopPrisma = {
  /**
   * The typed client narrowed to reads (see {@link DesktopPrismaReader}).
   * Mutations are a compile error here — route them through
   * {@link DesktopPrisma.write}.
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
   * Release the Prisma client's pooled state. The underlying SQLite handle is
   * owned by the caller (openSqliteAgentDatabase) and closed separately — call
   * this BEFORE closing the handle, mirroring the Phase 0 adapter test.
   */
  disconnect(): Promise<void>;
};

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
 * Coerce a single raw-SQL bind argument to a libSQL-bindable value, matching the
 * legacy `libsql-executor.ts` `coerceArg` contract that the raw `db.query`/
 * `db.transaction` path applied transparently. The Prisma libSQL adapter binds
 * args straight through to the driver, which only accepts numbers, strings,
 * bigints, buffers, and null — so without this, a `boolean`/`Date`/plain object/
 * `undefined` bound by a `$executeRawUnsafe`/`$queryRawUnsafe` call throws
 * "SQLite3 can only bind numbers, strings, bigints, buffers, and null" and rolls
 * back the whole transaction. Booleans become 0/1 (the legacy libSQL client
 * accepted booleans directly; the adapter path does not), Dates become ISO
 * strings, plain objects become their JSON form (json/jsonb columns are TEXT in
 * SQLite), and `undefined` becomes null.
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
    // in a JS number, so coerce them — matching the numeric JSON the legacy
    // `db.query` path stored.
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? Number(nested) : nested
    );
  }
  return value;
}

const RAW_UNSAFE_METHODS = new Set(["$executeRawUnsafe", "$queryRawUnsafe"]);

/**
 * Translate Postgres-style `$1` placeholders to SQLite numbered `?1` ones,
 * matching the legacy `libsql-executor.ts` `translateParams`. This is NOT
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
 * raw escape hatches coerce their bind args via {@link coerceRawArg}, restoring
 * the legacy `db.query` coercion contract at the single point the converted
 * stores reach raw SQL. `$transaction(callback)` is re-wrapped so the `tx` the
 * callback receives carries the same coercion; the array form and every typed
 * delegate pass straight through (Prisma binds those itself).
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

/**
 * Build the desktop Prisma client over an already-open SQLite instance,
 * serializing writes through the provided queue.
 */
export function createDesktopPrisma(
  config: Config,
  queue: WriteSerializer
): DesktopPrisma {
  const adapter = new PrismaLibSql(config);
  const client = wrapRawCoercion(new PrismaClient({ adapter }));
  return {
    client,
    write: (fn) => queue.run(() => fn(client)),
    disconnect: () => client.$disconnect(),
  };
}
