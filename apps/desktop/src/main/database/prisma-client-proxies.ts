/**
 * @file prisma-client-proxies.ts
 * @description The desktop store's client-facade Proxies, split out of
 * `prisma-client.ts` (ISS-12023) so that file stays the connection topology and
 * this one is the facade layer over it: raw-bind-arg coercion on the way down to
 * libSQL, and writer-activity accounting on the way back up to the idle
 * page-cache reclaim.
 *
 * Nothing here knows about the pool, the roles, or the cadences. Both wrappers
 * are Proxies rather than subclasses or spread copies because a PrismaClient
 * carries private fields, so every forwarded member has to keep the original as
 * its `this`.
 */

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
export function wrapRawCoercion<T extends object>(target: T): T {
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
 * ISS-12023 (PRD-785): wrap the exposed writer-bound `client` so every call it
 * serves is counted as writer work in flight for the duration of that call.
 * Without it `writerInFlight` saw only `write`, and the idle pass could judge a
 * store busy with `prisma.client` reads — the dominant read path on this
 * connection — quiet, then shrink the writer under one of them.
 *
 * A Proxy for the same reason {@link wrapRawCoercion} is one: the client carries
 * private fields, so a forwarded member has to keep the original as its `this`.
 * It composes over that proxy rather than replacing it, so the coercion contract
 * still applies to the raw escape hatches.
 *
 * Recurses one level into model delegates, because `client.session.findMany()`
 * issues its statement from the delegate, not from the client — a shallow wrap
 * would count `$queryRawUnsafe` and miss every typed read.
 */
export function wrapWriterActivity<T extends object>(
  target: T,
  track: <R>(run: () => R) => R
): T {
  return new Proxy(target, {
    get(obj, prop) {
      const original = Reflect.get(obj, prop);
      if (typeof original === "function") {
        return (...args: unknown[]) =>
          track(() =>
            (original as (...a: unknown[]) => unknown).apply(obj, args)
          );
      }
      if (isPrismaModelDelegate(original)) {
        return wrapWriterActivity(original, track);
      }
      return original;
    },
  });
}

/**
 * Whether a client member is a Prisma model delegate — the objects whose methods
 * issue statements. Tested by `findMany` rather than by property name so a new
 * model needs no list here, and so the non-delegate members Prisma exposes
 * (`$extends` internals, symbols, plain config) are left untouched.
 */
function isPrismaModelDelegate(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { findMany?: unknown }).findMany === "function"
  );
}
