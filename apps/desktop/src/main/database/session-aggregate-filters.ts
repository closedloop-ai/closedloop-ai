import {
  DISPLAYED_SESSION_STATUS,
  RECOGNIZED_SESSION_STATUS_VALUES,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import {
  type AgentSessionCountFilters,
  type AgentSessionUsageAggregateFilters,
  type SessionListCursorPageRequest,
  SessionListCursorSortKey,
} from "../agent-sync/agent-session-read-model.js";
import {
  SESSION_LAST_ACTIVITY_AT_TS_EXPR,
  SESSIONS_SURFACE_DATE_WINDOW_FIELD,
  sessionDateWindowTsExpr,
} from "../agent-sync/session-date-window.js";
import { isDisplayedStatusParityEnabled } from "../session/displayed-status-parity-gate.js";
import {
  canonicalSharedStatus,
  TERMINAL_SHARED_STATUSES,
} from "../session/session-status-filter-match.js";
import { HIGH_CONFIDENCE_BRANCH_METHOD_VALUES } from "./db-constants.js";
import { escapeSqliteLikePattern } from "./db-helpers.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { countSqliteSessions } from "./session-count.js";

// FEA-2038 / FEA-4142: the metadata-only session aggregates — usage/analytics
// and the count-only badge read — share these SQLite `WHERE`-clause builders.
// Extracted from sync-source.ts (a grandfathered over-ceiling file) to keep it
// shrinking; the SQL is SQLite (libSQL) dialect — see
// src/main/database/AGENTS.md.
//
// ISS-5443: the Sessions LIST clause (`buildListCursorFilterClause`) now lives
// here too, beside the usage/count clause it must agree with — it used to sit in
// `sync-source.ts`, a file away, which is how the two came to bound their date
// window on different columns (the list on `last_activity_at`, the usage/KPI
// aggregate on `started_at`) and the KPI came to under-count the very list it
// summarizes. Neither builder writes that basis any more: which timestamp a
// `startDate`/`endDate` bound is measured against is decided once, per read
// surface, in `../agent-sync/session-date-window.ts` and rendered by
// `sessionDateWindowTsExpr` — the same resolver the hydrated `matchesDateBounds`
// fold reads through `sessionDateWindowValue`.

export function buildUsageFilterClause(
  filters: AgentSessionUsageAggregateFilters
): {
  clause: string;
  params: unknown[];
} {
  const { conditions, params } = buildUsageFilterConditions(filters);
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * FEA-4142: metadata-only session `COUNT(*)`. A single grouped read over the
 * `sessions` table — never a corpus hydrate — backing the count-only badge
 * read. Reuses the {@link countSqliteSessions} SSOT count helper (which the
 * Sessions-list pagination total shares), so the count can never diverge from
 * the list's own count. The `(status, ended_at)` partial index (migration 0038)
 * covers the badge's predicate.
 */
export function countSqliteSessionsForFilters(
  prisma: DesktopPrisma,
  filters: AgentSessionCountFilters
): Promise<number> {
  const { clause, params } = buildSessionCountFilterClause(filters);
  return prisma.read((reader) => countSqliteSessions(reader, clause, params));
}

/**
 * The shared date-window / status / ownership WHERE conditions for the
 * metadata-only session aggregates. Returned unjoined so callers can append
 * their own predicates before rendering the clause — `buildUsageFilterClause`
 * (usage/analytics) renders it as-is; `buildSessionCountFilterClause`
 * (FEA-4142 count-only) appends the `ended_at` completion bound.
 *
 * ISS-5443: `filters.dateWindowField` names the timestamp the window is
 * measured against. It is threaded in from the read entrypoint
 * (`buildAggregateFilters`), so ONE constant per read decides the basis for
 * both this SQL path and the hydrated fold. An absent field (an older caller,
 * or a source fake) defaults to the Sessions-surface basis, which is the one
 * that reconciles with the list.
 */
function buildUsageFilterConditions(
  filters: AgentSessionUsageAggregateFilters
): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;

  const windowTs = sessionDateWindowTsExpr(
    filters.dateWindowField ?? SESSIONS_SURFACE_DATE_WINDOW_FIELD
  );

  if (filters.harness) {
    conditions.push(`s.harness = ${placeholder()}`);
    params.push(filters.harness);
  }
  if (filters.userIds && filters.userIds.length > 0) {
    const userPlaceholders: string[] = [];
    for (const userId of filters.userIds) {
      userPlaceholders.push(placeholder());
      params.push(userId);
    }
    conditions.push(`s.user_id IN (${userPlaceholders.join(", ")})`);
  } else if (filters.userId) {
    conditions.push(`s.user_id = ${placeholder()}`);
    params.push(filters.userId);
  }
  if (filters.startDate) {
    conditions.push(`${windowTs} >= ${placeholder()}`);
    params.push(filters.startDate.toISOString());
  }
  if (filters.endDate) {
    conditions.push(`${windowTs} <= ${placeholder()}`);
    params.push(filters.endDate.toISOString());
  }
  const statuses =
    filters.statuses && filters.statuses.length > 0 ? filters.statuses : [];
  if (statuses.length === 0 && filters.status) {
    statuses.push(filters.status);
  }
  if (statuses.length > 0) {
    const statusPredicates = statuses.map((status) =>
      buildUsageStatusPredicate(status, placeholder, params)
    );
    conditions.push(`(${statusPredicates.join(" OR ")})`);
  }

  return { conditions, params };
}

/**
 * FEA-4142: WHERE clause for the count-only session `COUNT(*)`. Reuses the
 * shared started-window / status / ownership conditions, then appends the
 * FEA-3009 completion bound (`ended_at >= completedAfter`) the usage window does
 * not carry.
 */
function buildSessionCountFilterClause(filters: AgentSessionCountFilters): {
  clause: string;
  params: unknown[];
} {
  const { conditions, params } = buildUsageFilterConditions(filters);
  if (filters.completedAfter) {
    // `ended_at` holds whatever ISO string the harness transcript carried —
    // Claude's `isoTs` stores string timestamps unchanged, so a row can be
    // offset-form (`...-05:00`) or malformed. A lexical `s.ended_at >= ?` would
    // compare an offset timestamp by wall-clock text and sort malformed text
    // after the bound, diverging from the hydrated `matchesDateBounds`
    // (`new Date(endedAt)` instant compare). `julianday()` parses each side to an
    // instant — applying any `Z`/`±HH:MM` offset — so the comparison is
    // chronological; a NULL/unparseable `ended_at` yields NULL and is excluded,
    // mirroring the hydrated path's exclusion of still-running (NULL) and
    // malformed (epoch) rows. `completedAfter` is already a normalized
    // `toISOString()` UTC instant.
    conditions.push(
      `julianday(s.ended_at) >= julianday($${params.length + 1})`
    );
    params.push(filters.completedAfter);
  }
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * ISS-5366: the SQL half of the display staleness cutoff — "this row's
 * staleness anchor is older than the threshold".
 *
 * The JS half is `isSessionDisplayStale` (`@repo/api/src/types/session-status`),
 * which the hydrated `matchesStatusFilter` mirror calls; cloud's half is
 * `buildStaleAnchorBranches` (`query-builder.ts`). All three read the SAME
 * {@link STALE_SESSION_DISPLAY_THRESHOLD_HOURS} constant, so the cutoff is one
 * definition and the Active/Stale partition cannot drift between the SQL
 * aggregate, the hydrate fold, and the cloud facet — which is exactly the drift
 * the FEA-1834 §4 parity test caught when only the fold learned the cutoff.
 *
 * The anchor is the BARE `last_activity_at` column rather than a
 * `COALESCE(last_activity_at, started_at)` (the two branches cloud needs, since
 * Prisma has no COALESCE in `where`). That is not a shortcut: on desktop the
 * column is `NOT NULL` with an epoch default and is only ever written a
 * `toISOString()` value, and the hydrate path reads that same column through
 * `resolveSessionLastActivityAt` — so the fallback cloud needs is unreachable
 * here, and a row still carrying the epoch DEFAULT reads as stale on BOTH
 * paths. See `session-date-window.ts`, which windows on the bare column for the
 * same reason (and to keep `idx_sessions_last_activity` covering).
 *
 * Computed per call, not at module load, so a long-lived main process does not
 * pin a cutoff that itself goes stale.
 */
function buildStaleAnchorSql(
  placeholder: () => string,
  params: unknown[]
): string {
  const cutoffPlaceholder = placeholder();
  params.push(
    new Date(
      Date.now() - STALE_SESSION_DISPLAY_THRESHOLD_HOURS * MS_PER_HOUR
    ).toISOString()
  );
  // Lexicographic `<` is an instant comparison here: every persisted value is a
  // fixed-width UTC `toISOString()` string, so string order IS chronological
  // order. Strict `<` mirrors `isSessionDisplayStale`'s strict `elapsedMs >`.
  return `(${SESSION_LAST_ACTIVITY_AT_TS_EXPR} < ${cutoffPlaceholder})`;
}

function buildUsageStatusPredicate(
  status: string,
  placeholder: () => string,
  params: unknown[]
): string {
  // ISS-5592: this expression and its TS twin `canonicalSharedStatus` now do
  // case folding and nothing else — the `error` -> `failed` arm went first (it
  // manufactured a spelling nothing stores) and the arm that canonicalized a
  // stored `running` with it, once no write path could be shown to produce one.
  // The evidence, and why an unreachable column default does not resurrect it,
  // is on `canonicalSharedStatus`. These two must keep agreeing; they feed the
  // counts above the very list the matcher filters.
  const canonical = "lower(s.status)";
  // ISS-4586 / ISS-4654: a terminal session is never "awaiting input".
  //
  // ISS-4556: the list is RENDERED from {@link TERMINAL_SHARED_STATUSES}, so this
  // SQL renders from it too instead of restating it as a literal. The two had
  // drifted in SPELLING: this predicate said `NOT IN ('inactive','failed')` while
  // the hydrated matcher's set also holds `completed`/`abandoned`, so the two
  // paths disagreed about whether a retired-spelling row is terminal — and
  // therefore about whether it is awaiting input.
  //
  // NO SUCH ROW IS REACHABLE IN A LIVE LOCAL STORE, and this comment previously
  // claimed otherwise. Migration 0042 (`UPDATE sessions SET status = 'inactive'
  // WHERE status IN ('completed','abandoned')`) runs inside
  // `openSqliteAgentDatabase` BEFORE the write queue or any store accepts work,
  // and a boot that cannot migrate closes the handle and disables DB IPC — so
  // there is no path on which this predicate executes against an unmigrated
  // store, a restored `agent-dashboard.pgdata` included (a restored file carries
  // its own applied-migration ledger, so 0042 is simply unapplied and runs). Nor
  // can a writer reintroduce one: every `sessions.status` write emits only
  // `active`/`inactive`/`error` (`resolveImportedSessionStatus` and the literal
  // `'active'` inserts), and the `completed` writes nearby are all on the
  // `agents` table under the separate `DESKTOP_AGENT_STATUS` axis.
  //
  // So this is DRIFT PREVENTION at a persisted-row trust boundary, not a live-bug
  // fix, and it is inert today by design: reading the terminal vocabulary from
  // one exported set means a value added to (or removed from) it reaches this
  // fast path and the hydrated matcher together, instead of the SQL silently
  // keeping a literal the matcher has moved past. That is the same divergence,
  // one axis over, that the two paths just had.
  const terminalList = [...TERMINAL_SHARED_STATUSES]
    .map((value) => `'${value}'`)
    .join(", ");
  const awaiting = `(${canonical} NOT IN (${terminalList}) AND s.awaiting_input_since IS NOT NULL)`;
  // ISS-4556 / ISS-4559: the SQL statement of "this row DISPLAYS as Waiting" —
  // the same condition the hydrated `projectDisplayedSharedStatus` encodes.
  // Selected by the Waiting branch, negated by the Active branch, so this fast
  // path partitions the awaiting-input rows exactly as the JS fold does.
  const displaysAsWaiting = `(${awaiting} AND s.ended_at IS NULL)`;
  // ISS-4559: ON, a row leaves the Active population EXACTLY when it DISPLAYS as
  // Waiting; OFF (the closed-by-default rollout state), the pre-ISS-4559
  // predicate dropped EVERY awaiting-input row regardless of `ended_at`.
  //
  // Resolved ONCE and read by the ACTIVE and STALE branches alike. Leaving STALE
  // on the ungated `NOT ${awaiting}` while ACTIVE widened would stop the two
  // partitioning: an ended + awaiting + long-silent row would be excluded from
  // ACTIVE by the stale anchor and from STALE by the awaiting test, and so be
  // counted by NEITHER — the invisible-row defect this batch exists to remove,
  // one dimension over.
  // ISS-4556: the gate is read ONCE per predicate build and reused by every
  // branch below. Re-reading it per branch let a single build mix gated and
  // ungated clauses if the settings-store resolver answered differently mid-build
  // (it swallows its own errors to `false`), which would emit a predicate that
  // matches no coherent population at all.
  const parityEnabled = isDisplayedStatusParityEnabled();
  const excludedAsWaiting = parityEnabled ? displaysAsWaiting : awaiting;
  // ISS-4985: fold the RETIRED spellings off the REQUEST before bucketing, so a
  // caller counting `completed`/`abandoned` counts the Inactive population that
  // absorbed them. Without it those values matched no branch below and fell to
  // the parameterized `canonical = ?` equality at the bottom — which migration
  // 0042 (`UPDATE sessions SET status = 'inactive' WHERE status IN
  // ('completed','abandoned')`) guarantees matches ZERO rows, so the KPI cards
  // read 0 for a filter the cloud source answers with the whole Inactive
  // population.
  //
  // Applied through the SAME shared helper as the hydrated
  // `matchesStatusFilter`, because these two are twins over one cohort: this SQL
  // feeds the counts above the very list that matcher filters. Folding one and
  // not the other would restate, one axis over, the list/count divergence they
  // exist to prevent — so the union below mirrors that matcher's INACTIVE branch
  // exactly.
  // ISS-5592 removed the retired fold, so the request passes through unchanged
  // and there is no retired spelling to union back in.
  const normalized = canonicalSharedStatus(status);
  if (normalized === DISPLAYED_SESSION_STATUS.WAITING) {
    // The `s.ended_at IS NULL` guard mirrors the cloud facet/projection
    // (FEA-3149): an ended row must not surface as Waiting even if its status is
    // not yet canonicalized to a terminal value.
    if (!parityEnabled) {
      return displaysAsWaiting;
    }
    // ISS-4559: `waiting` is also a LEGACY PERSISTED status (kept for
    // version-skew), and the hydrated matcher returns such a row because it
    // displays as Waiting. Union it in so this fast path buckets the row the same
    // way — otherwise the table would list it under Waiting while the cards above
    // it, and the FEA-4142 count badge, left it out.
    return `(${displaysAsWaiting} OR ${canonical} = '${DISPLAYED_SESSION_STATUS.WAITING}')`;
  }
  if (normalized === SESSION_STATUS.ACTIVE) {
    // ISS-5366: a live-looking row silent past the display cutoff BADGES as
    // Stale on this very surface, so it must leave the Active bucket — otherwise
    // the KPI cards count rows the grid beside them labels Stale. `NOT` over the
    // same anchor test the STALE branch uses keeps the two exactly
    // complementary, so the old Active population partitions with no row lost
    // between the facets and none in both.
    //
    // ISS-4559: the awaiting-input exclusion is gated with the hydrated matcher,
    // because these two must agree — the SQL aggregate feeds the usage/count
    // cards over the SAME cohort the hydrated fold lists. Leaving this branch on
    // the old `NOT ${awaiting}` while the list widened would make an ended +
    // awaiting row appear in the table under Active but go uncounted by the
    // cards above it.
    return `(${canonical} = '${SESSION_STATUS.ACTIVE}' AND NOT ${excludedAsWaiting} AND NOT ${buildStaleAnchorSql(placeholder, params)})`;
  }
  if (normalized === DISPLAYED_SESSION_STATUS.STALE) {
    // Exactly the rows the ACTIVE branch now excludes, plus a row that literally
    // persists `stale` (which the equality fallback used to answer). Reads the
    // SAME gated `excludedAsWaiting` the ACTIVE branch negates, so the two stay
    // exact complements over the `active` population under either gate state.
    //
    // ISS-5656: the literal-`stale` arm carries the equality fallback's
    // waiting-exclusion too, through the same {@link buildStoredStatusMatchSql}
    // that fallback uses. `stale` folds to `active` (non-terminal), so the
    // Waiting projection fires for a `stale` row awaiting input and it BADGES
    // "Waiting" — unconditional, this arm counted it under Stale as well, the
    // same double-count the UNKNOWN branch below already subtracts.
    const literalStale = buildStoredStatusMatchSql(
      `${canonical} = '${DISPLAYED_SESSION_STATUS.STALE}'`,
      displaysAsWaiting,
      parityEnabled
    );
    return `((${canonical} = '${SESSION_STATUS.ACTIVE}' AND NOT ${excludedAsWaiting} AND ${buildStaleAnchorSql(placeholder, params)}) OR ${literalStale})`;
  }
  if (normalized === DISPLAYED_SESSION_STATUS.UNKNOWN) {
    // A status the display fold does not RECOGNIZE renders "Unknown", as does a
    // row literally storing `unknown`. Matching by EXCLUSION — rather than
    // listing the unknown values, which by definition cannot be listed — is what
    // lets the facet reach a version-skewed row a future producer writes.
    // Mirrors the hydrated `matchesStatusFilter` UNKNOWN branch and cloud's
    // `UNKNOWN_EXCLUDED_STATUS_VALUES`.
    const excluded = RECOGNIZED_SESSION_STATUS_VALUES.filter(
      (value) => value !== DISPLAYED_SESSION_STATUS.UNKNOWN
    );
    // `placeholder()` renders from `params.length`, so each placeholder must be
    // taken and its param pushed in lockstep — batching the pushes would emit
    // the same index N times (mirrors the `userIds IN (...)` loop above).
    const placeholders: string[] = [];
    for (const value of excluded) {
      placeholders.push(placeholder());
      params.push(value);
    }
    const unrecognized = `${canonical} NOT IN (${placeholders.join(", ")})`;
    if (!parityEnabled) {
      return unrecognized;
    }
    // ISS-4559: the awaiting-input projection runs AHEAD of the unrecognized
    // fold, so a version-skewed row that is also awaiting input DISPLAYS as
    // Waiting, not Unknown. Subtract it here or the Waiting and Unknown facets
    // both return it — the same double-count the hydrated matcher's UNKNOWN
    // branch now excludes.
    return `(${unrecognized} AND NOT ${displaysAsWaiting})`;
  }
  if (normalized === SESSION_STATUS.INACTIVE) {
    /* ISS-4654: this SQL count predicate is the twin of the hydrated
     * `matchesStatusFilter` INACTIVE branch, and the two MUST move together — a
     * count that expands where the filter does not returns a total the list
     * cannot produce. That branch dropped its legacy `completed`/`abandoned`
     * expansion (migration 0042 runs at boot, so no local row carries one), so
     * this drops it too. The CLOUD twin no longer has an expansion either —
     * ISS-5592 removed it once the ingest fold made the spelling unwritable and
     * a production count found no row holding one. Neither surface expands now,
     * so this note no longer describes a deliberate asymmetry.
     *
     * ISS-4985: the `inactive` REQUEST still expands to nothing. A RETIRED
     * request now routes here carrying its own spelling, so it counts the
     * migrated Inactive population without losing a row that still stores that
     * spelling — byte-for-byte the hydrated matcher's INACTIVE branch, which is
     * the only way the count above the list keeps matching the list. */
    return `${canonical} = '${SESSION_STATUS.INACTIVE}'`;
  }
  const nextPlaceholder = placeholder();
  params.push(normalized);
  // ISS-4559: the hydrated matcher is `displayed === requested`, so a row that
  // DISPLAYS as Waiting belongs to the Waiting facet and to no other — even
  // though its raw status is something else. `displaysAsWaiting` already carries
  // the non-terminal test, so a terminal row holding a stale awaiting-input
  // timestamp is untouched by this and still matches its own status.
  return buildStoredStatusMatchSql(
    `${canonical} = ${nextPlaceholder}`,
    displaysAsWaiting,
    parityEnabled
  );
}

/**
 * ISS-5656: a match on the row's OWN stored status, minus the rows that DISPLAY
 * as Waiting — the subtraction every stored-status arm of this predicate owes,
 * because a row belongs to the facet its badge names and to no other.
 *
 * One helper rather than one spelling per arm. The raw-status fallback carried
 * this condition and the literal-`stale` arm of the STALE branch did not, so a
 * row storing `stale` while awaiting input badged "Waiting" and was still
 * counted under Stale. Routing both through here means a third stored-status arm
 * cannot be added without it.
 *
 * Ungated it is the bare equality, byte-for-byte the pre-ISS-4559 behavior:
 * `sessions-displayed-status-parity` is closed by default and this changes
 * nothing while it is off.
 */
function buildStoredStatusMatchSql(
  equality: string,
  displaysAsWaiting: string,
  parityEnabled: boolean
): string {
  if (!parityEnabled) {
    return equality;
  }
  return `(${equality} AND NOT ${displaysAsWaiting})`;
}

/**
 * SQL-side mirror of the cheap Sessions-list filters. This keeps the default
 * 7-day view and sidebar search on the cursor-page path, so only visible rows
 * are hydrated after SQLite has found the matching IDs.
 *
 * FEA-2180: the date window filters on `last_activity_at` — the field the list
 * is ordered by — NOT `started_at`. Filtering by start time while sorting by
 * activity dropped recently-active sessions that started before the window,
 * so the dashboard's "Recent Sessions" and the Sessions page diverged. The
 * denormalized `last_activity_at` already folds in the started-at floor (see
 * `recomputeSessionLastActivityAt`), so it needs no separate null fallback.
 *
 * ISS-5443: that basis is no longer written here — this list IS the Sessions
 * surface, so it renders its bound from the shared
 * `sessionDateWindowTsExpr(SESSIONS_SURFACE_DATE_WINDOW_FIELD)` resolver that
 * the usage/KPI aggregate and the hydrated `matchesDateBounds` fold now use
 * too. One expression, one basis, one cohort.
 */
export function buildListCursorFilterClause(
  request: Pick<
    SessionListCursorPageRequest,
    "startDate" | "endDate" | "search" | "statuses"
  >
): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;
  const windowTs = sessionDateWindowTsExpr(SESSIONS_SURFACE_DATE_WINDOW_FIELD);

  if (request.startDate) {
    conditions.push(`${windowTs} >= ${placeholder()}`);
    params.push(request.startDate.toISOString());
  }
  if (request.endDate) {
    conditions.push(`${windowTs} <= ${placeholder()}`);
    params.push(request.endDate.toISOString());
  }
  // Goal stage 1 (sync reliability): the Status facet, rendered through the
  // SAME shared predicate the usage/KPI aggregate and the FEA-4142 count-only
  // read use (`buildUsageStatusPredicate`, the SQL twin of the hydrated
  // `matchesStatusFilter`) — so the paged list, the cards above it, and the
  // hydrated fallback partition one cohort. Keeping a status selection OUT of
  // this clause is what forced every status-filtered list read onto the capped
  // full-corpus hydration fallback.
  if (request.statuses && request.statuses.length > 0) {
    const statusPredicates = request.statuses.map((status) =>
      buildUsageStatusPredicate(status, placeholder, params)
    );
    conditions.push(`(${statusPredicates.join(" OR ")})`);
  }
  if (request.search) {
    const searchPlaceholder = placeholder();
    params.push(`%${escapeSqliteLikePattern(request.search.toLowerCase())}%`);
    const branchMethodPlaceholders = HIGH_CONFIDENCE_BRANCH_METHOD_VALUES.map(
      (method) => {
        const methodPlaceholder = placeholder();
        params.push(method);
        return methodPlaceholder;
      }
    );

    conditions.push(`
      (
        LOWER(COALESCE(s.name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(s.id) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(s.harness, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(s.cwd, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(
          CASE
            WHEN s.metadata IS NOT NULL AND json_valid(s.metadata)
              THEN json_extract(s.metadata, '$.gitBranch')
            ELSE NULL
          END,
          ''
        )) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM session_artifact_links sal
          JOIN artifacts a ON a.id = sal.artifact_id
          WHERE sal.session_id = s.id
            AND (
              LOWER(COALESCE(a.repo_full_name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
              OR (
                a.kind = 'branch'
                AND sal.method IN (${branchMethodPlaceholders.join(", ")})
                AND LOWER(COALESCE(a.branch_name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
              )
            )
        )
      )
    `);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * Goal stage 1b: the `activity` CTE column the Sessions cursor page orders by,
 * for a given cursor sort key.
 *
 * Lives here rather than in `sync-source.ts` for the same reason
 * `buildListCursorFilterClause` does — that file is grandfathered shrink-only,
 * and the WHERE clause and the ORDER BY of one page read belong together.
 *
 * {@link SessionListCursorSortKey.Updated} is the NATURAL cursor order
 * (`updated_at`), the order `listAllSessionCursorRows` already returns, so an
 * unsorted list read paged by this expression sees exactly the sequence the
 * hydrated fallback preserved. Any unrecognized key degrades to the
 * last-activity sort, which is the desktop list's default column.
 */
export function listCursorPageSortExpression(
  sortBy: SessionListCursorSortKey
): string {
  return LIST_CURSOR_PAGE_SORT_EXPRESSIONS[sortBy];
}

/**
 * The key→column map behind {@link listCursorPageSortExpression}. A `Record`
 * over the union rather than an if-chain so a fourth
 * {@link SessionListCursorSortKey} fails `tsc` here instead of silently
 * degrading to the last-activity sort at runtime — every column named must
 * exist in the `activity` CTE of `listSqliteSessionCursorPage`.
 */
const LIST_CURSOR_PAGE_SORT_EXPRESSIONS: Record<
  SessionListCursorSortKey,
  string
> = {
  [SessionListCursorSortKey.LastActivity]: "sort_last_activity_at",
  [SessionListCursorSortKey.Started]: "sort_started_at",
  [SessionListCursorSortKey.Updated]: "updated_at",
};
