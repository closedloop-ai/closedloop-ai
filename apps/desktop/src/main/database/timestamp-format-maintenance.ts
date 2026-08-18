/**
 * @file timestamp-format-maintenance.ts
 * @description FEA-3743 post-backfill heal that rewrites session/usage/span and
 * artifact-link timestamp columns stored in a non-canonical text form
 * (timezone-offset forms like `2026-06-18T10:00:00+02:00`) into the canonical
 * ISO-8601 UTC 'Z' form the write path now produces (`2026-06-18T08:00:00.000Z`,
 * the same instant).
 *
 * WHY a dedicated boot heal and NOT a DATA_REVISION bump: the data-revision
 * rebuild re-derives a session ONLY from its surviving SOURCE TRANSCRIPT
 * (data-revision-rebuild.ts), and it reaches neither offending set. The FEA-3743
 * rows come from the live Codex OTel HTTP endpoint (codex-otel-writer.ts) and
 * have no source transcript on disk at all. The ISS-5427 rows mostly do have
 * one — and now that the resolver canonicalizes, a rebuild WOULD re-derive them
 * correctly — but a rebuild is skipped entirely for a session whose transcript
 * has since been deleted, and `artifacts.first_pushed_at` is set-once so it
 * survives the teardown a rebuild performs. This heal is source-independent: it
 * rewrites the stored text in place.
 *
 * Like pr-link-maintenance.ts it issues `prisma.write` callbacks, so it MUST run
 * inside the FEA-2038 db host (a write fn can't be structured-cloned across the
 * db-host method proxy). It is exposed to the main process as the clone-safe
 * `agentDatabase.normalizeStoredTimestampFormats()` method (see sqlite.ts).
 */

import { toCanonicalIso, validIso } from "./db-helpers.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  HEALABLE_TIMESTAMP_DATE_ONLY_GLOB_SQL,
  HEALABLE_TIMESTAMP_T_FORM_GLOB_SQL,
} from "./session-timestamp-form.js";

/**
 * A (table, column) pair holding a lexically-compared timestamp string that the
 * write path now canonicalizes. Each is healed independently.
 */
type TimestampColumn = {
  table: string;
  column: string;
  /**
   * ISS-5427: the column on `table` holding the owning `sessions.id`, set only
   * for a SYNCED CHILD projection. Sync selection is driven by
   * `sessions.updated_at` (the FEA-1962 cursor in sync-source.ts), and a child
   * row rewritten in place leaves that cursor untouched — so without this the
   * corrected text would stay local forever while the cloud kept the old form.
   * When present, the owning sessions are bumped so the scan re-selects them.
   * Omitted for a purely local column, whose heal has no wire consequence.
   */
  syncOwnerSessionIdColumn?: string;
  /**
   * ISS-5427: heal this column row-by-row on SQLite's implicit `rowid` instead
   * of by its old TEXT value (the default). Set it whenever the column's values
   * are near-unique per row: the value-keyed path issues one UPDATE per DISTINCT
   * value, and with no index on the column each of those is a full table scan,
   * so a store whose whole column is non-canonical would sweep in O(rows²) and
   * hang boot. `rowid` is the table's own B-tree key, so keying on it makes
   * every rewrite a point update. Leave it unset for a low-cardinality column,
   * where one statement per distinct value is strictly fewer writes.
   *
   * ISS-5491: an INDEX on the column is not a reason to leave it unset. The
   * index only removes the SCAN half of that cost — each value-keyed UPDATE is
   * still its own `prisma.write`, i.e. its own entry on the serialized write
   * queue plus a throttled WAL checkpoint, and this heal is AWAITED on the boot
   * path ahead of the stale-session and retention sweeps. For a near-unique
   * column the DISTINCT count tracks the ROW count, so that is one
   * boot-blocking queue entry — and one checkpoint turn — per row with or
   * without the index, whereas the row-keyed path amortizes a whole page into
   * one. Near-uniqueness is the whole test, and an index does not answer it.
   *
   * What an index DOES buy, and what rekeying gives up (review): on an INDEXED
   * column the value-keyed DISCOVERY query is a covering-index scan, while the
   * row-keyed pager reads the TABLE (`EXPLAIN QUERY PLAN` on the real DDL:
   * `SCAN … USING COVERING INDEX idx_codex_trace_span_start_time` becomes
   * `SEARCH … USING INTEGER PRIMARY KEY (rowid>?)`). So `start_time` pays a
   * full row walk — wide rows, `attributes`/`resource_attributes` JSON and all
   * — on every boot, including a fully converged one where nothing is
   * rewritten. That cost is real but BOUNDED: one sequential pass, no writes,
   * no queue entries. The cost it replaces is not bounded — it grows with the
   * row count and lands on the serialized write queue. Trading an unbounded
   * write-side cost for a bounded read-side one is the whole point, so the
   * indexed column is rekeyed too; do not read this as "the index is
   * irrelevant".
   *
   * PRECONDITION: `table` must be an ordinary rowid table. No `WITHOUT ROWID`
   * table exists in the desktop schema and Prisma's SQLite generator never
   * emits one, so this holds for every entry below.
   */
  healByRowId?: boolean;
};

// Only the columns a divergent writer could have populated with an offset form.
// The OTel writer (the known FEA-3743 offender) writes exactly these:
//   sessions.started_at / sessions.last_activity_at  (minimalCodexSessionUpsert)
//   token_usage.created_at                            (tokenUsageUpsert)
//   codex_trace_span.start_time / .end_time           (codexTraceSpanUpsert)
//
// ISS-5427 added the artifact-observation set. ISS-5236 changed
// `session_artifact_links.observed_at` from the import wall clock (canonical by
// construction) to the harness-supplied instant, and the resolver only
// VALIDATED it — so an offset-form `session.startedAt` / `tu.timestamp` landed
// in a TEXT column that `artifact-link-persistence`'s set-once
// `MIN(COALESCE(first_pushed_at, $2), $2)` and the `ORDER BY sal.observed_at`
// reads in `branch-reads` / `component-invocations` all compare LEXICALLY.
// `persistNormalizedPullRequests` (write-core-pull-requests.ts) derived the same
// un-canonicalized instant for `artifacts.observed_at` and
// `pull_requests.observed_at`, which `local-insights`'s
// `COALESCE(observed_at, created_at) BETWEEN` window scans and branch-reads'
// `ORDER BY pr.observed_at DESC` newest-PR pick likewise compare lexically.
// A fourth consumer reads `sal.observed_at` as the LAST fallback of
// `COALESCE(s.ended_at, s.started_at, sal.observed_at)` — projected as a
// branch's `activityAt` (branch-reads.ts) and used as the Insights branch-donut
// window predicate, `MAX(COALESCE(...)) BETWEEN` (local-insights.ts). That MAX
// is a cross-ROW aggregate over TEXT, so it too is byte-wise.
// Every one of those writers now canonicalizes at the point of derivation; these
// entries heal the rows written in between.
//
// `artifacts.first_pushed_at` is here because it is set-once and so survives the
// reparse cycle on its own. Re-spelling it does NOT by itself rewind a slot the
// lexical MIN already mis-awarded — but it is what lets the next re-derivation
// fix it: a mis-awarded winner is always LATER than the true earliest push (the
// value whose digits sorted lowest is the one whose offset hid a later instant),
// and `MIN(COALESCE(first_pushed_at, $2), $2)` only ever moves the slot EARLIER,
// so once both operands are canonical the correct push time wins. Left
// non-canonical, every later MIN would keep comparing mixed formats instead.
//
// KNOWN GAP — one consumer reads a healed column NEXT TO a session column this
// set does not durably canonicalize, so it still compares mixed formats after
// this heal runs: `COALESCE(s.ended_at, s.started_at, sal.observed_at)`, which
// `mapBranchLinkRows` (branch-reads.ts) projects as the branch `activityAt` and
// which the Insights branch-PR donut applies as
// `MAX(COALESCE(...)) BETWEEN` (local-insights.ts). The two session columns fail
// differently, and the distinction matters because only one of them is fixable
// by this heal:
//   - `sessions.ended_at` is NOT in this set at all, so a non-canonical spelling
//     there is never repaired.
//   - `sessions.started_at` IS in this set, and the heal is NOT undone by a
//     re-import — write-core.ts supplies a harness value only on its new-row
//     INSERT (the `sessions` row is provably absent on that path; the UPDATE arms
//     never assign `started_at`), and codex-otel-writer.ts's upsert fills it via
//     `COALESCE(sessions.started_at, EXCLUDED.started_at)`, i.e. set-once. What
//     the heal cannot promise for it is CURRENCY: a session FIRST imported after
//     this pass carries the harness spelling until the next boot.
// So the boot precondition stated at the call site (sqlite.ts) is a
// point-in-boot property — true of the rows present when it ran, which is what
// the rest of that boot's maintenance chain needs — rather than a durable
// invariant about the column.
//
// Both are pre-existing FEA-3743 scope, not something ISS-5427 introduced, and
// both are why a reader relating an artifact timestamp to a `sessions` one must
// not assume they share a format. ISS-5427 fixed `computeDelivery`'s
// delivery-latency gate (local-insights-delivery.ts) that way, with
// `unixepoch()` on both operands. Closing the rest needs either
// canonicalization at the write-core import site or the same instant-based
// rewrite of the expression above; both are deliberately left as follow-up,
// with burn-down riding on ISS-5358.
//
// All four carry a per-event instant, so their values are near-unique per row
// and they are healed `healByRowId`, not by DISTINCT value (see the type).
//
// ISS-5491: the three OTel per-event columns below are near-unique in exactly
// the same way and were nonetheless still on the value-keyed path, so a store
// with a large legacy Codex OTel history paid one UPDATE — one full table scan
// on the two unindexed ones (`token_usage.created_at`, and
// `codex_trace_span.end_time`, which `idx_codex_trace_span_start_time` does not
// cover), and one boot-blocking write-queue entry on all three — per DISTINCT
// value, with the distinct count tracking the row count. `end_time` is the
// worst case: span end times are essentially unique per row. Rekeying them on
// `rowid` replaces that with one keyset page scan and one queue entry per page.
//
// None of the three takes a `syncOwnerSessionIdColumn`, and none needs one:
// the timestamp itself never crosses the sync contract. `selectTokenUsageRows`
// (sync-source.ts) does SELECT `token_usage.created_at`, but only to feed
// `resolveTokenUsageCostUsd`'s `observedAt` pricing pick — the wire row
// (`SyncedAgentSessionTokenUsage`) carries no timestamp field at all, and the
// cloud schema has no column for it. `codex_trace_span` is not synced. So there
// is no "corrected text stays local while the cloud keeps the old form" gap
// here of the kind ISS-5427 closed for links, and a bump would re-sync every
// session owning a legacy usage row for no wire-visible change.
//
// The two `sessions` columns are near-unique per row too and STAY value-keyed,
// which is a scope line rather than a counter-example to the rule on the type.
// Two reasons, and only the second is a real constraint. First, their
// cardinality is bounded by the SESSION count, not the per-event row count that
// makes the OTel columns pathological — a corpus with millions of spans still
// has thousands of sessions, which is why the ticket scoped them out. Second,
// and the actual blocker: healing a `sessions` column must ALSO bump
// `updated_at` past the FEA-1962 sync watermark and RETURN the healed ids the
// caller re-derives `session_analytics` from, neither of which
// `healColumnByRowId` does for the table's OWN rows (its
// `syncOwnerSessionIdColumn` bump is for a CHILD projection and collects no
// ids). Moving them needs that arm taught to the row-keyed path, and doing it
// here would put the sync watermark and the derived-analytics re-derivation in
// a change whose point is boot latency.
const HEALED_COLUMNS: readonly TimestampColumn[] = [
  { table: "sessions", column: "started_at" },
  { table: "sessions", column: "last_activity_at" },
  { table: "token_usage", column: "created_at", healByRowId: true },
  { table: "codex_trace_span", column: "start_time", healByRowId: true },
  { table: "codex_trace_span", column: "end_time", healByRowId: true },
  {
    table: "session_artifact_links",
    column: "observed_at",
    syncOwnerSessionIdColumn: "session_id",
    healByRowId: true,
  },
  // The remaining three are LOCAL-only, so none needs an owner bump:
  //   - `artifacts.first_pushed_at` never reaches the wire (the cloud derives its
  //     own `firstPushedAt` from `artifactRef.observedAt`);
  //   - `artifacts.observed_at` rides only as `resolveLinkObservedAt`'s fallback
  //     behind `sal.observed_at`, which is TEXT NOT NULL and so always wins;
  //   - sync-source emits `merged_at`/`closed_at`/`is_draft` from
  //     `pull_requests`, never its `observed_at`.
  { table: "artifacts", column: "first_pushed_at", healByRowId: true },
  { table: "artifacts", column: "observed_at", healByRowId: true },
  { table: "pull_requests", column: "observed_at", healByRowId: true },
] as const;

// A canonical value is the FIXED-WIDTH `YYYY-MM-DDTHH:mm:ss.sssZ`. Anything else
// this heal can re-express as the SAME instant — an offset form (`...+02:00` /
// `...-05:00`), a bare no-zone form, a lower-precision 'Z' form
// (`...T10:00:00Z`), or a date-only `2026-06-22` — is a heal candidate. The
// first GLOB pair pins those shapes so free-text or NULL columns are skipped;
// the last clause excludes already-canonical rows so the sweep is a no-op once
// everything is normalized.
//
// ISS-5330: that second clause used to be `NOT LIKE '%Z'`, which treated ANY
// 'Z'-suffixed value as canonical and so left mixed precision in the store. That
// is not a cosmetic gap — `2026-06-22T10:00:00Z` and `2026-06-22T10:00:00.500Z`
// are both TEXT, and the whole-second form sorts LATER byte-wise (`Z` 0x5A after
// `.` 0x2E) while being the EARLIER instant, so SQLite's scalar `max()` returns
// the wrong operand. Pinning the exhaustive canonical glob is what makes
// `CANONICAL_UTC_TIMESTAMP_GLOB_SQL`'s tightening convergent instead of
// stranding those rows outside every canonical-only guard.
//
// ISS-5429: the DATE-ONLY alternative is new. `SESSION_STARTED_AT_FLOOR_SQL`
// admits a bare `YYYY-MM-DD` prefix, so a date-only value could be written into
// `last_activity_at`, match the `T`-only discovery glob nowhere, and leave the
// stale sweep's canonical-only guard holding that session back FOREVER:
// permanently `active`, and never terminal so never retention-eligible either.
// (ISS-5497 closed the OTHER producer of that shape: the recompute's fold over
// `events.created_at` now emits canonical text rather than the raw event value.)
//
// The widening is deliberately the EXACT 10-character date and not the floor's
// open `YYYY-MM-DD*`, which would also admit the SQLite space form
// `2026-06-22 10:00:00`. `toCanonicalIso` is `Date.parse`, which reads a
// date-only value as UTC midnight (per spec) but the space form as LOCAL time —
// so admitting the latter would rewrite it to a DIFFERENT instant, shifted by
// the operator's offset, and bump `updated_at` so the shift syncs. Holding a
// space-form value back is wrong; silently moving it is worse.
//
// ISS-5496: the zone-less `T` form (`2026-06-22T10:00:00`) has the SAME
// `Date.parse` semantics as that excluded space form — per ECMA-262 only a
// date-ONLY string is read as UTC; a date-TIME string with no offset is LOCAL —
// yet the `T` alternative above admits it. Routing it through bare
// `Date.parse` therefore rewrote it to a different instant (in
// `TZ=America/Chicago`, `2026-06-22T15:00:00.000Z`) and, for a `sessions`
// column, bumped `updated_at` so the shifted value synced to the cloud.
// The repair is in `canonicalizeStoredTimestamp` (bottom of file) rather than
// in this predicate, and that placement is the whole point: TIGHTENING the glob
// to demand an explicit zone would have stranded three shapes that heal
// correctly today — a lowercase `...T10:00:00z` (SQLite GLOB is
// case-SENSITIVE), a `±HHMM` offset, and the zone-less form itself, whose
// hold-back is the permanent non-convergence the ISS-5429 note above describes.
// Canonicalizing instead keeps discovery exactly as wide as it was.
//
// One consequence to know about: the `sessions` columns take the VALUE-keyed
// path (`healColumnByValue` — they carry no `healByRowId`), which keys its
// UPDATE on the old VALUE, so a date-only candidate is a coarser equivalence
// class than a full timestamp — every session whose last activity was that DAY
// is rewritten by one statement and lands on one `updated_at`. That is bounded
// by a single day's sessions rather than the O(corpus) fold
// `bumpSessionsUpdatedAt`'s CURSOR-GROUP BOUND note rejects, so it is left
// as-is. Every other healed column is unaffected: the ISS-5427
// artifact-observation set and the ISS-5491 OTel per-event set are all
// `healByRowId`, so each row is rewritten on its own `rowid`.
// ISS-5497: the two shapes moved to session-timestamp-form.js, beside the
// canonical glob they are already checked against. `recomputeSessionLastActivityAt`
// canonicalizes `last_activity_at` from the SAME pair, so a shape one rewrites
// and the other does not would ping-pong between them on every boot.
const NON_CANONICAL_TIMESTAMP_PREDICATE = (column: string): string =>
  `${column} IS NOT NULL
   AND (${column} GLOB ${HEALABLE_TIMESTAMP_T_FORM_GLOB_SQL}
        OR ${column} GLOB ${HEALABLE_TIMESTAMP_DATE_ONLY_GLOB_SQL})
   AND ${column} NOT GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}`;

// ISS-5427: how many rows one `healByRowId` page reads before rewriting them.
// Small enough that a fully non-canonical column never hydrates the corpus into
// the db-host process, large enough that the paging query is not the cost.
//
// Exported for ISS-5491's paging test, which seeds `+ 1` rows to prove the
// sweep actually crosses a page boundary. Deriving that fixture size from the
// constant is what stops the test from silently stopping short of the boundary
// if this value is ever raised.
export const ROW_HEAL_PAGE_SIZE = 500;

/**
 * Result of a heal pass: the total number of values rewritten (so the caller can
 * nudge the renderer only when something actually changed) plus the DISTINCT set
 * of `sessions.id` whose `started_at`/`last_activity_at` were rewritten. The
 * caller uses that id set to re-derive the sync-emitted `session_analytics`
 * copies of these timestamps (the analytics backfill only anti-joins MISSING
 * rows, so it would leave an already-derived offset-form copy stale).
 */
export type TimestampFormatHealResult = {
  rewritten: number;
  /** DISTINCT `sessions.id` whose session-timestamp columns were rewritten. */
  healedSessionIds: string[];
};

// The `sessions` columns this heal rewrites. Healing these must ALSO bump
// `sessions.updated_at` (so the FEA-1962 `updated_at >= watermark` sync scan
// re-selects an already-synced terminal session whose cloud copy still holds the
// old offset form) and re-derive the `session_analytics` copy — see the caller.
const HEALED_SESSION_COLUMNS: ReadonlySet<string> = new Set([
  "started_at",
  "last_activity_at",
]);

/**
 * FEA-3743: heal any offset-form (or other non-'Z') timestamp text in the
 * columns listed in `HEALED_COLUMNS` into the canonical UTC 'Z' form.
 * Idempotent — the non-canonical predicate makes an all-normalized store a pure
 * no-op — and best-effort per row/column so one unparseable value can never
 * abort the sweep. Returns the total number of values rewritten and the healed
 * `sessions.id` set (see `TimestampFormatHealResult`) so the caller can nudge
 * the renderer and propagate the change into the sync watermark + derived
 * analytics.
 *
 * `now` stamps `sessions.updated_at` so the sync scan re-selects a corrected
 * session; it is only read when a session column, or a synced child projection
 * of one (ISS-5427), is actually rewritten.
 */
export async function normalizeStoredTimestampFormats(
  prisma: DesktopPrisma,
  log: (msg: string) => void,
  now: () => string
): Promise<TimestampFormatHealResult> {
  let rewritten = 0;
  const healedSessionIds = new Set<string>();
  for (const target of HEALED_COLUMNS) {
    try {
      rewritten += await healColumn(prisma, target, now, healedSessionIds);
    } catch (e) {
      log(
        `timestamp-format heal: ${target.table}.${target.column} failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  if (rewritten > 0) {
    log(
      `timestamp-format heal: normalized ${rewritten} non-canonical timestamp value(s) to UTC 'Z' form`
    );
  }
  return { rewritten, healedSessionIds: [...healedSessionIds] };
}

function healColumn(
  prisma: DesktopPrisma,
  target: TimestampColumn,
  now: () => string,
  // For `sessions` columns, the DISTINCT ids rewritten are collected here so the
  // caller can re-derive the sync-emitted `session_analytics` copies.
  healedSessionIds: Set<string>
): Promise<number> {
  return target.healByRowId
    ? healColumnByRowId(prisma, target, now)
    : healColumnByValue(prisma, target, now, healedSessionIds);
}

async function healColumnByValue(
  prisma: DesktopPrisma,
  target: TimestampColumn,
  now: () => string,
  healedSessionIds: Set<string>
): Promise<number> {
  const { table, column } = target;
  // Read the non-canonical rows, canonicalize in JS (SQLite cannot re-express an
  // offset instant as UTC in pure SQL), and write each back by its OLD value.
  // Keying on the old text collapses every row sharing a value into ONE
  // statement, which is why this path is reserved for a low-cardinality column;
  // the WHERE pins the exact old value so a concurrent row that already changed
  // is skipped.
  //
  // ISS-5491 left only the two `sessions` columns here, so the non-session arm
  // below is currently unexercised. It stays because it is this helper's
  // contract rather than dead weight: `isSessionColumn` is what keeps the
  // `updated_at` bump and the `RETURNING id` collection — both of which only
  // typecheck against `sessions` — from being applied to a future
  // low-cardinality column on another table.
  const rows = await prisma.client.$queryRawUnsafe<{ value: string }[]>(
    `SELECT DISTINCT ${column} AS value FROM ${table}
     WHERE ${NON_CANONICAL_TIMESTAMP_PREDICATE(column)}`
  );
  // A `sessions.started_at`/`last_activity_at` rewrite must ALSO advance
  // `sessions.updated_at` past the durable sync watermark so an already-synced
  // terminal session (which sits below the watermark) is re-selected and the
  // corrected instant reaches the cloud — mirroring session-maintenance.ts's
  // floor heal / orphan sweep, which likewise bump `updated_at` on a corrective
  // write. The bump also RETURNs the affected ids so the caller can re-derive
  // the persisted `session_analytics` copy.
  const isSessionColumn =
    table === "sessions" && HEALED_SESSION_COLUMNS.has(column);
  let count = 0;
  for (const { value } of rows) {
    const canonical = canonicalizeStoredTimestamp(value);
    if (canonical === value) {
      // Unparseable (the canonicalizer returns the input): leave it untouched
      // rather than churn it. It was never a valid instant to begin with.
      continue;
    }
    if (isSessionColumn) {
      const updatedRows = await prisma.write((client) =>
        client.$queryRawUnsafe<{ id: string }[]>(
          `UPDATE ${table} SET ${column} = $1, updated_at = $2
             WHERE ${column} = $3
             RETURNING id`,
          canonical,
          now(),
          value
        )
      );
      for (const { id } of updatedRows) {
        healedSessionIds.add(id);
      }
      count += updatedRows.length;
    } else {
      count += await prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
          canonical,
          value
        )
      );
    }
  }
  return count;
}

/** One row a `healByRowId` page will actually rewrite. */
type PendingRowRewrite = {
  rowId: number;
  canonical: string;
};

/**
 * ISS-5427: the row-keyed heal (see `TimestampColumn.healByRowId`). Pages
 * through the non-canonical rows on a `rowid` keyset cursor and rewrites each by
 * `rowid`, so the sweep costs one point update per affected row instead of one
 * unindexed full-table scan per distinct value, and nothing beyond a single
 * bounded page is materialized in JS (the FEA-2038 invariant). The cursor —
 * rather than re-querying a bare `LIMIT` page — is also what keeps an
 * unparseable value, which is deliberately left as-is, from being re-selected
 * forever.
 *
 * A whole page's updates ride ONE `prisma.write`. This heal is awaited inside
 * `openSqliteAgentDatabase` before DB IPC is available, and each `prisma.write`
 * is a write-queue round trip plus a throttled WAL checkpoint — one per row
 * would put a fully non-canonical column's entire row count on the boot path.
 */
async function healColumnByRowId(
  prisma: DesktopPrisma,
  target: TimestampColumn,
  now: () => string
): Promise<number> {
  const { table, column, syncOwnerSessionIdColumn } = target;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const rows = await prisma.client.$queryRawUnsafe<
      { rid: number | bigint; value: string }[]
    >(
      `SELECT rowid AS rid, ${column} AS value FROM ${table}
       WHERE rowid > $1 AND ${NON_CANONICAL_TIMESTAMP_PREDICATE(column)}
       ORDER BY rowid LIMIT ${ROW_HEAL_PAGE_SIZE}`,
      cursor
    );
    if (rows.length === 0) {
      return count;
    }
    const pending: PendingRowRewrite[] = [];
    for (const { rid, value } of rows) {
      const rowId = Number(rid);
      cursor = rowId;
      const canonical = canonicalizeStoredTimestamp(value);
      // An unparseable value (the canonicalizer returns the input) is left
      // untouched rather than churned — it was never an instant to begin with.
      if (canonical !== value) {
        pending.push({ rowId, canonical });
      }
    }
    if (pending.length === 0) {
      continue;
    }
    // Re-queue the owning sessions BEFORE the rewrite, and ONLY for the rows
    // this page actually rewrites. Selecting on the non-canonical predicate
    // instead would also catch the unparseable rows skipped above, and since
    // those never become canonical their sessions would be re-synced on every
    // boot forever. Bumping first also fails safe: a bump whose rewrite then
    // throws costs one redundant re-sync, whereas the reverse order would
    // strand the correction below the sync cursor.
    if (syncOwnerSessionIdColumn) {
      await requeueOwningSessionsForSync(
        prisma,
        { ...target, syncOwnerSessionIdColumn },
        pending,
        now()
      );
    }
    count += await rewritePage(prisma, table, column, pending);
  }
}

/** Apply one page's rewrites in a single write-queue entry. */
function rewritePage(
  prisma: DesktopPrisma,
  table: string,
  column: string,
  pending: readonly PendingRowRewrite[]
): Promise<number> {
  return prisma.write(async (client) => {
    let written = 0;
    for (const { rowId, canonical } of pending) {
      written += await client.$executeRawUnsafe(
        `UPDATE ${table} SET ${column} = $1 WHERE rowid = $2`,
        canonical,
        rowId
      );
    }
    return written;
  });
}

/**
 * ISS-5427: advance `sessions.updated_at` for every session owning one of
 * `pending`'s rows, so the FEA-1962 `updated_at` sync cursor re-selects an
 * already-synced session and carries the canonicalized child value to the cloud.
 * Mirrors the `sessions`-column bump in `healColumnByValue` (and
 * session-maintenance.ts's floor heal / orphan sweep), which advance
 * `updated_at` on a corrective write for the same reason.
 *
 * One statement, and `pending` is a single bounded page, so the parameter list
 * is capped at `ROW_HEAL_PAGE_SIZE + 1` and needs no chunking.
 *
 * Advancing `updated_at` also lifts the row above the boot orphan sweep's
 * `status = 'active' AND updated_at < cutoff` predicate, so an abandoned active
 * session whose link was healed is swept one boot later than it would have been.
 * That is the same trade-off the `sessions`-column bump above already makes, and
 * the alternative — not bumping — permanently strands the correction in the
 * cloud. The heal is convergent, so it costs at most one extra boot, once.
 *
 * The SECOND cost of the same bump, and the one a user can actually see:
 * `updated_at` is the sync watermark, NOT activity time (the ISS-5086 note on
 * write-core.ts's import INSERT), yet it is also the Sessions list's DEFAULT
 * cursor order — `ORDER BY updated_at DESC, id DESC` in sync-source.ts, which
 * `sortSyncedSessions` preserves whenever `sortBy` is unset
 * (session-working-set-sort.ts). So on the FIRST boot after this ships, every
 * session that owned an offset-form link is bumped to `now` and sorts above
 * genuinely more recent ones; the list leads with "whatever needed healing"
 * rather than "whatever happened last". On a corpus larger than
 * MAX_WORKING_SET_SESSIONS that same order also decides WHICH sessions the
 * usage cards aggregate over (shared-agent-sessions-api.ts's FEA-4286 cap), so
 * the totals shift for that one boot too.
 *
 * Accepted rather than worked around, on the same reasoning as the sweep
 * trade-off above: it is one-time and convergent (the predicate that selects
 * these rows stops matching once they are canonical, so the second boot bumps
 * nothing), and the alternative — a silent side-channel that advances the sync
 * cursor without touching `updated_at` — would mean inventing a second
 * watermark. Bounded reordering for one boot is the cheaper of the two.
 */
async function requeueOwningSessionsForSync(
  prisma: DesktopPrisma,
  target: TimestampColumn & { syncOwnerSessionIdColumn: string },
  pending: readonly PendingRowRewrite[],
  now: string
): Promise<void> {
  const placeholders = pending.map((_, i) => `$${i + 2}`).join(",");
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE sessions SET updated_at = $1
         WHERE id IN (
           SELECT ${target.syncOwnerSessionIdColumn} FROM ${target.table}
           WHERE rowid IN (${placeholders})
         )`,
      now,
      ...pending.map((p) => p.rowId)
    )
  );
}

// ISS-5496: a date-TIME with no zone designator at all — `2026-06-22T10:00:00`,
// `2026-06-22T10:00`, `2026-06-22T10:00:00.5`. The character class is positive
// (digits, `:`, `.`) rather than a negated "no Z and no sign", so a trailing
// `Z`/`z` or a `+HH:MM`/`-HHMM` offset falls out on its own and no unlisted
// suffix can be mistaken for a zone-less tail.
const ZONE_LESS_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/;

/**
 * ISS-5496: {@link toCanonicalIso} for a value read back OUT of the store.
 *
 * The difference from calling `toCanonicalIso` directly is the zone-less
 * date-time. `toCanonicalIso` is `Date.parse`, which per ECMA-262 reads a
 * date-time string carrying no offset as LOCAL — so healing
 * `2026-06-22T10:00:00` through it produced a DIFFERENT instant, shifted by
 * whatever offset the operator happened to be in, and (for a `sessions` column)
 * bumped `updated_at` so the shifted value synced to the cloud. That breaks
 * this module's contract that it only ever re-expresses the same instant, and
 * it made the healed text depend on the machine that ran the heal: two desktops
 * in different zones stored different text for the same row.
 *
 * Reading such a value as UTC is what the rest of the store already does with
 * it — SQLite's `unixepoch()` over the same text (local-insights.ts) reads a
 * zone-less date-time as UTC, and every lexical comparison over these TEXT
 * columns treats the digits at face value. So UTC is not a new interpretation
 * invented here; it is the one the readers around this column already hold, and
 * pinning it makes the heal's output deterministic and zone-independent while
 * leaving the stored digits alone.
 *
 * Stated plainly, because "preserves the instant" is true only relative to a
 * reading: a zone-less row DOES land on a different absolute instant than it
 * used to. `sessions.started_at = '2026-06-22T10:00:00'` healed to
 * `15:00:00.000Z` on a Chicago box (rendering as 10:00 local) and now heals to
 * `10:00:00.000Z` (rendering as 05:00), and the `updated_at` bump syncs that to
 * the cloud. That is the point rather than a side effect — the old value was
 * the operator's offset baked in, so the same row healed to a DIFFERENT instant
 * on every machine, and every other reader of the column was already treating
 * the digits as UTC. The new instant is the one the store already believed.
 *
 * Only the ZONE is supplied. A value the probe still cannot parse is returned
 * as the ORIGINAL stored text — never the 'Z'-suffixed probe string — so an
 * unparseable row is skipped by the callers' `canonical === value` guard exactly
 * as before rather than being churned into a new spelling of junk.
 *
 * Parseability is tested with {@link validIso} rather than by comparing
 * `toCanonicalIso`'s output against the probe (review). Those two are NOT the
 * same question for the one shape whose canonical form differs from the stored
 * text by exactly the 'Z': a zone-less value already carrying three
 * milliseconds digits (`2026-06-22T10:00:00.123`) canonicalizes to precisely
 * `value + "Z"`, so an identity test would read a perfectly good heal as a parse
 * failure, hand back the original, and let the callers' skip guard strand that
 * whole family permanently — the exact non-convergence ISS-5429 removed.
 */
function canonicalizeStoredTimestamp(value: string): string {
  const readable = ZONE_LESS_DATE_TIME_RE.test(value) ? `${value}Z` : value;
  return validIso(readable) === null ? value : toCanonicalIso(readable);
}
