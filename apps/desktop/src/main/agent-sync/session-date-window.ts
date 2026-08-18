/**
 * @file session-date-window.ts
 * @description ISS-5443: the ONE definition of the desktop Sessions date
 * window — which timestamp a `startDate`/`endDate` range is measured against,
 * expressed once for SQLite and once for the hydrated JS fold.
 *
 * Before this module the desktop surface carried three hand-written windows:
 * the list clause in `sync-source.ts` bounded on `last_activity_at`, the
 * usage/KPI clause in `session-aggregate-filters.ts` bounded on `started_at`,
 * and the hydrated `matchesDateBounds` bounded on `startedAt`. For one date
 * range that is three cohorts on one screen, and the KPI under-counted the list
 * it sits above by exactly the sessions that STARTED before the window but were
 * ACTIVE inside it — the long-running agent sessions this corpus is made of.
 *
 * This mirrors the cloud fix (ISS-4429 / FEA-4298), where
 * `SESSIONS_SURFACE_DATE_FIELD` is threaded into one `buildWhere` so the table
 * and its summary cards cannot drift onto different columns. The desktop
 * analogue is the same: one field constant per read surface, one SQL expression
 * resolver, one JS value resolver.
 */

import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

/** Which session timestamp a `startDate`/`endDate` window is measured against. */
export const SessionDateWindowField = {
  /** Genuine activity — "active in this window". */
  LastActivity: "lastActivityAt",
  /** Session start — "started in this window". */
  Started: "startedAt",
} as const;
export type SessionDateWindowField =
  (typeof SessionDateWindowField)[keyof typeof SessionDateWindowField];

/**
 * The field the whole Sessions SURFACE windows on — the list AND the summary
 * cards (usage/KPI) above it AND the count-only badge read. For a given range
 * these are ONE cohort: the cards summarize exactly the population the table
 * lists, so they must bound on the same timestamp or the cards reconcile
 * against a different set than the table shows.
 *
 * `lastActivityAt` is the correct basis because it is the field the list is
 * ORDERED by (FEA-2180): bounding on start time while sorting by activity drops
 * recently-active sessions that started before the window even though they rank
 * at the top. The denormalized `sessions.last_activity_at` is
 * `COALESCE(MAX(events.created_at), <started_at floor>)`
 * (`recomputeSessionLastActivityAt`), so it already folds the started-at floor
 * in and never falls below the start — verified on a 3,154-session local
 * corpus, where zero rows have `last_activity_at < started_at`. That is why the
 * window can only ever ADD the started-before/active-inside rows, never drop a
 * row the started-at basis included.
 */
export const SESSIONS_SURFACE_DATE_WINDOW_FIELD =
  SessionDateWindowField.LastActivity;

/**
 * The analytics read's field. A session belongs to the period it STARTED in —
 * a deliberately different cohort from the list/summary "active in this window",
 * and the exact split cloud draws between `SESSIONS_SURFACE_DATE_FIELD` and
 * `SESSIONS_ANALYTICS_DATE_FIELD`. Named so the analytics window keeps its own
 * semantics while sharing this module's single predicate.
 */
export const SESSIONS_ANALYTICS_DATE_WINDOW_FIELD =
  SessionDateWindowField.Started;

/**
 * The epoch sentinel. Two distinct jobs, deliberately the same literal so they
 * can never drift: it is the value {@link SESSION_STARTED_AT_TS_EXPR} routes an
 * unparseable `started_at` to (mirroring `parseSessionDate`'s NaN fallback), and
 * it is the `NOT NULL` DEFAULT migration 0005 gave `sessions.last_activity_at` —
 * i.e. "this row's activity has not been computed yet", not a real instant.
 */
export const SESSION_EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * The `started_at` window expression. The app only ever persists
 * `toISOString()`, but a NULL/empty/malformed legacy value must route to epoch
 * (`1970-...`) so it sorts as the hydrate path treats it (`parseSessionDate`
 * returns `new Date(0)` for an unparseable value). A raw `::timestamptz` cast
 * would instead drop NULL rows from an `endDate` bound (parity drift — the
 * hydrate path keeps them at epoch, which is `<= endDate`) and, worse, THROW on
 * an empty or malformed legacy value, failing the whole usage query. The
 * date-prefix GLOB guard admits every real value and routes the rest to epoch.
 * Used by the `WHERE` filter clause only.
 */
export const SESSION_STARTED_AT_TS_EXPR = `(CASE WHEN s.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN s.started_at ELSE '${SESSION_EPOCH_TIMESTAMP}' END)`;

/**
 * The `last_activity_at` window expression. Deliberately the BARE column, not a
 * GLOB-guarded CASE like the started-at expression: the column is `NOT NULL`
 * with an epoch default (migration 0005) and is only ever written a
 * `toISOString()` value, so there is nothing for a guard to catch — while
 * wrapping it in a CASE would stop `idx_sessions_last_activity` from covering
 * the window on the Sessions list's hot paging read. A row still carrying the
 * epoch DEFAULT ("not computed yet") lands at epoch here AND on the hydrate
 * path, which reads the same column through
 * {@link resolveSessionLastActivityAt} — so the two agree even on that row.
 */
export const SESSION_LAST_ACTIVITY_AT_TS_EXPR = "s.last_activity_at";

/**
 * The SQLite expression a `startDate`/`endDate` bound compares against for the
 * given window field. Every desktop session date window — list, usage/KPI,
 * count badge, analytics — renders its bound from this one resolver, so the
 * surfaces cannot drift onto different columns. SQLite (libSQL) dialect; see
 * `src/main/database/AGENTS.md`.
 */
export function sessionDateWindowTsExpr(field: SessionDateWindowField): string {
  if (field === SessionDateWindowField.LastActivity) {
    return SESSION_LAST_ACTIVITY_AT_TS_EXPR;
  }
  return SESSION_STARTED_AT_TS_EXPR;
}

/**
 * The hydrated-row counterpart of {@link sessionDateWindowTsExpr}: the raw
 * timestamp string a `startDate`/`endDate` bound is compared against for the
 * given window field. The `?? startedAt` fallback mirrors the list's own sort
 * key (`session.lastActivityAt ?? session.startedAt`) and cloud's
 * `record.lastActivityAt ?? record.sessionStartedAt` projection, so a row that
 * predates the `last_activity_at` backfill is windowed at its start rather than
 * silently dropped.
 */
export function sessionDateWindowValue(
  session: Pick<SyncedAgentSession, "startedAt" | "lastActivityAt">,
  field: SessionDateWindowField
): string {
  if (field === SessionDateWindowField.LastActivity) {
    return session.lastActivityAt ?? session.startedAt;
  }
  return session.startedAt;
}

/**
 * The genuine-activity instant to project for a hydrated session row, given the
 * stored `sessions.last_activity_at` column and the value derived from whatever
 * event rows this load fetched.
 *
 * ISS-5443: the STORED column wins, unconditionally, whenever it is present and
 * parseable — INCLUDING when it still holds the {@link SESSION_EPOCH_TIMESTAMP}
 * default. It is maintained inside the ingest transaction as exactly the derived
 * formula, and it is the value the Sessions list sorts by and every Sessions
 * date window bounds on, so reading it is what makes the hydrated fold and the
 * SQL paths answer with the same timestamp instead of holding two independent
 * opinions.
 *
 * Preferring the derivation over an epoch default was considered and rejected.
 * It would read "better" for a row the migration-0005 backfill has not reached
 * — but the SQL side windows and SORTS on the bare column, so that row is
 * already at epoch everywhere else, and giving the fold a different answer would
 * reintroduce exactly the SQL-vs-fold disagreement this module exists to remove.
 * Teaching the SQL side the same fallback would need a `CASE` around
 * {@link SESSION_LAST_ACTIVITY_AT_TS_EXPR}, costing the list's hot paging read
 * its `idx_sessions_last_activity` coverage — a separate call, not a free one.
 *
 * The derivation remains the fallback for a load that did not project the column
 * at all, and for an unparseable value.
 */
export function resolveSessionLastActivityAt(
  storedLastActivityAt: string | null | undefined,
  derivedLastActivityAt: string | null
): string | null {
  if (
    !(storedLastActivityAt && Number.isFinite(Date.parse(storedLastActivityAt)))
  ) {
    return derivedLastActivityAt;
  }
  return storedLastActivityAt;
}
