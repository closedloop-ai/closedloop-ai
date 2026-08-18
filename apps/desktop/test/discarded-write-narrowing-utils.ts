/**
 * @file discarded-write-narrowing-utils.ts
 * @description Shared fixture for the ISS-6321 (batch 5/6) discarded-write
 * suites. Wraps a real {@link DesktopPrisma} in a recording proxy so ONE call
 * through a production entry point yields BOTH contracts:
 *
 * PARITY — the write still reaches the real libSQL store and still throws
 * `P2025` when the targeted row is absent. Proven by reading the store back /
 * asserting the rejection, not by inspecting arguments.
 *
 * NARROWING — the discarded write carries an explicit `select`, so the store
 * RETURNINGs the row's primary key instead of every column.
 *
 * The proxy FORWARDS to the real client, so a narrowing assertion can never
 * pass against a write that did not actually execute. `$transaction` callbacks
 * are re-wrapped so writes issued inside an interactive transaction are
 * recorded too — several batch-5 sites (`activity-metrics`,
 * `opencode-withheld-store`, `repository-default-authority-store`) only ever
 * write from inside one.
 */
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

/** One recorded Prisma delegate write, with the exact args it was given. */
export type RecordedWrite = {
  model: string;
  method: string;
  args: Record<string, unknown>;
};

/**
 * The singular write verbs that RETURNING-narrow: each resolves to a full row
 * unless given a `select`. The `*Many` verbs resolve to a `{ count }` and are
 * already narrow, so they are deliberately absent.
 */
const WIDE_WRITE_METHODS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "upsert",
  "delete",
]);

/** Prisma's own surface (`$transaction`, `$queryRaw`, …) is never a delegate. */
function isDelegateName(prop: string | symbol): prop is string {
  return (
    typeof prop === "string" && !prop.startsWith("$") && !prop.startsWith("_")
  );
}

function proxyDelegate<T extends object>(
  model: string,
  delegate: T,
  calls: RecordedWrite[]
): T {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        WIDE_WRITE_METHODS.has(prop) &&
        typeof value === "function"
      ) {
        return (args: Record<string, unknown>) => {
          calls.push({ model, method: prop, args });
          return Reflect.apply(value, target, [args]);
        };
      }
      return value;
    },
  });
}

function proxyClient<T extends object>(
  client: T,
  calls: RecordedWrite[],
  rawQueries: string[]
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "$queryRawUnsafe" && typeof value === "function") {
        return (query: string, ...params: unknown[]) => {
          rawQueries.push(query);
          return Reflect.apply(value, target, [query, ...params]);
        };
      }
      if (prop === "$transaction" && typeof value === "function") {
        return (arg: unknown, ...rest: unknown[]) => {
          if (typeof arg === "function") {
            const inner = arg as (tx: object) => unknown;
            return Reflect.apply(value, target, [
              (tx: object) => inner(proxyClient(tx, calls, rawQueries)),
              ...rest,
            ]);
          }
          return Reflect.apply(value, target, [arg, ...rest]);
        };
      }
      if (
        !isDelegateName(prop) ||
        value === null ||
        typeof value !== "object"
      ) {
        return value;
      }
      return proxyDelegate(prop, value, calls);
    },
  });
}

/** A recording view over a real `DesktopPrisma`, plus the calls it captured. */
export type RecordedPrisma = {
  prisma: DesktopPrisma;
  calls: RecordedWrite[];
  /** Every `$queryRawUnsafe` SQL string issued through this client. */
  rawQueries: string[];
  /** Every recorded write against one model+method. */
  callsFor: (model: string, method: string) => RecordedWrite[];
  /** The single recorded write against one model+method; throws otherwise. */
  only: (model: string, method: string) => RecordedWrite;
  reset: () => void;
};

/**
 * Wrap `prisma` so every singular delegate write issued through `write`,
 * `read`, `client`, or an interactive `$transaction` is recorded AND executed.
 */
export function recordDesktopWrites(prisma: DesktopPrisma): RecordedPrisma {
  const calls: RecordedWrite[] = [];
  const rawQueries: string[] = [];
  const wrapped = new Proxy(prisma, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        (prop === "write" || prop === "read") &&
        typeof value === "function"
      ) {
        return (fn: (client: object) => unknown, ...rest: unknown[]) =>
          Reflect.apply(value, target, [
            (client: object) => fn(proxyClient(client, calls, rawQueries)),
            ...rest,
          ]);
      }
      if (prop === "client" && value !== null && typeof value === "object") {
        return proxyClient(value, calls, rawQueries);
      }
      return value;
    },
  });
  const callsFor = (model: string, method: string) =>
    calls.filter((c) => c.model === model && c.method === method);
  return {
    prisma: wrapped,
    calls,
    rawQueries,
    callsFor,
    only: (model, method) => {
      const found = callsFor(model, method);
      if (found.length !== 1) {
        throw new Error(
          `expected exactly one ${model}.${method} write, saw ${found.length}`
        );
      }
      return found[0];
    },
    reset: () => {
      calls.length = 0;
      rawQueries.length = 0;
    },
  };
}

/**
 * Assert a recorded write RETURNINGs exactly `expected` — the row's real
 * primary key in `apps/desktop/prisma/schema.prisma`.
 *
 * The desktop schema is COMPOUND-PK-heavy: only `SessionArtifactLink`,
 * `ScheduledTask`, and `ScheduledTaskRun` carry an `id` column at all, so the
 * cloud batches' `select: { id: true }` is a compile error on most tables here.
 * Passing the real key per model is what keeps this suite honest.
 */
export function assertNarrowedTo(
  write: RecordedWrite,
  expected: Record<string, true>,
  label: string
): void {
  const select = write.args.select;
  if (select === undefined) {
    throw new Error(
      `${label}: ${write.model}.${write.method} has no \`select\` — it RETURNINGs every column`
    );
  }
  // Compare as SORTED key sets, not raw JSON: a `select` literal's key order is
  // incidental (a formatter or a refactor can reorder it), so an order-sensitive
  // comparison would fail for a reason that has nothing to do with narrowing.
  const actual = sortedKeys(select);
  const want = sortedKeys(expected);
  if (actual !== want) {
    throw new Error(
      `${label}: ${write.model}.${write.method} selects ${actual}, expected the primary key ${want}`
    );
  }
}

/** Prisma's "record to update not found" code. */
export const P2025 = "P2025";

/** True when `error` is the Prisma missing-row rejection. */
export function isP2025(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === P2025
  );
}

/** A stable, key-order-independent rendering of a flat `select` literal. */
function sortedKeys(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b)
  );
  return JSON.stringify(Object.fromEntries(entries));
}
