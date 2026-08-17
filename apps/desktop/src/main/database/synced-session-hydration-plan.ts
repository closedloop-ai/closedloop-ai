/**
 * @file synced-session-hydration-plan.ts
 * @description ISS-6105: bound a synced-session hydration by the HEAP its rows
 * will occupy, instead of by a fixed count of session ids.
 *
 * `loadSqliteSyncedSessions` reads every relation for every id in a chunk up
 * front, holds all of those raw row arrays alive together, and only then
 * assembles. Peak heap is therefore the SUM over the chunk, and the chunk was a
 * flat 200 ids — so peak scaled with how many sessions a caller happened to ask
 * for and with how heavy the heaviest of them was, with nothing in between.
 *
 * Measured on the real 2.1 GB snapshot (2,962 sessions), hydrating the five most
 * recently updated sessions with the cloud-sync options:
 *
 *     loadSyncedSessions(5 ids)   peak +492 MB   retained +69 MB
 *     loadSyncedSessions(25 ids)  peak +492 MB   retained +73 MB
 *
 * Five ids cost the same as twenty-five because ONE session dominates
 * (26,071 events / 22,001 token_events / 9.86 MB of `sessions.metadata`), and
 * because everything in the chunk is resident at once its neighbours add on top
 * rather than reusing its space. Isolated, that session alone hydrates at
 * +263 MB while the other four together hydrate at +116 MB — i.e. the batch is
 * paying `263 + 116`, not `max(263, 116)`.
 *
 * This module turns the chunk boundary into a BUDGET. Sessions are sized by one
 * pre-read, then packed into chunks whose estimated heap stays under
 * {@link SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES}. Every heavy term is sized
 * from BYTES rather than from a row count with an assumed average, because an
 * average is just the id-count proxy again: `events.data` rows run from empty to
 * tens of KiB, so a per-row mean under-prices a payload-heavy session by more
 * than an order of magnitude and lets a nominal 48 MiB chunk hold hundreds.
 *
 * A session whose own estimate exceeds the whole budget is given a chunk to
 * itself rather than being deferred: progress is never sacrificed to the bound
 * (the same rule `hydrateWithinByteBudget` follows), so peak becomes
 * `max(budget, heaviest single session)` instead of the sum of the batch.
 *
 * Everything here is an ESTIMATE used only to choose chunk boundaries. Chunking
 * is already proven result-identical — `assembleSyncedSessions` builds each
 * session from that session's own rows (`ids.flatMap`), so concatenating chunk
 * results equals a single load — which is exactly why this is safe to make
 * adaptive. A wrong estimate costs memory or round trips; it can never change,
 * drop, or truncate a session.
 */
import type { SyncedSessionLoadOptions } from "../agent-sync/agent-session-sync-source.js";
import { writePersistentLog } from "../logging/persistent-log.js";
import { yieldDbHostLoop } from "./db-host/yield-db-host-loop.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

/**
 * The per-session sizing facts the chunk planner packs against.
 *
 * A term is `null` when its true value is not known — because the sizing read
 * produced something that cannot be a count, or (for `eventDataBytes` alone)
 * because the hydration's shape means it was never measured. `null` is the
 * honest representation of UNKNOWN and is deliberately not zero: see
 * {@link estimateSessionHydrationHeapBytes} for why a fabricated zero is the one
 * wrong answer this planner cannot tolerate.
 */
export type SyncedSessionHydrationCost = {
  sessionId: string;
  /**
   * `length(cast(sessions.metadata as blob))` — BYTES, not characters — 0 when
   * the row carries no metadata, or `null` when the sizing read could not
   * produce a byte count.
   */
  metadataBytes: number | null;
  /** `COUNT(*)` of this session's `events` rows, or `null` when unknown. */
  eventRowCount: number | null;
  /**
   * `SUM(LENGTH(CAST(events.data AS BLOB)))` over this session's rows — the
   * SIZE in BYTES of the event payloads, not a count of them.
   *
   * `null` when unknown, which includes the deliberate case of a shape that
   * nulls `events.data` in SQL: that hydration never loads a blob, so the term
   * is not measured (see {@link loadSyncedSessionHydrationCosts}) and
   * {@link estimateSessionHydrationHeapBytes} does not consult it.
   */
  eventDataBytes: number | null;
  /** `COUNT(*)` of this session's `token_events` rows, or `null` when unknown. */
  tokenEventRowCount: number | null;
};

/** Which of the heavy columns a given hydration will actually SELECT. */
export type SyncedSessionHydrationShape = {
  /** FEA-2038 `omitEventData` — the per-event `data` blob is nulled in SQL. */
  omitEventData: boolean;
  /** ISS-6050 `omitTokenEventCostColumns` — `cost_summary` is nulled in SQL. */
  omitTokenEventCostColumns: boolean;
};

/**
 * Heap cost of one byte of `sessions.metadata`.
 *
 * Measured: the 9.86 MB metadata blob of the heaviest session in the snapshot
 * reads and parses at +33 MB peak — the string, plus the object graph
 * `parseJsonObjectText` builds from it. 3.5 is that ratio, kept deliberately
 * whole-number-ish because it is a packing heuristic, not an accounting figure.
 */
export const METADATA_HEAP_BYTES_PER_SOURCE_BYTE = 3.5;

/**
 * Heap cost of one `events` row whose `data` blob was nulled in SQL.
 *
 * Measured: 26,071 rows at +20 MB peak ≈ 800 B/row — the row POJO plus its
 * column strings. The blob itself is not in this number; see
 * {@link EVENT_DATA_HEAP_BYTES_PER_SOURCE_BYTE}, which is sized from the
 * summed blob LENGTH rather than from this row count.
 */
export const EVENT_ROW_HEAP_BYTES = 800;

/**
 * Heap cost of one stored byte of `events.data`, for a shape that keeps it.
 *
 * This term is sized from the ACTUAL summed blob length, not from the row count.
 * A per-row average cannot bound it: `events.data` rows range from empty to tens
 * of KiB, and the detail / branch-trace lanes call `loadSyncedSessions` WITHOUT
 * `omitEventData`, so a handful of payload-heavy sessions priced at an average
 * would fit a nominal 48 MiB chunk while their real working set ran to hundreds
 * of MiB — the id-count proxy this module exists to replace, wearing a heap
 * number's clothes.
 *
 * The ratio is the measured one from
 * {@link METADATA_HEAP_BYTES_PER_SOURCE_BYTE}, and deliberately a SEPARATE
 * constant rather than an alias: it is the same operation on the same kind of
 * column (a SQLite JSON TEXT value read into a string and parsed into an object
 * graph), so it starts at the same number, but the two are independently
 * re-tunable once `events.data` is measured on its own. Do not collapse them.
 */
export const EVENT_DATA_HEAP_BYTES_PER_SOURCE_BYTE = 3.5;

/**
 * Heap cost of one `token_events` row with its sync-only columns nulled.
 *
 * The scalar counts and timestamps only. ISS-6050 already nulls `cost_summary`
 * and `source_identity` in SQL for every LIST read, so this is what those reads
 * actually pay.
 */
export const TOKEN_EVENT_ROW_HEAP_BYTES = 1200;

/**
 * Additional heap for one `token_events` row that carries `cost_summary`.
 *
 * Measured: 22,001 rows WITH the blob read at +97 MB peak ≈ 4.6 KB/row, against
 * the ~1.2 KB the nulled projection costs — so the blob is ~3.4 KB of it. The
 * cloud-sync payload builder is the only consumer that needs it, and it is the
 * single largest per-session term in the drain's hydration.
 */
export const TOKEN_EVENT_COST_SUMMARY_HEAP_BYTES_PER_ROW = 3400;

/**
 * Multiplier applied to the summed row/blob terms to cover assembly.
 *
 * Measured: the heaviest session's raw terms sum to ~150 MB
 * (33 metadata + 20 events + 97 token_events) while its whole
 * `loadSyncedSessions` peaks at +263 MB — the grouping Maps, the per-session
 * derivations, and the assembled `SyncedAgentSession` itself. 1.75 is that
 * ratio.
 */
export const HYDRATION_ASSEMBLY_HEAP_MULTIPLIER = 1.75;

/**
 * Heap a single hydration chunk may plan to occupy.
 *
 * 48 MiB, sized against the goal's Stage 1 gate of 50 MB peak per db-host op:
 * the planner's job is to keep a chunk under that ceiling, so the budget sits
 * just below it rather than at it. It bounds the WORKING SET, which is the
 * property that matters — peak stops tracking corpus or batch size and starts
 * tracking this constant.
 *
 * It does NOT bound a session that is individually larger (see
 * {@link planSyncedSessionHydrationChunks}); nothing at this seam can, because
 * that session's rows have to be resident to be assembled at all.
 */
export const SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES = 48 * 1024 * 1024;

/**
 * Estimate used for a session whose true size is UNKNOWN.
 *
 * Two things produce an unknown: the sizing read returned no row for the session
 * (it raced a delete, or the read failed and the caller degraded), or it
 * returned a value that cannot be a count (see {@link sizingTerm}). Sizing
 * either at the budget makes that session take a chunk of its own — the
 * CONSERVATIVE direction. Sizing it at zero would pack an unknown session
 * alongside a full budget of known ones, which is the one way an unknown could
 * cost memory rather than round trips.
 */
export const UNKNOWN_SESSION_HYDRATION_HEAP_BYTES =
  SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES;

/**
 * Count backstop retained from the pre-ISS-6105 fixed chunking.
 *
 * A chunk of tiny sessions could otherwise grow without limit and overflow
 * SQLite's bound-parameter ceiling — the git LOC query repeats the `IN` list 3x,
 * so a chunk costs ~3x its id count in placeholders. This is the same 200 the
 * flat chunker used, kept as a ceiling rather than as the sizing rule.
 */
export const SYNCED_SESSION_HYDRATE_MAX_CHUNK_IDS = 200;

/**
 * Read one sizing term, or `null` when the value cannot be a count.
 *
 * A NaN term may not be propagated: every comparison against NaN is false, so
 * `currentBytes + bytes > budget` would never trip and the planner would pack
 * the rest of the batch into one unbounded chunk — silently restoring the exact
 * behaviour this module exists to remove. But flooring nonsense to ZERO is worse
 * still, and in the same direction: a zero-sized session is FREE to pack, so an
 * arbitrarily heavy session whose count arrived corrupt would be packed
 * alongside a full budget of known ones. Both failures end at the oversized
 * chunk this planner exists to prevent, so an unusable value becomes `null`
 * (UNKNOWN) and is sized at the whole budget by the caller instead.
 *
 * Zero is a legitimate count — a session with no metadata and no rows — and is
 * kept as such.
 */
function sizingTerm(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Estimated peak heap, in bytes, that hydrating one session will cost.
 *
 * A session carrying ANY unknown term is sized at
 * {@link UNKNOWN_SESSION_HYDRATION_HEAP_BYTES} — the whole budget — so it takes
 * a chunk of its own rather than being packed as though the missing term were
 * zero. Degrading toward "expensive" costs round trips; degrading toward "free"
 * costs the memory bound.
 */
export function estimateSessionHydrationHeapBytes(
  cost: SyncedSessionHydrationCost,
  shape: SyncedSessionHydrationShape
): number {
  const metadata = sizingTerm(cost.metadataBytes);
  const events = sizingTerm(cost.eventRowCount);
  const tokenEvents = sizingTerm(cost.tokenEventRowCount);
  // A shape that nulls `events.data` in SQL never loads a blob, so the term is
  // a true zero for it rather than an unmeasured unknown.
  const eventData = shape.omitEventData ? 0 : sizingTerm(cost.eventDataBytes);
  if (
    metadata === null ||
    events === null ||
    tokenEvents === null ||
    eventData === null
  ) {
    return UNKNOWN_SESSION_HYDRATION_HEAP_BYTES;
  }
  const eventBytes =
    events * EVENT_ROW_HEAP_BYTES +
    eventData * EVENT_DATA_HEAP_BYTES_PER_SOURCE_BYTE;
  const tokenEventBytes =
    tokenEvents *
    (TOKEN_EVENT_ROW_HEAP_BYTES +
      (shape.omitTokenEventCostColumns
        ? 0
        : TOKEN_EVENT_COST_SUMMARY_HEAP_BYTES_PER_ROW));
  const raw =
    metadata * METADATA_HEAP_BYTES_PER_SOURCE_BYTE +
    eventBytes +
    tokenEventBytes;
  return Math.ceil(raw * HYDRATION_ASSEMBLY_HEAP_MULTIPLIER);
}

/**
 * Pack `ids` into hydration chunks whose estimated heap stays under `budget`.
 *
 * Order is preserved exactly — every id appears once, in the caller's order —
 * because the caller concatenates the chunk results and its own id order is what
 * `assembleSyncedSessions` projects against. A session whose own estimate
 * exceeds the whole budget takes a chunk to itself and is NEVER dropped: this
 * function only decides where the boundaries fall.
 */
export function planSyncedSessionHydrationChunks(
  ids: readonly string[],
  costs: ReadonlyMap<string, SyncedSessionHydrationCost>,
  shape: SyncedSessionHydrationShape,
  budgetBytes: number = SYNCED_SESSION_HYDRATION_HEAP_BUDGET_BYTES,
  maxChunkIds: number = SYNCED_SESSION_HYDRATE_MAX_CHUNK_IDS
): string[][] {
  if (ids.length === 0) {
    return [];
  }
  const budget = Math.max(1, budgetBytes);
  const idCeiling = Math.max(1, maxChunkIds);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const id of ids) {
    const cost = costs.get(id);
    const bytes = cost
      ? estimateSessionHydrationHeapBytes(cost, shape)
      : UNKNOWN_SESSION_HYDRATION_HEAP_BYTES;
    const wouldExceedBudget =
      current.length > 0 && currentBytes + bytes > budget;
    const wouldExceedCount = current.length >= idCeiling;
    if (wouldExceedBudget || wouldExceedCount) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(id);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

type SizingRow = {
  session_id: string;
  metadata_bytes: number | bigint | null;
  event_rows: number | bigint | null;
  /** Absent — not null — when the shape does not read `events.data`. */
  event_data_bytes?: number | bigint | null;
  token_event_rows: number | bigint | null;
};

/** Scope of the durable main-process log this lane's degradations report to. */
const HYDRATION_SIZING_LOG_SCOPE = "sync-source";

/**
 * Read one sizing column off the raw-SQL boundary, or `null` when it cannot be
 * a count.
 *
 * `COALESCE(LENGTH(CAST(... AS BLOB)), 0)` and `COUNT(*)` cannot legitimately
 * produce a null,
 * a negative, or a non-finite number, so any of those means the row is corrupt
 * or the boundary is misbehaving — not that the session is empty. Reporting it
 * as zero would make a potentially huge session look FREE to pack, so it is
 * reported as UNKNOWN and surfaced on the durable main-process log instead. The
 * unusable value is never stored on the cost record.
 */
function toSizingCount(
  value: number | bigint | null,
  sessionId: string,
  fieldName: string
): number | null {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (numeric !== null && Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  writePersistentLog(
    "warn",
    HYDRATION_SIZING_LOG_SCOPE,
    `Degraded invalid ${fieldName} to unknown for session ${sessionId} (raw=${String(value)}); the hydration planner sizes that session at the whole heap budget instead of packing it as free`
  );
  return null;
}

/**
 * Read the sizing facts for `ids` in ONE statement.
 *
 * The two COUNT terms resolve through an index the schema already carries — the
 * covering `idx_events_session_id` / `idx_token_events_session` — so they cost a
 * handful of index probes per session. The two SIZE terms do not, and cannot:
 * a length can only be had by reaching the row payload. This read is therefore
 * cheap-ish, not free, and the docstring says so rather than claiming an
 * index-only pre-read it does not perform.
 *
 * Both size terms cast to BLOB first. `LENGTH()` on a TEXT value counts
 * CHARACTERS and walks the UTF-8 to do it; `LENGTH(CAST(x AS BLOB))` returns
 * BYTES and skips the walk. Measured on 400 rows x 300 KB of non-ASCII text:
 * 2,379 ms and a 2x UNDER-count, against 680 ms and the true byte count. The
 * under-count is the half that matters — these terms price a session, and
 * under-pricing is what packs an oversized session into a shared chunk.
 *
 * `SUM(LENGTH(...))` over `events.data` is additionally selected ONLY for a
 * `shape` that actually keeps the column. The hot lanes (the list / analytics
 * full-corpus reads and, since FEA-2718, the sync payload builder) all pass
 * `omitEventData` and so never pay it; the detail / branch-trace lanes that
 * really do load the blobs pay one payload scan rather than being mis-sized by
 * more than an order of magnitude.
 *
 * It deliberately does not touch `session_analytics`: that table is a DERIVED
 * rollup, and sizing the read that produces the truth against a cache of it
 * would mis-size exactly the rows whose rollup is stale.
 *
 * ISS-6119: the metadata term stays the BARE column even for a shape whose
 * hydration narrows it (`omitPreviewStrippedMetadata`). Applying the same
 * `json_valid` + `json_remove` projection here was measured on the real 2,972-
 * session corpus at **283 ms against 93 ms** for the widest sweep — 3x, ~190 ms
 * of extra SYNCHRONOUS db-host CPU — because this read throws its bytes away
 * once a boundary is picked, so the two JSON parses would buy accuracy and
 * nothing else. The hydration read pays the same parses to get a materially
 * smaller materialized column; this one would not.
 *
 * What the bare column costs instead is a systematic OVER-estimate for the
 * narrowing shapes (126.6 MB sized against 60.1 MB actually materialized,
 * corpus-wide). That is the safe direction, and the one this module already
 * accepts everywhere else: over-pricing can only make a chunk SMALLER, never
 * larger, so it costs round trips and never the memory bound. A session heavy
 * enough for the gap to matter already exceeds the whole budget and takes a
 * chunk of its own under either number.
 *
 * `sync-source-metadata-preview-projection.test.ts` pins that this statement
 * never grows a `json_remove`, so the cost cannot be reintroduced silently.
 */
export async function loadSyncedSessionHydrationCosts(
  prisma: DesktopPrisma,
  ids: string[],
  shape: SyncedSessionHydrationShape
): Promise<Map<string, SyncedSessionHydrationCost>> {
  const measureEventDataBytes = !shape.omitEventData;
  const eventDataBytesTerm = measureEventDataBytes
    ? `(
          SELECT COALESCE(SUM(LENGTH(CAST(e2.data AS BLOB))), 0)
          FROM events e2
          WHERE e2.session_id = s.id
        ) AS event_data_bytes,`
    : "";
  const costs = new Map<string, SyncedSessionHydrationCost>();
  if (ids.length === 0) {
    return costs;
  }
  // Chunked against the SAME id ceiling the hydration reads respect. The sizing
  // read runs BEFORE the packer applies that ceiling, so without this it would
  // bind one placeholder per id over the caller's WHOLE list — and the widest
  // caller is the capped full-corpus list fallback at MAX_WORKING_SET_SESSIONS
  // (5,000) ids. That happens to sit under modern SQLite's 32,766-parameter
  // default, but relying on it would make the one statement that decides the
  // chunk boundaries the only statement in this lane with no bound of its own.
  // Mirrors `findSqliteExistingSessionIds`, which chunks for the same reason.
  const batches = chunkIds(ids, SYNCED_SESSION_HYDRATE_MAX_CHUNK_IDS);
  for (let i = 0; i < batches.length; i++) {
    // One `prisma.read` PER BATCH, exactly as `loadSqliteSyncedSessions` does:
    // holding a single read open across the whole sweep would pin one of the two
    // pooled readers for its duration, so separate batches round-robin and let a
    // concurrent sync/dashboard read use the other.
    const rows = await prisma.read((reader) =>
      selectRowsByIds<SizingRow>(
        reader,
        `
      SELECT
        s.id AS session_id,
        COALESCE(LENGTH(CAST(s.metadata AS BLOB)), 0) AS metadata_bytes,
        (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_rows,
        ${eventDataBytesTerm}
        (
          SELECT COUNT(*)
          FROM token_events te
          WHERE te.session_id = s.id
        ) AS token_event_rows
      FROM sessions s
      WHERE s.id IN (__IDS__)
    `,
        batches[i]
      )
    );
    for (const row of rows) {
      costs.set(row.session_id, {
        sessionId: row.session_id,
        metadataBytes: toSizingCount(
          row.metadata_bytes,
          row.session_id,
          "metadata_bytes"
        ),
        eventRowCount: toSizingCount(
          row.event_rows,
          row.session_id,
          "event_rows"
        ),
        // Not measured for an `omitEventData` shape, which is not a degradation
        // — that hydration loads no blob, so the estimator scores the term zero
        // without consulting this field.
        eventDataBytes: measureEventDataBytes
          ? toSizingCount(
              row.event_data_bytes ?? null,
              row.session_id,
              "event_data_bytes"
            )
          : null,
        tokenEventRowCount: toSizingCount(
          row.token_event_rows,
          row.session_id,
          "token_event_rows"
        ),
      });
    }
    // FEA-2264: yield a macrotask between batches. SQLite is synchronous on the
    // db host's single JS thread, and awaiting a libSQL statement only turns the
    // MICROTASK queue — so without a real loop turn the renderer's queued
    // `desktop:db:*` reads stay blocked for the whole sweep. The widest caller
    // here is the 5,000-id list fallback on the 2-second page-data poll, i.e. 25
    // batches back to back. Skipping the final batch avoids an idle turn before
    // returning. Mirrors the identical boundary in `loadSqliteSyncedSessions`.
    if (i < batches.length - 1) {
      await yieldDbHostLoop();
    }
  }
  return costs;
}

/**
 * Max session ids hydrated per database round on the LIGHTWEIGHT usage load,
 * which reads only `sessions` + `token_usage` and so has no per-session term
 * worth sizing — and the count backstop this module's packer falls back to when
 * the sizing read cannot answer.
 *
 * Sized to stay well under SQLite's bound-parameter ceiling (the git LOC query
 * repeats the `IN` list 3x → ~3x ids placeholders per statement). The FULL load
 * no longer uses it as its sizing rule; see
 * {@link SYNCED_SESSION_HYDRATE_MAX_CHUNK_IDS}.
 */
export const SYNCED_SESSION_HYDRATE_CHUNK_SIZE = 200;

/** Split `ids` into fixed-size chunks, preserving order. */
export function chunkIds(ids: string[], size: number): string[][] {
  if (ids.length <= size) {
    return [ids];
  }
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Choose a hydration's chunk boundaries from what each session will actually
 * cost, so peak heap tracks the working-set budget rather than the caller's id
 * count.
 *
 * The sizing read is BEST-EFFORT by construction. If it throws — a transient
 * storage error, a reader that could not be acquired — this degrades to the
 * pre-ISS-6105 flat chunking rather than failing the hydration: a hydration that
 * cannot size itself must still return every session it was asked for, because
 * an empty return is what the sync lane's absence handling has to interpret, and
 * ISS-6031 established that a read failure must never be read as a deletion. The
 * cost of degrading is memory, never correctness.
 */
export async function planSyncedSessionHydration(
  prisma: DesktopPrisma,
  ids: string[],
  options: SyncedSessionLoadOptions | undefined,
  log: (message: string) => void
): Promise<string[][]> {
  const shape: SyncedSessionHydrationShape = {
    omitEventData: options?.omitEventData === true,
    omitTokenEventCostColumns: options?.omitTokenEventCostColumns === true,
  };
  try {
    const costs = await loadSyncedSessionHydrationCosts(prisma, ids, shape);
    return planSyncedSessionHydrationChunks(ids, costs, shape);
  } catch (error) {
    const message = sizingDegradeMessage(ids.length, error);
    // Tee'd on purpose. `log` is the FEA-3568 injectable diagnostic sink, which
    // `db-host-worker.ts` does NOT supply — so in production it is a no-op, and
    // on its own it would make a whole-read failure the ONE degradation in this
    // module with no durable trace, while the far smaller per-column case
    // (`toSizingCount`) reported one. Both now land on the same scope.
    log(message);
    writePersistentLog("warn", HYDRATION_SIZING_LOG_SCOPE, message);
    return chunkIds(ids, SYNCED_SESSION_HYDRATE_CHUNK_SIZE);
  }
}

/**
 * The one wording for a sizing-read degradation, built once and sent to both
 * sinks so the durable log and the injected diagnostic sink cannot drift.
 */
export function sizingDegradeMessage(idCount: number, error: unknown): string {
  return `sync-source: hydration sizing read failed for ${idCount} session(s); falling back to fixed ${SYNCED_SESSION_HYDRATE_CHUNK_SIZE}-id chunks: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
