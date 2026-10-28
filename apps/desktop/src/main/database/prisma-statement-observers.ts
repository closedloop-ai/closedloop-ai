/**
 * @file prisma-statement-observers.ts
 * @description ISS-5336 / ISS-6339 — the driver-adapter statement SPY, split out
 * of `prisma-client.ts` (ISS-12023) so that file is the connection topology and
 * this one is the observability plumbing over it.
 *
 * Nothing here knows about the desktop store's connection roles, pool, or
 * cadences: it wraps whatever adapter factory it is handed in two Proxies so each
 * statement is reported before it runs and again when it settles.
 *
 * It does not import `@prisma/adapter-libsql`, and that is deliberate rather than
 * incidental — the community adapter stays confined to `prisma-client.ts` so a
 * swap to the FEA-1736 in-house fallback touches one file. `withStatementSpy` is
 * generic over the factory object for exactly the reason
 * {@link spyOnAdapterQueries} is structurally typed: the Proxies forward by
 * member name, so neither needs the concrete type.
 */

import { performance } from "node:perf_hooks";

/**
 * ISS-5336: one statement exactly as a connection handed it to the driver
 * adapter — the SQL string Prisma emitted plus a copy of the bindings that go
 * with it. See `CreateDesktopPrismaOptions.onStatement` in `prisma-client.ts`.
 */
export type CapturedStatement = {
  sql: string;
  args: readonly unknown[];
};

/**
 * ISS-5336: wrap the libSQL adapter factory so every read statement a
 * connection issues is reported to `onStatement` before it runs. The adapter
 * boundary is the LAST place the statement is still the one Prisma built — a
 * capture here is the real SQL and the real bindings, whatever version of the
 * query engine produced them.
 *
 * A Proxy, not a subclass or a spread copy: the factory carries private fields,
 * so every forwarded member has to keep the original as its `this` (same reason
 * `wrapRawCoercion` in `prisma-client.ts` is a Proxy). Only `connect` is intercepted; the
 * migration/shadow-db entry points pass straight through.
 */
export function withStatementSpy<TFactory extends object>(
  factory: TFactory,
  observers: StatementObservers
): TFactory {
  return new Proxy(factory, {
    get(target, prop) {
      const original = Reflect.get(target, prop);
      if (prop === "connect") {
        const connect = original as (...args: unknown[]) => Promise<object>;
        return async (...args: unknown[]) =>
          spyOnAdapterQueries(await connect.call(target, ...args), observers);
      }
      if (typeof original === "function") {
        return original.bind(target);
      }
      return original;
    },
  });
}

/**
 * Wrap one connected adapter so `queryRaw` reports its statement. Structurally
 * typed against the driver-adapter contract (`{ sql, args }`) rather than
 * importing `@prisma/driver-adapter-utils`, which this module does not depend
 * on directly. See {@link withStatementSpy}.
 */
function spyOnAdapterQueries<T extends object>(
  adapter: T,
  observers: StatementObservers
): T {
  return new Proxy(adapter, {
    get(target, prop) {
      const original = Reflect.get(target, prop);
      if (typeof original !== "function") {
        return original;
      }
      if (prop === "queryRaw") {
        const queryRaw = original as (query: CapturedStatement) => unknown;
        return (query: CapturedStatement) =>
          runObservedQuery(queryRaw, target, query, observers);
      }
      // ISS-6339: `executeRaw` carries the PRAGMAs and the row-count-only
      // statements — a whole population the ISS-5336 before-hook deliberately
      // does not want but the duration signal cannot omit, because a report
      // that silently covers only reads makes an unmeasured write path look
      // like a quiet one. The before-hook's documented `queryRaw`-only scope is
      // preserved by passing only the settle-hook here.
      if (prop === "executeRaw") {
        const executeRaw = original as (query: CapturedStatement) => unknown;
        return (query: CapturedStatement) =>
          runObservedQuery(executeRaw, target, query, {
            onStatementSettled: observers.onStatementSettled,
          });
      }
      // ISS-6339: statements issued INSIDE a transaction are served by the
      // `Transaction` object the adapter hands back here, not by the adapter
      // itself — so without this they were invisible, and the store's heaviest
      // work (the analytics fan-out, the importer, the backfill) is exactly the
      // transactional work.
      //
      // ISS-9117: BOTH observers are forwarded. The `Transaction` object is
      // recursed through this same wrapper, so its `queryRaw` reaches the
      // before-hook by the identical path the connection's does — a read that
      // opens a snapshot to bound its materialization stays countable instead of
      // reporting zero statements.
      if (prop === "startTransaction" && hasStatementObserver(observers)) {
        const startTransaction = original as (
          ...args: unknown[]
        ) => Promise<object>;
        return async (...args: unknown[]) =>
          spyOnAdapterQueries(
            await startTransaction.call(target, ...args),
            observers
          );
      }
      return original.bind(target);
    },
  });
}

/**
 * ISS-5336 + ISS-6339: one observed statement call — `queryRaw`, `executeRaw`,
 * or either of those on a transaction. The before-hook sees the statement and a
 * COPY of its bindings (an observer must not be able to reach into the live
 * array the driver is about to bind); the settle-hook sees only the SQL text and
 * the elapsed time.
 *
 * The `.then(settled, settled)` branch handles rejection, so observing a failing
 * statement can never turn it into an unhandled rejection — the original promise
 * is what is returned, and its real caller still owns the error. Timing uses
 * `performance.now()` because it is monotonic: a wall clock stepping backward
 * mid-statement would otherwise produce a negative duration, which the recorder
 * would have to discard.
 */
function runObservedQuery<T extends object>(
  queryRaw: (query: CapturedStatement) => unknown,
  target: T,
  query: CapturedStatement,
  observers: StatementObservers
): unknown {
  observers.onStatement?.({ sql: query.sql, args: [...query.args] });
  const { onStatementSettled } = observers;
  if (!onStatementSettled) {
    return queryRaw.call(target, query);
  }
  const startedAt = performance.now();
  const result = queryRaw.call(target, query);
  const settled = (): void => {
    // The observer's contract is to be non-throwing, but this call site is
    // inside a `.then` handler whose promise nobody holds: an escaping throw
    // becomes an UNHANDLED REJECTION in the db-host utilityProcess, which is how
    // that process has died before. On the synchronous branch an escaping throw
    // would replace the caller's result outright. Neither is an acceptable
    // price for a measurement, and there is nowhere to report to from here that
    // is not the statement path itself — losing the sample is the right
    // remaining outcome. Same posture as `reportStep` in the migration runner.
    try {
      onStatementSettled(query.sql, performance.now() - startedAt);
    } catch {
      // Deliberately swallowed; see above.
    }
  };
  if (!isThenable(result)) {
    settled();
    return result;
  }
  result.then(settled, settled);
  return result;
}

/**
 * Whether a value is a promise-like the caller can observe. Exported because the
 * ISS-12023 writer-activity tracker in `prisma-client.ts` needs the same test —
 * it releases its in-flight count when the tracked call settles, and a Prisma
 * delegate that returns synchronously must release immediately.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * ISS-6339: the statement observers one connection's adapter spy carries — the
 * ISS-5336 before-hook and the settle-hook that times the statement. A bag
 * rather than two positional parameters because the spy threads them through
 * two Proxies, and a second bare callback there is the shape that gets wired to
 * the wrong argument.
 */
export type StatementObservers = {
  onStatement?: (statement: CapturedStatement) => void;
  onStatementSettled?: (sql: string, durationMs: number) => void;
};

/**
 * Whether any observer is installed. When none is, the adapter is used bare and
 * a connection's statement path is byte-for-byte what it was before ISS-5336 —
 * no Proxy, no closure, no timing.
 */
export function hasStatementObserver(observers: StatementObservers): boolean {
  return Boolean(observers.onStatement || observers.onStatementSettled);
}
