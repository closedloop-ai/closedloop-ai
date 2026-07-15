/**
 * @file connection-pragmas.ts
 * @description The single source of truth for the per-connection SQLite/libSQL
 * PRAGMA tuning.
 *
 * Every libSQL connection the desktop store opens — the boot-time migration
 * writer (raw `@libsql/client`, see {@link file:./migration-executor.ts}) AND each
 * Prisma writer/reader connection (via the libSQL driver adapter, see
 * {@link file:./prisma-client.ts}) — applies the SAME ordered PRAGMA sequence so
 * the WAL concurrency model, busy-timeout, and read tuning are identical no
 * matter which connection a statement lands on. Both call sites differ only in
 * HOW they run a statement (raw `client.execute` vs `client.$executeRawUnsafe`),
 * so this module exposes the statements as plain strings and each applies them.
 */

// A reader stuck behind the writer's lock should WAIT (and retry) rather than
// throw SQLITE_BUSY. During the first-launch backfill the writer briefly holds
// the database lock at each commit and, more disruptively, during the TRUNCATE
// checkpoint; a generous busy_timeout lets a contending connection spin
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
// with one writer + the reader pool the worst-case total is
// (1 + pool) × 16 MiB — a real RSS cost, but well within the FEA-2038 db-host
// budget and a fraction of what an unbounded WAL or hydration spike uses.
const CACHE_SIZE_KIB = 16_384;

// Memory-map the DB file for reads so hot-page access skips read() syscalls. 128
// MiB covers the current store with headroom. Unlike the page cache, mmap pages
// are file-backed and reclaimable under memory pressure, and every connection
// maps the SAME file — the OS shares those pages, so this does not multiply per
// connection. Read-only mapping is safe under WAL (writes still go through the
// WAL, not the mmap).
const MMAP_SIZE_BYTES = 134_217_728;

// FEA-3132 (D5): hard backstop on the PERSISTENT WAL file size. wal_autocheckpoint
// + the throttled TRUNCATE keep the WAL small in the common (short-reader) case,
// but neither caps the file's high-water mark, and a prior incident let the WAL
// reach 26 GB (RSS / OS page cache, invisible to the JS heap). After ANY
// checkpoint, journal_size_limit truncates the WAL back down to at most this many
// bytes. It cannot evict frames a live reader still pins — that needs the
// reader-snapshot lifetime cap tracked as the D4/D5 P1 child of FEA-3132 — but it
// bounds every case where readers are short. 64 MiB is generous headroom over the
// ~1 MiB autocheckpoint threshold while still capping the runaway mode.
const JOURNAL_SIZE_LIMIT_BYTES = 67_108_864;

export type ConnectionRole = "writer" | "reader";

/**
 * The ordered PRAGMA statements to apply to a freshly-opened connection of the
 * given role. Apply in order, before the connection serves any query.
 */
export function connectionPragmaStatements(role: ConnectionRole): string[] {
  const statements = [
    // WAL lets the reader pool read concurrently with the writer (the backfill).
    // It is a persistent database setting, but re-asserting it per connection is
    // harmless and keeps every connection self-describing.
    "PRAGMA journal_mode=WAL",
    // busy_timeout absorbs the brief write lock; foreign_keys matches legacy FKs.
    `PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`,
    "PRAGMA foreign_keys=ON",
    // NORMAL (not the WAL default of FULL) fsyncs the WAL only at checkpoint, not
    // on every commit. Under the first-launch backfill that is the difference
    // between one fsync per ingested row and one per checkpoint — FULL would make
    // the backfill brutally slow (and hold the write lock far longer, starving
    // readers). NORMAL is durable across application crashes in WAL mode; only a
    // power loss / OS crash can lose the last few committed transactions, which is
    // an acceptable trade for a local analytics cache that re-derives from source.
    "PRAGMA synchronous=NORMAL",
  ];
  if (role === "reader") {
    // Readers must never write. query_only makes the engine reject any write on
    // this connection (verified: a write returns SQLITE_READONLY / code 8),
    // guaranteeing a reader can never take the write lock and block the backfill.
    // WAL readers see a committed snapshot and proceed concurrently with the
    // writer. Set per reader connection — it is connection-local state.
    statements.push("PRAGMA query_only=ON");
  }
  // Bound WAL growth during the first-launch backfill. The default
  // wal_autocheckpoint (1000 pages) lets the WAL balloon when a burst of
  // ingestion writes commit faster than readers release their snapshots, and an
  // unbounded WAL inflates the db-host process RSS (the FEA-2038 OOM). A tighter
  // threshold (256 pages ≈ 1 MiB at the 4 KiB default page size) checkpoints far
  // more aggressively, keeping the WAL — and thus RSS — small throughout the
  // backfill. This is a passive checkpoint: it only folds pages readers no
  // longer pin, so it never blocks the writer or invalidates a live reader.
  statements.push("PRAGMA wal_autocheckpoint=256");
  // FEA-3132 (D5): cap the persistent WAL high-water mark (see the constant's
  // note). Applied after wal_autocheckpoint so it governs what every subsequent
  // checkpoint truncates the WAL down to.
  statements.push(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}`);
  // Read-path tuning (see constants above): a larger page cache and a file mmap
  // cut page re-reads and read() syscalls across both the backfill and the
  // dashboard's aggregations. Connection-local settings — query_only does not
  // block them (they change cache/mmap state, not the database).
  statements.push(`PRAGMA cache_size=-${CACHE_SIZE_KIB}`);
  statements.push(`PRAGMA mmap_size=${MMAP_SIZE_BYTES}`);
  return statements;
}

// The throttled TRUNCATE checkpoint interval. wal_autocheckpoint (above) runs
// PASSIVE checkpoints that fold pages back into the main db but never shrink the
// WAL file itself, so under a sustained backfill the WAL — and the OS page cache
// / RSS backing it — can still stay large. A periodic TRUNCATE checkpoint
// reclaims the WAL file down to zero once readers release their snapshots,
// bounding RSS over the whole backfill. Throttled so it never runs more than
// once per interval (cheap, best-effort).
export const WAL_TRUNCATE_INTERVAL_MS = 5000;
export const WAL_TRUNCATE_CHECKPOINT_SQL = "PRAGMA wal_checkpoint(TRUNCATE)";

// The reader pool size. Each reader connection in WAL mode holds its own
// committed snapshot for the duration of an in-flight read. While the long
// first-launch backfill streams writes, every live reader snapshot pins the WAL
// pages it can still see, so the WAL cannot checkpoint back into the main db and
// RSS grows with the WAL. Fewer readers = fewer simultaneously-pinned snapshots
// = a smaller WAL working set under the writer's load. 2 still lets the dashboard
// read concurrently with the backfill; we lose almost no parallelism vs 4 because
// the dashboard issues reads in small bursts, not a sustained 4-wide fan-out.
export const DEFAULT_READER_POOL_SIZE = 2;
