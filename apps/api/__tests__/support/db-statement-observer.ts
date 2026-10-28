import pg from "pg";

/**
 * Records the SQL statements a production read actually issued and how many
 * rows each one handed back (ISS-9627).
 *
 * NOT a duplicate of `prisma-statement-counter.ts`, which counts Prisma
 * DELEGATE CALLS through a `vi.mock("@repo/database")` seam. Two things that
 * counter cannot see are exactly the ones a read-path budget is about: it skips
 * `$`-prefixed properties, so every `$queryRaw` aggregate is invisible to it,
 * and a delegate call is not one statement — Prisma 7 issues a separate
 * statement per included relation edge. Neither counter knows how many ROWS
 * crossed the driver, which is the number that separates a database-native
 * aggregate from a `findMany` plus a JS reduce: both return the same value, and
 * only one of them transfers the population to do it.
 *
 * The seam is `pg.Client.prototype.query` rather than an export of
 * `@repo/database`, because that package exposes no statement hook and the
 * driver is the last place the two shapes still look different. Restored in a
 * `finally`, and the integration tier runs its files serially
 * (`--no-file-parallelism`), so the patch cannot leak across suites.
 */

export type ObservedStatement = {
  /** The SQL text, as the driver received it. */
  sql: string;
  /**
   * The bound parameters, positionally, as the driver received them.
   *
   * Carried so a caller can re-issue the statement — an `EXPLAIN` of the SQL a
   * production read ACTUALLY emitted needs the same `$n` values to get the same
   * plan, and a plan costed against literals somebody transcribed by hand is a
   * plan for a query nothing runs (`session-keyset-index.integration.test.ts`).
   * Empty when the driver was handed none.
   */
  values: unknown[];
  /** Rows the driver handed back. `-1` when the result carried no row array. */
  rows: number;
};

type QueryArgs = [unknown, ...unknown[]];

/**
 * Run `fn` with every statement it issues recorded.
 *
 * Only statements issued INSIDE `fn` are observed, so a caller may seed outside
 * it and budget the read alone.
 */
export async function observeStatements<T>(
  fn: () => Promise<T>
): Promise<{ result: T; statements: ObservedStatement[] }> {
  const statements: ObservedStatement[] = [];
  const original = pg.Client.prototype.query;
  const patched = function observed(this: pg.Client, ...args: QueryArgs) {
    const sql = statementText(args[0]);
    const values = statementValues(args);
    const callback = args.at(-1);
    if (typeof callback !== "function") {
      // Prisma's adapter always passes a callback; a direct `client.query(text)`
      // in the same tick does not, and must still reach the budget rather than
      // be silently dropped from it. `pg` overloads this return, so a shape
      // with no `rows` is recorded as -1 — an unreadable statement fails an
      // exact-count assertion instead of quietly not existing.
      const result = Reflect.apply(original, this, args) as
        | Promise<{ rows?: unknown[] }>
        | undefined;
      if (typeof result?.then !== "function") {
        statements.push({ sql, values, rows: -1 });
        return result;
      }
      return result.then(
        (value) => {
          statements.push({ sql, values, rows: value?.rows?.length ?? -1 });
          return value;
        },
        (error: unknown) => {
          // A rejected statement WAS issued, so it belongs in the budget. The
          // callback branch below records a failed query too; dropping it here
          // would make the two branches disagree about what a budget counts.
          statements.push({ sql, values, rows: -1 });
          throw error;
        }
      );
    }
    const wrapped = (error: unknown, result: { rows?: unknown[] }) => {
      statements.push({ sql, values, rows: result?.rows?.length ?? -1 });
      return (callback as (e: unknown, r: unknown) => unknown)(error, result);
    };
    return Reflect.apply(original, this, [...args.slice(0, -1), wrapped]);
  };
  pg.Client.prototype.query = patched as typeof pg.Client.prototype.query;
  try {
    const result = await fn();
    return { result, statements };
  } finally {
    pg.Client.prototype.query = original;
  }
}

/** Statements whose SQL matches `pattern`, in issue order. */
export function matching(
  statements: readonly ObservedStatement[],
  pattern: RegExp
): ObservedStatement[] {
  return statements.filter((statement) => pattern.test(statement.sql));
}

function statementText(config: unknown): string {
  if (typeof config === "string") {
    return config;
  }
  const text = (config as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

/**
 * The bound parameters, from either `pg` calling convention: carried on the
 * config object (`query({ text, values })`, which the Prisma adapter uses) or
 * passed positionally (`query(text, values, cb)`).
 */
function statementValues(args: QueryArgs): unknown[] {
  const onConfig = (args[0] as { values?: unknown } | null)?.values;
  if (Array.isArray(onConfig)) {
    return onConfig;
  }
  return Array.isArray(args[1]) ? args[1] : [];
}
