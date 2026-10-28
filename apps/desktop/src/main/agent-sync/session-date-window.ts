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
 *
 * ISS-10604 moved the VOCABULARY half — `SessionDateWindowField` and the two
 * per-surface field constants — into `shared/session-date-window-contract.ts`,
 * because the renderer now resolves the analytics field and sends it to main.
 * Import those from there; this module owns the SQL and hydrated-fold
 * resolvers that turn one of them into a predicate.
 */

import { SessionDateWindowField } from "../../shared/session-date-window-contract.js";
import { sessionStartedAtFloor } from "../database/session-timestamp-form.js";
import { parseNullableSessionDate } from "../session/session-instant.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

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
 * The NULL guard that belongs with {@link sessionDateWindowTsExpr}'s field.
 *
 * ISS-10604: the started-at expression routes a NULL/malformed value to EPOCH
 * rather than dropping it, which is right for the list's filter and wrong for an
 * all-time analytics window — there `startIso` IS epoch, so an inclusive bound
 * would silently admit every row whose start was never captured and report it as
 * a measured session. Every caller that swaps its column through the resolver
 * pairs it with this, so the two arms keep the same population they had before
 * the column became a parameter.
 *
 * THE TWO ARMS ARE DELIBERATELY ASYMMETRIC, and this is the part worth reading.
 * `last_activity_at` is `NOT NULL` (migration 0005) so the guard cannot drop a
 * row for nullness — but epoch is a SENTINEL on this column too ("not computed
 * yet"), and a session with no `started_at` and no events sits there. This arm
 * does NOT exclude it, and must not: `buildListCursorFilterClause` applies no
 * such guard either, so excluding it here would make the dashboard drop a row
 * the Sessions list counts and re-open the exact split ISS-10604's ruling
 * closed. On the started-at arm the same row is excluded because epoch there is
 * where an ABSENT value was routed, not where a computed one landed.
 *
 * COVERAGE, stated honestly: only the LAST-ACTIVITY arm is pinned, by
 * `local-insights-activity-window-alignment.test.ts`'s all-time case. That file
 * used to assert both arms; ISS-10541 retired the insights basis it needed to
 * reach the started-at one, so no test asserts that arm today. It stays
 * reachable through `getSharedAgentSessionAnalytics`, which still passes
 * `SESSIONS_ANALYTICS_DATE_WINDOW_FIELD` — so this is a live branch with no
 * assertion, not dead code. Do not read the paragraph above as tested.
 */
export function sessionDateWindowNotNullSql(
  field: SessionDateWindowField
): string {
  if (field === SessionDateWindowField.LastActivity) {
    return "s.last_activity_at IS NOT NULL";
  }
  return "s.started_at IS NOT NULL";
}

/**
 * The hydrated-row counterpart of {@link sessionDateWindowTsExpr}: the raw
 * timestamp string a `startDate`/`endDate` bound is compared against for the
 * given window field. The `?? startedAt` fallback mirrors the list's own sort
 * key (`session.lastActivityAt ?? session.startedAt`), so a row with no activity
 * timestamp is windowed at its start rather than silently dropped.
 *
 * It no longer mirrors a cloud counterpart: ISS-6463 made
 * `session_detail.last_activity_at` NOT NULL and deleted the cloud projection's
 * `?? record.sessionStartedAt`. Cloud now windows on the bare column. This
 * fallback stays because desktop hydrates rows whose timestamp can be absent.
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

/**
 * The EVENT-DERIVED activity instant for a hydrated session row: the latest
 * usable `events.created_at`, floored at the session start. Returned as stored
 * text, because it is the fallback {@link resolveSessionLastActivityAt} weighs
 * against the denormalized column.
 *
 * This is the JS half of the `MAX(started_at floor, MAX(events.created_at))`
 * the store writes into that column (`SESSION_LAST_ACTIVITY_AT_VALUE_SQL`), so
 * the BASE is weighed exactly as {@link sessionStartedAtFloor} weighs it there:
 * a `started_at` the date-prefix GLOB rejects is compared as EPOCH, and epoch
 * loses to any real event. One the GLOB KEEPS is compared as itself, parseable
 * or not — the SQL side's `MAX` over such a value is byte-wise, which this fold
 * does not reproduce and ISS-6795 does not change.
 *
 * Each timestamp is parsed exactly once — the running max is carried as an epoch
 * beside the text rather than re-parsed on every iteration.
 *
 * ISS-6795: the base used to be seeded with a raw `new Date(startedAt)`, so a
 * `started_at` the floor REJECTS (`not-a-date`) seeded NaN, which no `>` can
 * beat — every event was discarded and the row kept the malformed string as its
 * activity instant, while the column held the event max. The Status facet folds
 * the served instant (ISS-6795) and its SQL twin reads the column, so a row the
 * two answered differently about landed in NEITHER the Active nor the Stale
 * facet. Reading the floor's own value closes that; a row with no usable event
 * still returns its raw `started_at` exactly as before, and the hydrate path
 * floors it at epoch on read (`parseSessionDate`).
 */
export function deriveSessionLastActivityAt(
  startedAt: string | null,
  eventRows: readonly { created_at: string | null }[]
): string | null {
  const accumulator = createSessionLastActivityAccumulator(startedAt);
  for (const eventRow of eventRows) {
    accumulator.push(eventRow.created_at);
  }
  return accumulator.finish();
}

/**
 * The instant {@link deriveSessionLastActivityAt} compares its base against —
 * what `SESSION_STARTED_AT_FLOOR_SQL` puts on the SQL side of the same `MAX`.
 * `NaN` when the floor keeps a value that does not parse, which is that value
 * winning the comparison, as it does today.
 */
function flooredStartedAtEpoch(startedAt: string | null): number {
  const floored = sessionStartedAtFloor(startedAt);
  return floored === startedAt ? new Date(floored).getTime() : 0;
}

/** Incremental adapter for the canonical event-derived last-activity fold. */
export function createSessionLastActivityAccumulator(startedAt: string | null) {
  let lastActivityAt = startedAt;
  let lastActivityEpoch = flooredStartedAtEpoch(startedAt);
  return {
    push(createdAt: string | null): void {
      // An unusable reading is not a candidate. NaN cannot be a running max —
      // it beats nothing and nothing beats it — so one would otherwise discard
      // every event after it.
      const eventEpoch = parseNullableSessionDate(createdAt)?.getTime();
      if (eventEpoch !== undefined && eventEpoch > lastActivityEpoch) {
        lastActivityAt = createdAt;
        lastActivityEpoch = eventEpoch;
      }
    },
    finish(): string | null {
      return lastActivityAt;
    },
  };
}
