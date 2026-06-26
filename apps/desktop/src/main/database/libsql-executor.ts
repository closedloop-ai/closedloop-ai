/**
 * FEA SQLite migration — libSQL-backed executor implementing the same
 * `SqliteExecutor` / `SqliteClient` surface the rest of the desktop main process
 * already consumes, so the engine swap is mostly transparent to call sites.
 *
 * Responsibilities of this thin adapter:
 * - Translate Postgres positional params `$1,$2` → SQLite `?1,?2` centrally, so
 *   the hundreds of existing parameterized queries don't each need editing.
 * - Coerce JS args to libSQL `InValue` (objects → JSON text for TEXT/json
 *   columns; Date → ISO; undefined → null).
 * - Shape results back to `{ rows: POJO[] }` keyed by column name.
 * - Run `transaction(cb)` on a held libSQL write transaction.
 * - Open in WAL mode so the long analytics backfill (writer) and the live UI
 *   (readers) proceed concurrently — the whole point of moving off PGlite.
 */
import {
  type Client,
  type Config,
  createClient,
  type InValue,
  type Transaction,
} from "@libsql/client";

export type Results<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
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

export type TransactionalSqliteExecutor = SqliteExecutor & {
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

// Each reader connection in WAL mode holds its own committed snapshot for the
// duration of an in-flight read. While the long first-launch backfill streams
// writes, every live reader snapshot pins the WAL pages it can still see, so
// the WAL cannot checkpoint back into the main db and RSS grows with the WAL.
// Fewer readers = fewer simultaneously-pinned snapshots = a smaller WAL working
// set under the writer's load. 2 still lets the dashboard read concurrently
// with the backfill; we lost almost no parallelism vs 4 because the dashboard
// issues reads in small bursts, not a sustained 4-wide fan-out.
const DEFAULT_READER_POOL_SIZE = 2;

const READ_ONLY_PREFIX_RE = /^\s*(?:select|with)\b/i;
const WRITE_KEYWORD_RE =
  /\b(?:insert|update|delete|replace|create|alter|drop)\b/i;

/**
 * A statement is safe to run on a reader connection only if it is unambiguously
 * read-only: it starts with SELECT/WITH and contains no write keyword (covers
 * `WITH ... UPDATE` CTE writes). Anything ambiguous goes to the writer — erring
 * toward the writer is always correct, just less parallel.
 */
function isReadOnly(sql: string): boolean {
  return READ_ONLY_PREFIX_RE.test(sql) && !WRITE_KEYWORD_RE.test(sql);
}

// A reader stuck behind the writer's lock should WAIT (and retry) rather than
// throw SQLITE_BUSY. During the first-launch backfill the writer briefly holds
// the database lock at each commit and, more disruptively, during the TRUNCATE
// checkpoint below; a generous busy_timeout lets a contending connection spin
// internally until the lock clears instead of surfacing
// `SQLITE_BUSY: database is locked` to the dashboard or aborting an import with
// `cannot commit transaction - SQL statements in progress`. 15s comfortably
// outlasts any single backfill commit / checkpoint while still bounding a true
// deadlock. This is the single highest-leverage fix for the BUSY errors.
const BUSY_TIMEOUT_MS = 15_000;

// Per-connection page cache. SQLite's 2 MiB default (~500 pages) is far too small
// for the multi-GB first-launch backfill and the dashboard's grouped aggregations
// over `events`/`agents` — hot b-tree and index pages get evicted and re-read
// constantly. 16 MiB (negative = KiB, NOT pages) gives a large hit-rate win.
// Bounded deliberately: the page cache is heap (NOT reclaimable like mmap), so
// with one writer + DEFAULT_READER_POOL_SIZE readers the worst-case total is
// (1 + pool) × 16 MiB ≈ 48 MiB — a real RSS cost, but well within the FEA-2038
// db-host budget and a fraction of what an unbounded WAL or hydration spike uses.
const CACHE_SIZE_KIB = 16_384;
// Memory-map the DB file for reads so hot-page access skips read() syscalls. 128
// MiB covers the current store with headroom. Unlike the page cache, mmap pages
// are file-backed and reclaimable under memory pressure, and every connection
// maps the SAME file — the OS shares those pages, so this does not multiply per
// connection. Read-only mapping is safe under WAL (writes still go through the
// WAL, not the mmap).
const MMAP_SIZE_BYTES = 134_217_728;

async function applyConnectionPragmas(
  client: Client,
  role: "writer" | "reader"
): Promise<void> {
  // WAL lets the reader pool read concurrently with the writer (the backfill).
  // busy_timeout absorbs the brief write lock; foreign_keys matches legacy FKs.
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  await client.execute("PRAGMA foreign_keys=ON");
  // NORMAL (not the WAL default of FULL) fsyncs the WAL only at checkpoint, not
  // on every commit. Under the first-launch backfill that is the difference
  // between one fsync per ingested row and one per checkpoint — FULL would make
  // the backfill brutally slow (and hold the write lock far longer, starving
  // readers). NORMAL is durable across application crashes in WAL mode; only a
  // power loss / OS crash can lose the last few committed transactions, which is
  // an acceptable trade for a local analytics cache that re-derives from source.
  await client.execute("PRAGMA synchronous=NORMAL");
  if (role === "reader") {
    // Readers must never write. query_only makes the engine reject any write on
    // this connection, guaranteeing a reader can never take the write lock and
    // block the backfill — it backstops the isReadOnly() routing above. WAL
    // readers see a committed snapshot and proceed concurrently with the writer.
    await client.execute("PRAGMA query_only=ON");
  }
  // Bound WAL growth during the first-launch backfill. The default
  // wal_autocheckpoint (1000 pages) lets the WAL balloon when a burst of
  // ingestion writes commit faster than readers release their snapshots, and an
  // unbounded WAL inflates the db-host process RSS (the FEA-2038 OOM). A tighter
  // threshold (256 pages ≈ 1 MiB at the 4 KiB default page size) checkpoints far
  // more aggressively, keeping the WAL — and thus RSS — small throughout the
  // backfill. This is a passive checkpoint: it only folds pages readers no
  // longer pin, so it never blocks the writer or invalidates a live reader.
  await client.execute("PRAGMA wal_autocheckpoint=256");
  // Read-path tuning (see constants above): a larger page cache and a file mmap
  // cut page re-reads and read() syscalls across both the backfill and the
  // dashboard's aggregations. Connection-local settings — query_only does not
  // block them (they change cache/mmap state, not the database).
  await client.execute(`PRAGMA cache_size=-${CACHE_SIZE_KIB}`);
  await client.execute(`PRAGMA mmap_size=${MMAP_SIZE_BYTES}`);
}

/**
 * Open the local libSQL database with a connection pool and return a
 * SqliteClient-compatible handle plus the libSQL Config (for the Prisma adapter,
 * which manages its own connection).
 *
 * One WRITER connection serves all writes/transactions (serialized so two writes
 * never collide on a held transaction — SQLite has a single writer); a POOL of
 * READER connections serves read-only queries. In WAL mode the readers see a
 * committed snapshot and proceed WHILE the writer runs the long analytics
 * backfill — so the dashboard never blocks on ingestion. This is the whole point
 * of moving off PGlite's single in-process connection.
 */
export async function openLibsqlDatabase(
  filePath: string,
  options?: { readerPoolSize?: number }
): Promise<{ db: SqliteClient; config: Config }> {
  const config: Config = { url: `file:${filePath}`, intMode: "number" };
  const writer = createClient(config);
  await applyConnectionPragmas(writer, "writer");

  const poolSize = Math.max(
    1,
    options?.readerPoolSize ?? DEFAULT_READER_POOL_SIZE
  );
  const readers: Client[] = [];
  for (let i = 0; i < poolSize; i++) {
    const reader = createClient(config);
    await applyConnectionPragmas(reader, "reader");
    readers.push(reader);
  }
  let readerCursor = 0;

  // Serialize every writer operation (write-query, exec, transaction) so a
  // statement never runs against the writer while a transaction is open on it
  // (same-connection self-lock → SQLITE_BUSY). Reads bypass this entirely.
  let writeTail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeTail.then(fn, fn);
    writeTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const writerExecutor = makeExecutor(writer);
  const readerExecutors = readers.map((reader) => makeExecutor(reader));

  // Serialize every query that lands on a given reader CONNECTION. A single
  // libSQL (`@libsql/client`) connection cannot execute two statements at once —
  // doing so trips a Rust assertion in the native addon (`index.node`) that
  // aborts the whole db-host utilityProcess with SIGTRAP (surfaced as exit
  // "code: 5"). The first-launch backfill fans out many concurrent reads
  // (cloud-sync hydration + every dashboard insights section) which round-robin
  // onto the small reader pool, so without this two reads collide on one
  // connection and crash. Each reader gets its own tail (mirroring `writeTail`),
  // so DIFFERENT readers still run in parallel — the point of the pool — but one
  // connection only ever runs one query at a time.
  const readerTails: Promise<unknown>[] = readers.map(() => Promise.resolve());
  const exclusiveReader = <T>(
    idx: number,
    fn: () => Promise<T>
  ): Promise<T> => {
    const run = readerTails[idx].then(fn, fn);
    readerTails[idx] = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  // Throttled TRUNCATE checkpoint. wal_autocheckpoint (set above) runs PASSIVE
  // checkpoints that fold pages back into the main db but never shrink the WAL
  // file itself, so under a sustained backfill the WAL — and the OS page cache /
  // RSS backing it — can still stay large. A periodic TRUNCATE checkpoint
  // reclaims the WAL file down to zero once readers release their snapshots,
  // bounding RSS over the whole backfill. It is throttled so it never runs more
  // than once per interval (cheap, best-effort) and runs on the serialized
  // writer queue so it cannot collide with an open write transaction. A BUSY
  // result (a reader still pinning the tail) is ignored — autocheckpoint will
  // retry, and the next write reschedules.
  const WAL_TRUNCATE_INTERVAL_MS = 5000;
  let lastWalTruncateAt = 0;
  const maybeTruncateWal = (): void => {
    const now = Date.now();
    if (now - lastWalTruncateAt < WAL_TRUNCATE_INTERVAL_MS) {
      return;
    }
    lastWalTruncateAt = now;
    exclusive(() =>
      writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").then(
        () => undefined,
        () => undefined
      )
    ).catch(() => undefined);
  };

  const db: SqliteClient = {
    async exec(query: string): Promise<Results[]> {
      const result = await exclusive(() => writerExecutor.exec(query));
      maybeTruncateWal();
      return result;
    },
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      params?: unknown[]
    ): Promise<Results<T>> {
      if (isReadOnly(query)) {
        const idx = readerCursor % readers.length;
        readerCursor += 1;
        return exclusiveReader(idx, () =>
          readerExecutors[idx].query<T>(query, params)
        );
      }
      const result = exclusive(() => writerExecutor.query<T>(query, params));
      result.finally(() => maybeTruncateWal()).catch(() => undefined);
      return result;
    },
    async transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>) {
      const result = await exclusive(async () => {
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
      maybeTruncateWal();
      return result;
    },
    close(): Promise<void> {
      writer.close();
      for (const reader of readers) {
        reader.close();
      }
      return Promise.resolve();
    },
  };
  return { db, config };
}
