import {
  shiftVibeCorpusInstants,
  type VibeCorpusIdleGap,
  type VibeCorpusOffsets,
  vibeCorpusOffsets,
} from "@repo/api/src/vibe-seed-corpus-time";
import type { DesktopPrisma } from "../../src/main/database/prisma-client.js";

/**
 * The one time-shift rule the vibe environment (ISS-12017) applies to the
 * frozen golden corpus, on the Desktop store and the web seed alike:
 *
 *   corpusShiftMs = Date.parse(now) - Date.parse(newestCorpusInstant)
 *
 * where `newestCorpusInstant` is `MAX(sessions.last_activity_at)` of the
 * Desktop store the golden importer builds, before anything is shifted, and
 * `now` is the single instant the vibe CLI hands to both sides. Adding the
 * shift to a corpus timestamp moves the newest session to exactly `now` and
 * keeps every gap between corpus events intact, so date-windowed screens (last
 * 7 and 30 days) are populated.
 *
 * The store `prepare` writes is ALREADY shifted: re-applying the formula to it
 * yields 0, so a consumer that reads sessions out of that store must not shift
 * them a second time.
 */
export function computeCorpusShiftMs(
  newestCorpusInstantIso: string,
  nowIso: string
): number {
  const newest = parseIsoInstant(newestCorpusInstantIso, "newestCorpusInstant");
  const now = parseIsoInstant(nowIso, "now");
  return now - newest;
}

/** Shifts one ISO-8601 instant, keeping the store's `…T…Z` millisecond form. */
export function shiftIsoInstant(iso: string, shiftMs: number): string {
  return new Date(parseIsoInstant(iso, "timestamp") + shiftMs).toISOString();
}

export function parseIsoInstant(value: string, label: string): number {
  if (!ISO_INSTANT_RE.test(value)) {
    throw new Error(`${label} must be an ISO-8601 instant, got ${value}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label} must be an ISO-8601 instant, got ${value}`);
  }
  return ms;
}

export const NEWEST_CORPUS_INSTANT_SQL =
  "SELECT MAX(last_activity_at) AS newest FROM sessions WHERE last_activity_at > '2000'";

/**
 * Columns that hold corpus time without the `_at` suffix. Epoch-millisecond
 * columns are shifted numerically, ISO columns textually.
 */
export const EXTRA_ISO_TIME_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  codex_trace_span: ["start_time", "end_time"],
};
export const EPOCH_MS_TIME_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  session_activity_segments: ["start_ms", "end_ms"],
};

/** Tables whose rows are bookkeeping about the store, not corpus data. */
const SKIPPED_TABLES = new Set(["_desktop_migrations"]);

export type StoreShiftResult = {
  readonly columnsShifted: number;
  readonly startedDayTablesRederived: number;
};

/**
 * Applies `shiftMs` to every corpus-derived time column in the store.
 *
 * Only values older than `importStartedAt` move: the importer runs on the real
 * clock, so a value at or after the moment the import began was stamped by the
 * import itself (an `updated_at`, a `created_at` default) and already reads as
 * "now". `started_day` columns are re-derived from the shifted
 * `sessions.started_at` (they are its UTC day); the rollups that own them are
 * recomputed by the caller through the store's own recompute.
 *
 * Timestamps embedded in JSON payloads (`events.data`, `sessions.metadata`) are
 * left as the corpus wrote them.
 */
export async function shiftStoreTimestamps(
  prisma: DesktopPrisma,
  shiftMs: number,
  importStartedAt: string,
  idleGaps: readonly CorpusIdleGap[] = []
): Promise<StoreShiftResult> {
  const importStartedMs = parseIsoInstant(importStartedAt, "importStartedAt");
  const offsets = vibeCorpusOffsets(shiftMs, idleGaps);
  const isoShift = (column: string) =>
    caseByBoundary(
      offsets,
      (boundary) => `"${column}" < '${boundary.beforeIso}'`,
      (offsetMs) =>
        `strftime('%Y-%m-%dT%H:%M:%fZ', "${column}", '${(offsetMs / 1000).toFixed(3)} seconds')`
    );
  const epochShift = (column: string) =>
    caseByBoundary(
      offsets,
      (boundary) => `"${column}" < ${Date.parse(boundary.beforeIso)}`,
      (offsetMs) => `"${column}" + ${Math.round(offsetMs)}`
    );
  const tables = await listTableColumns(prisma);
  const statements: string[] = [];
  let startedDayTables = 0;
  for (const [table, columns] of tables) {
    if (SKIPPED_TABLES.has(table)) {
      continue;
    }
    for (const column of isoTimeColumns(table, columns)) {
      statements.push(
        `UPDATE "${table}" SET "${column}" = ${isoShift(column)} WHERE typeof("${column}") = 'text' AND "${column}" > '2000' AND "${column}" < '${importStartedAt}' AND julianday("${column}") IS NOT NULL`
      );
    }
    for (const column of EPOCH_MS_TIME_COLUMNS[table] ?? []) {
      statements.push(
        `UPDATE "${table}" SET "${column}" = ${epochShift(column)} WHERE "${column}" IS NOT NULL AND "${column}" < ${importStartedMs}`
      );
    }
    if (
      table !== "sessions" &&
      columns.has("started_day") &&
      columns.has("session_id")
    ) {
      startedDayTables += 1;
      statements.push(
        `UPDATE "${table}" SET started_day = (SELECT substr(s.started_at, 1, 10) FROM sessions s WHERE s.id = "${table}".session_id) WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = "${table}".session_id AND s.started_at IS NOT NULL)`
      );
    }
  }
  await prisma.write(async (client) => {
    for (const sql of statements) {
      await client.$executeRawUnsafe(sql);
    }
  });
  return {
    columnsShifted: statements.length - startedDayTables,
    startedDayTablesRederived: startedDayTables,
  };
}

function isoTimeColumns(table: string, columns: ReadonlySet<string>): string[] {
  const suffixed = [...columns].filter((column) => column.endsWith("_at"));
  return [...suffixed, ...(EXTRA_ISO_TIME_COLUMNS[table] ?? [])];
}

async function listTableColumns(
  prisma: DesktopPrisma
): Promise<Map<string, Set<string>>> {
  const rows = await prisma.client.$queryRawUnsafe<
    { table_name: string; column_name: string; column_type: string }[]
  >(
    `SELECT m.name AS table_name, p.name AS column_name, p.type AS column_type
       FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`
  );
  const tables = new Map<string, Set<string>>();
  for (const row of rows) {
    if (
      row.column_type.toUpperCase() !== "TEXT" &&
      !(EPOCH_MS_TIME_COLUMNS[row.table_name] ?? []).includes(row.column_name)
    ) {
      continue;
    }
    const columns = tables.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    tables.set(row.table_name, columns);
  }
  return tables;
}

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * ISS-12135: a stretch of corpus time with no session in it, which the shift
 * closes. The corpus was recorded in bursts weeks apart, the last one about
 * ten days after the rest, so shifting the newest session onto `now` left
 * every branch, merge and team session at least ten days old and the last 7
 * days nearly empty. Every instant before `beforeIso` (the start of the session
 * that ends the gap) moves `closeMs` further forward for each gap after it, so
 * each gap shrinks to {@link KEPT_IDLE_GAP_MS}; the order of the sessions and
 * every span inside a session are unchanged.
 */
export type CorpusIdleGap = VibeCorpusIdleGap;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A gap longer than this between one session's last activity and the next start is closed. */
export const MAX_IDLE_GAP_MS = 2 * DAY_MS;
/** What a closed gap shrinks to. */
export const KEPT_IDLE_GAP_MS = DAY_MS;

export const CORPUS_SESSION_SPANS_SQL =
  "SELECT started_at AS startedAt, last_activity_at AS lastActivityAt FROM sessions WHERE started_at > '2000' AND last_activity_at > '2000'";

/** Every idle gap longer than {@link MAX_IDLE_GAP_MS} among the sessions' spans, oldest first. */
export function findCorpusIdleGaps(
  sessions: readonly { startedAt: string; lastActivityAt: string }[]
): CorpusIdleGap[] {
  const spans = sessions
    .map((session) => ({
      startedAt: session.startedAt,
      startMs: parseIsoInstant(session.startedAt, "startedAt"),
      endMs: parseIsoInstant(session.lastActivityAt, "lastActivityAt"),
    }))
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  let latestEnd = Number.NEGATIVE_INFINITY;
  const gaps: CorpusIdleGap[] = [];
  for (const span of spans) {
    const idle = span.startMs - latestEnd;
    if (Number.isFinite(idle) && idle > MAX_IDLE_GAP_MS) {
      gaps.push({
        beforeIso: span.startedAt,
        closeMs: idle - KEPT_IDLE_GAP_MS,
      });
    }
    latestEnd = Math.max(latestEnd, span.endMs);
  }
  return gaps;
}

function caseByBoundary(
  offsets: VibeCorpusOffsets,
  before: (boundary: { beforeIso: string }) => string,
  shifted: (offsetMs: number) => string
): string {
  if (offsets.boundaries.length === 0) {
    return shifted(offsets.lastMs);
  }
  const arms = offsets.boundaries
    .map(
      (boundary) =>
        `WHEN ${before(boundary)} THEN ${shifted(boundary.offsetMs)}`
    )
    .join(" ");
  return `CASE ${arms} ELSE ${shifted(offsets.lastMs)} END`;
}

const JSON_START = /^\s*[[{]/;

/**
 * ISS-12135: the instants a session's JSON columns carry (`metadata`'s
 * per-message timestamps, the trace sources) move with the same idle-gap
 * closing shift as the columns, so the session timeline reads the session's
 * own dates instead of the corpus's. Instants at or after `importStartedAt`
 * were stamped by the import and stay.
 */
export async function shiftEmbeddedSessionInstants(
  prisma: DesktopPrisma,
  shiftMs: number,
  importStartedAt: string,
  idleGaps: readonly CorpusIdleGap[] = []
): Promise<number> {
  const map = { shiftMs, importStartedAt, idleGaps: [...idleGaps] };
  const columns = (await listTableColumns(prisma)).get("sessions") ?? new Set();
  const jsonColumns = [...columns].filter(
    (column) => !(column.endsWith("_at") || column === "id")
  );
  const selected = jsonColumns.map((column) => `"${column}"`).join(", ");
  const rows = await prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT id, ${selected} FROM sessions`
  );
  let shifted = 0;
  await prisma.write(async (client) => {
    for (const row of rows) {
      for (const column of jsonColumns) {
        const value = row[column];
        if (typeof value !== "string" || !JSON_START.test(value)) {
          continue;
        }
        const next = shiftVibeCorpusInstants(value, map);
        if (next !== value) {
          await client.$executeRawUnsafe(
            `UPDATE sessions SET "${column}" = ? WHERE id = ?`,
            next,
            row.id
          );
          shifted += 1;
        }
      }
    }
  });
  return shifted;
}
