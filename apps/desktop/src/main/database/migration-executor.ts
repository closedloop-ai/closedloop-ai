/**
 * @file migration-executor.ts
 * @description The boot-time migration database connection — used ONLY to run
 * schema migrations at startup (and by tests to seed fixtures). It is NOT a
 * store-access layer.
 *
 * The desktop store's one access layer is the Prisma client (prisma-client.ts),
 * which owns the writer + reader-pool connections and is the only path store
 * reads and writes take. The sole other raw `@libsql/client` connection is THIS
 * one — a single writer the migration runner uses at boot to apply schema DDL
 * BEFORE the Prisma client exists (the runner needs multi-statement
 * `executeMultiple` and runs before any client is wired). Tests also reuse it to
 * seed fixtures. No store read or write goes through it.
 *
 * Everything exported here exists to serve that boot-migration path:
 * - `openMigrationDatabase` opens the connection (returns a {@link SqliteClient}).
 * - The `Sqlite*` types are the executor contract the migration runner consumes.
 *
 * Responsibilities of this thin executor:
 * - Translate Postgres positional params `$1,$2` → SQLite `?1,?2` centrally.
 * - Coerce JS args to libSQL `InValue` (objects → JSON text; Date → ISO;
 *   undefined → null).
 * - Shape results back to `{ rows: POJO[] }` keyed by column name.
 * - Run `transaction(cb)` on a held libSQL write transaction.
 * - Apply the SAME connection PRAGMAs the Prisma connections apply
 *   (connection-pragmas.ts) so WAL/busy-timeout/etc. are identical everywhere.
 */
import {
  type Client,
  type Config,
  createClient,
  type InValue,
  type Transaction,
} from "@libsql/client";
import { connectionPragmaStatements } from "./connection-pragmas.js";

type Results<T extends Record<string, unknown> = Record<string, unknown>> = {
  rows: T[];
  affectedRows: number;
};

export type SqliteExecutor = {
  exec(query: string): Promise<Results[]>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: unknown[]
  ): Promise<Results<T>>;
};

type TransactionalSqliteExecutor = SqliteExecutor & {
  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
};

export type SqliteClient = TransactionalSqliteExecutor & {
  close(): Promise<void>;
};

/** Postgres-style `$1` → SQLite `?1`. Numbered params preserve arg reuse + ordering. */
function translateParams(sql: string): string {
  return sql.replace(/\$(\d+)/g, "?$1");
}

function coerceArg(value: unknown): InValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value;
  }
  if (typeof value === "object") {
    // jsonb/json columns are TEXT in SQLite — store the JSON form.
    return JSON.stringify(value);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

type LibsqlRunner = Pick<Client, "execute" | "executeMultiple">;

function toResults<T extends Record<string, unknown>>(rs: {
  rows: unknown[];
  columns: string[];
  rowsAffected: number;
}): Results<T> {
  const { columns } = rs;
  const rows = rs.rows.map((raw) => {
    const row = raw as Record<number, unknown>;
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return obj as T;
  });
  return { rows, affectedRows: rs.rowsAffected };
}

function makeExecutor(runner: LibsqlRunner): SqliteExecutor {
  return {
    async exec(query: string): Promise<Results[]> {
      // exec() carries schema DDL / PRAGMA scripts that may contain MULTIPLE
      // statements (the migration runner passes a whole migration.sql), whereas
      // libSQL's execute() runs exactly one statement per call. Route through
      // executeMultiple, which splits and runs each statement in sequence. It
      // returns void (no result rows), so we surface the legacy Results[] shape
      // as an empty array — no exec() caller reads the returned rows (they are
      // all DDL/PRAGMA). $N→?N translation is harmless here (DDL is unparam'd).
      await runner.executeMultiple(translateParams(query));
      return [];
    },
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      params?: unknown[]
    ): Promise<Results<T>> {
      const rs = await runner.execute({
        sql: translateParams(query),
        args: (params ?? []).map(coerceArg),
      });
      return toResults<T>(rs);
    },
  };
}

/**
 * Open the single boot-time migration connection and return a SqliteClient
 * handle plus the libSQL `Config`. The config is handed to `createDesktopPrisma`
 * (prisma-client.ts), which opens its OWN writer + reader-pool connections from
 * it — the reader pool and WAL-checkpoint tuning live there, on the Prisma
 * connections that serve store reads/writes.
 *
 * This connection exists only so the migration runner can apply schema DDL at
 * boot before any Prisma client is wired (and so tests can seed fixtures). It is
 * a single writer; the shared connection PRAGMAs (connection-pragmas.ts) put it
 * in WAL with the same busy-timeout/synchronous/cache tuning as every other
 * connection.
 */
export async function openMigrationDatabase(
  filePath: string
): Promise<{ db: SqliteClient; config: Config }> {
  const config: Config = { url: `file:${filePath}`, intMode: "number" };
  // `@libsql/client` is patched (patches/@libsql__client@0.17.3.patch) so
  // `transaction()` cannot detach-and-leak the native connection or shed the
  // PRAGMAs applied below — the migration runner opens a transaction per
  // migration, and tests seed fixtures through this handle.
  const writer = createClient(config);
  for (const statement of connectionPragmaStatements("writer")) {
    await writer.execute(statement);
  }

  // Serialize every operation on this single connection so a statement never
  // interleaves into a held transaction (with the patched client,
  // `transaction()` runs on THIS connection, so an interleaved statement would
  // execute inside the open transaction). The migration runner is sequential,
  // so this is a defensive guard, not a hot path.
  let writeTail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeTail.then(fn, fn);
    writeTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const executor = makeExecutor(writer);
  const db: SqliteClient = {
    exec(query: string): Promise<Results[]> {
      return exclusive(() => executor.exec(query));
    },
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      params?: unknown[]
    ): Promise<Results<T>> {
      return exclusive(() => executor.query<T>(query, params));
    },
    transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
      return exclusive(async () => {
        const tx: Transaction = await writer.transaction("write");
        try {
          const value = await callback(makeExecutor(tx));
          await tx.commit();
          return value;
        } catch (error) {
          await tx.rollback().catch(() => undefined);
          throw error;
        }
      });
    },
    close(): Promise<void> {
      writer.close();
      return Promise.resolve();
    },
  };
  return { db, config };
}
