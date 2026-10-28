import type * as DatabaseModule from "@repo/database";

/**
 * Counts the Prisma model-delegate calls a production path issues, for suites
 * whose contract is a STATEMENT COUNT rather than a value (ISS-9116).
 *
 * The seam is `withDb`, so a suite wraps it in its own `vi.mock` factory —
 * `vi.mock` is hoisted per file and cannot be shared — and passes the real
 * module in. Everything else lives here so two suites cannot drift into
 * counting differently.
 */

const statements: string[] = [];

/** How many of the recorded calls were exactly `<model>.<operation>`. */
export function occurrences(
  entries: readonly string[],
  statement: string
): number {
  return entries.filter((entry) => entry === statement).length;
}

/**
 * Reset the recorder and return a reader for everything issued from here on.
 * The reader snapshots, so it can be called repeatedly within one measurement.
 */
export function startCounting(): () => string[] {
  statements.length = 0;
  return () => [...statements];
}

/**
 * `withDb` and `withDb.tx` that hand every caller a client recording each
 * delegate call before forwarding it. Nested calls each wrap the same
 * underlying client once, so a statement is recorded exactly once.
 */
export function countingWithDb(
  actual: typeof DatabaseModule
): typeof DatabaseModule.withDb {
  const counted = ((fn: (db: unknown) => unknown) =>
    actual.withDb((db) =>
      fn(countingClient(db) as never)
    )) as unknown as typeof DatabaseModule.withDb;
  counted.tx = ((fn: (tx: unknown) => unknown, options?: unknown) =>
    actual.withDb.tx(
      (tx) => fn(countingClient(tx) as never) as never,
      options as never
    )) as unknown as typeof DatabaseModule.withDb.tx;
  return counted;
}

function countingClient(db: object): object {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (
        typeof property !== "string" ||
        property.startsWith("$") ||
        property.startsWith("_") ||
        typeof value !== "object" ||
        value === null
      ) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return new Proxy(value, {
        get(model, operation) {
          const method = Reflect.get(model, operation);
          if (typeof method !== "function" || typeof operation !== "string") {
            return method;
          }
          return (...args: unknown[]) => {
            statements.push(`${property}.${operation}`);
            return Reflect.apply(method, model, args);
          };
        },
      });
    },
  });
}
