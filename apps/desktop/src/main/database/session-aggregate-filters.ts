import { splitPriorityFilter } from "@repo/api/src/types/priority-filter";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../../shared/session-date-window-contract.js";
import { UNKNOWN_HARNESS_BUCKET } from "../../shared/shared-agent-sessions-contract.js";
import {
  type AgentSessionCountFilters,
  type AgentSessionUsageAggregateFilters,
  type SessionListCursorFacets,
  type SessionListCursorPageRequest,
  SessionListCursorSortKey,
} from "../agent-sync/agent-session-read-model.js";
import { sessionDateWindowTsExpr } from "../agent-sync/session-date-window.js";
import {
  canonicalSharedStatus,
  TERMINAL_SHARED_STATUSES,
} from "../session/session-status-filter-match.js";
import {
  BRANCH_WRITE_METHOD_VALUES,
  REPOSITORY_PAIR_KEY_EXPR,
} from "./db-constants.js";
import { escapeSqliteLikePattern } from "./db-helpers.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { countSqliteSessions } from "./session-count.js";
import { sessionQualitySqlPredicate } from "./session-quality-sql.js";
import { canonicalRankingKeySql } from "./session-timestamp-form.js";
import { assertValidSessionWorkOperands } from "./session-work-operand-validation.js";

// FEA-2038 / FEA-4142: grouped usage/analytics and the count-only badge read
// share these SQLite `WHERE`-clause builders.
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
 * FEA-4142: session `COUNT(*)`. A single read rooted at the
 * `sessions` table — never a corpus hydrate — backing the count-only badge
 * read. Reuses the {@link countSqliteSessions} SSOT count helper (which the
 * Sessions-list pagination total shares), so the count can never diverge from
 * the list's own count.
 *
 * ISS-6787: this used to claim the `(status, ended_at)` partial index covered
 * the badge's predicate, under the wrong migration number besides — the index
 * is migration 0039 (`idx_sessions_status_ended_at`). It cannot cover this
 * predicate: `buildUsageStatusPredicate` compares `lower(s.status)` and the
 * completion bound compares `julianday(s.ended_at)`, so BOTH indexed columns
 * reach the planner wrapped in a function and neither is seekable. Until an
 * expression index over those exact expressions exists, this count scans.
 */
export function countSqliteSessionsForFilters(
  prisma: DesktopPrisma,
  filters: AgentSessionCountFilters
): Promise<number> {
  const { clause, params } = buildSessionCountFilterClause(filters);
  if (!filters.quality || filters.quality === "all") {
    return prisma.read((reader) => countSqliteSessions(reader, clause, params));
  }
  const validation = buildSessionCountFilterClause({
    ...filters,
    quality: "all",
  });
  return prisma.read((reader) =>
    reader.$transaction(async (snapshot) => {
      await assertValidSessionWorkOperands(
        snapshot,
        validation.clause,
        validation.params
      );
      return countSqliteSessions(snapshot, clause, params);
    })
  );
}

/**
 * The shared date-window / status / ownership / quality WHERE conditions for
 * grouped session aggregates. Returned unjoined so callers can append
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
  if (filters.componentSessionIds !== undefined) {
    conditions.push(`s.id IN (SELECT value FROM json_each(${placeholder()}))`);
    params.push(JSON.stringify(filters.componentSessionIds));
  }

  const qualityPredicate = sessionQualitySqlPredicate(filters.quality ?? "all");
  if (qualityPredicate) {
    conditions.push(qualityPredicate);
  }

  if (filters.repositoryPairKeys !== undefined) {
    conditions.push(
      `${REPOSITORY_PAIR_KEY_EXPR} IN (SELECT value FROM json_each(${placeholder()}))`
    );
    params.push(JSON.stringify(filters.repositoryPairKeys));
  }

  const hasHarnessFacet = pushAggregateValueFacet(
    filters.harnesses,
    "s.harness",
    conditions,
    params
  );
  if (!hasHarnessFacet && filters.harness) {
    conditions.push(`s.harness = ${placeholder()}`);
    params.push(filters.harness);
  }
  pushAggregateValueFacet(filters.models, "s.model", conditions, params);
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
    // `ended_at` holds whatever the harness transcript carried at the time it
    // was written. Since ISS-6738 `toIso` canonicalizes to UTC 'Z' and drops
    // unreadable text, but rows persisted before that are untouched, so an
    // existing row can still be offset-form (`...-05:00`) or malformed. A lexical `s.ended_at >= ?` would
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
  // the same condition the hydrated `matchesStatusFilter` derives. Declared ONCE
  // and read by the branches that subtract it, so this fast path partitions the
  // awaiting-input rows exactly as the JS fold does.
  //
  // ISS-10629 retired the WAITING branch that SELECTED it; what remains is the
  // subtraction on the stored-status fallback below, which is why it is still
  // declared here.
  const displaysAsWaiting = `(${awaiting} AND s.ended_at IS NULL)`;
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
  // ISS-9939 / ISS-10629 (operator ruling, 2026-09-18): the WAITING, STALE and
  // UNKNOWN branches are GONE, in lockstep with the hydrated
  // `matchesStatusFilter` twin — these two must move together or the cards
  // above the list stop counting the list. Those values are display-only
  // projections the ruling retired as FILTER values on both surfaces. The
  // FIRST-PARTY UI path cannot send one (`SessionStatusFacetValue` plus
  // `dedupeSessionStatusFacetValues` at the parse boundary), but that seam is on
  // the PLURAL `statuses` only and the singular `status` folded in above has
  // none — see the hydrated twin for the full narrowing. A request carrying one
  // falls to the stored-status equality at the bottom.
  if (normalized === SESSION_STATUS.ACTIVE) {
    // ISS-10741 / ISS-11239: the stored status alone, matching cloud (ISS-9939).
    // No display subtraction, and no end-instant subtraction either: a row
    // storing `active` beside a recorded end matches Active here.
    return `(${canonical} = '${SESSION_STATUS.ACTIVE}')`;
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
    return `(${canonical} = '${SESSION_STATUS.INACTIVE}')`;
  }
  const nextPlaceholder = placeholder();
  params.push(normalized);
  // The stored-status equality, minus a row that DISPLAYS as Waiting over a
  // retired spelling — the same fallback as the hydrated matcher.
  // `displaysAsWaiting` already carries the non-terminal test, so a terminal
  // row (ERROR lands here) holding a stale awaiting-input timestamp is
  // untouched by this and still matches its own status.
  return buildStoredStatusMatchSql(
    `${canonical} = ${nextPlaceholder}`,
    displaysAsWaiting
  );
}

/**
 * ISS-5656: a match on the row's OWN stored status, minus the rows that DISPLAY
 * as Waiting. Only the raw-status fallback above calls it: ERROR, and any
 * retired spelling a request still carries. ACTIVE and INACTIVE match the
 * stored status alone (ISS-11239 owner ruling, 2026-09-26), so a row can sit in
 * a facet its badge does not name. `displaysAsWaiting` carries the non-terminal
 * test, so for ERROR the subtraction removes nothing.
 *
 * ISS-10629: with the WAITING/STALE/UNKNOWN branches gone, this subtraction is
 * what drops a row STORING a retired spelling that is ALSO awaiting input from
 * its own spelling, leaving it in no facet. That verdict is PINNED, not
 * incidental (marisolashgrove, #7663): `session-aggregate-status-parity.test.ts`
 * sweeps every oracle row against its own raw status on this predicate and on
 * the hydrated twin at once. The hydrated twin carries the full statement and
 * the reason both were left as they are.
 */
function buildStoredStatusMatchSql(
  equality: string,
  displaysAsWaiting: string
): string {
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
    | "startDate"
    | "endDate"
    | "search"
    | "statuses"
    | "userIds"
    | "harness"
    | "harnesses"
    | "models"
    | "priorities"
    | "componentSessionIds"
    | "quality"
  > & {
    repositoryPairKeys?: readonly string[];
    searchMatchPairKeys?: readonly string[];
    searchFallbackSessionIds?: readonly string[];
  }
): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;
  const windowTs = sessionDateWindowTsExpr(SESSIONS_SURFACE_DATE_WINDOW_FIELD);
  if (request.componentSessionIds !== undefined) {
    conditions.push(`s.id IN (SELECT value FROM json_each(${placeholder()}))`);
    params.push(JSON.stringify(request.componentSessionIds));
  }

  const qualityPredicate = sessionQualitySqlPredicate(request.quality ?? "all");
  if (qualityPredicate) {
    conditions.push(qualityPredicate);
  }
  if (request.repositoryPairKeys !== undefined) {
    conditions.push(
      `${REPOSITORY_PAIR_KEY_EXPR} IN (SELECT value FROM json_each(${placeholder()}))`
    );
    params.push(JSON.stringify(request.repositoryPairKeys));
  }

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
  pushListFacetConditions(request, conditions, params);
  if (request.search) {
    const searchPlaceholder = placeholder();
    params.push(`%${escapeSqliteLikePattern(request.search.toLowerCase())}%`);
    const pairPlaceholder = placeholder();
    params.push(JSON.stringify(request.searchMatchPairKeys ?? []));
    const fallbackPlaceholder = placeholder();
    params.push(JSON.stringify(request.searchFallbackSessionIds ?? []));
    const branchMethodPlaceholders = BRANCH_WRITE_METHOD_VALUES.map(
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
        OR ${REPOSITORY_PAIR_KEY_EXPR} IN (SELECT value FROM json_each(${pairPlaceholder}))
        OR s.id IN (SELECT value FROM json_each(${fallbackPlaceholder}))
        OR LOWER(COALESCE((
          SELECT a.branch_name
          FROM session_artifact_links sal
          JOIN artifacts a ON a.id = sal.artifact_id
          WHERE sal.session_id = s.id
            AND a.kind = 'branch'
            AND a.branch_name IS NOT NULL AND a.branch_name <> ''
            AND sal.method IN (${branchMethodPlaceholders.join(", ")})
          ORDER BY ${canonicalRankingKeySql("sal.observed_at")} DESC,
                   ${canonicalRankingKeySql("sal.created_at")} ASC, sal.id ASC
          LIMIT 1
        ), '')) LIKE ${searchPlaceholder} ESCAPE '\\'
      )
    `);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * ISS-12439: the Owner, Harness, Model and Priority facets over the `sessions`
 * columns the hydrated row reads them from — `user_id`, `harness`, `model`,
 * `priority` — each the SQL statement of the `matchesQuery` predicate it twins.
 * A null harness or model is the "unknown" option on the hydrated side, so
 * selecting it matches NULL; the priority unset option is the same NULL arm
 * (`splitPriorityFilter`).
 */
function pushListFacetConditions(
  request: SessionListCursorFacets,
  conditions: string[],
  params: unknown[]
): void {
  const placeholder = () => `$${params.length + 1}`;
  const inList = (column: string, values: readonly string[]): string => {
    const marks = values.map((value) => {
      const mark = placeholder();
      params.push(value);
      return mark;
    });
    return `${column} IN (${marks.join(", ")})`;
  };
  if (request.userIds && request.userIds.length > 0) {
    conditions.push(inList("s.user_id", request.userIds));
  }
  if (request.harnesses && request.harnesses.length > 0) {
    conditions.push(
      nullableFacetCondition("s.harness", request.harnesses, inList)
    );
  } else if (request.harness) {
    conditions.push(`s.harness = ${placeholder()}`);
    params.push(request.harness);
  }
  if (request.models && request.models.length > 0) {
    conditions.push(nullableFacetCondition("s.model", request.models, inList));
  }
  if (request.priorities && request.priorities.length > 0) {
    const { members, includesUnset } = splitPriorityFilter(request.priorities);
    const arms = [
      ...(members.length > 0 ? [inList("s.priority", members)] : []),
      ...(includesUnset ? ["s.priority IS NULL"] : []),
    ];
    // A selection of only values outside the vocabulary matches nothing, as in
    // `matchesPriorityFilter`.
    conditions.push(arms.length > 0 ? `(${arms.join(" OR ")})` : "0");
  }
}

function nullableFacetCondition(
  column: string,
  values: readonly string[],
  inList: (column: string, values: readonly string[]) => string
): string {
  const inValues = inList(column, values);
  return values.includes(UNKNOWN_HARNESS_BUCKET)
    ? `(${inValues} OR ${column} IS NULL)`
    : inValues;
}

function pushAggregateValueFacet(
  values: readonly string[] | undefined,
  column: string,
  conditions: string[],
  params: unknown[]
): boolean {
  if (!values || values.length === 0) {
    return false;
  }
  const marks = values.map((value) => {
    params.push(value);
    return `$${params.length}`;
  });
  conditions.push(
    nullableFacetCondition(
      column,
      values,
      (name) => `${name} IN (${marks.join(", ")})`
    )
  );
  return true;
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

/**
 * ISS-9584: the FROM source and the full ORDER BY of the Sessions cursor page.
 * The id closes a tie DESC in both directions, as on the cloud (FEA-4329). A
 * last-activity tie is first narrowed by `tie_started_at`, the bare
 * `started_at` column of the `activity` CTE.
 *
 * The last-activity sort pins `idx_sessions_last_activity_started`. DESC is
 * then served whole. ASC cannot be: one index cannot give `last_activity_at
 * ASC` with `started_at DESC, id DESC`. Pinned, SQLite walks the index in
 * reverse and sorts only the tied rows ("TEMP B-TREE FOR LAST 2 TERMS").
 * Unpinned, SQLite 3.53 picks a full scan plus a full sort instead.
 *
 * ISS-12439 (tamsinb review): that pin is skipped when `hydratedTies` is set
 * — a request carrying an Owner/Harness/Model/Priority facet. Pinned
 * unconditionally, a selective facet (a model in 20 of 7,872 rows) still
 * walked the whole last-activity index testing the facet predicate on every
 * row — `SCAN s USING INDEX idx_sessions_last_activity_started`. Unpinned, the
 * planner is free to seek the facet's own index (`idx_sessions_harness` /
 * `_model` / `_priority` / `_user_id`) and sort only the matched rows.
 */
export function listCursorPageSortSql(
  sortBy: SessionListCursorSortKey,
  direction: "ASC" | "DESC",
  hydratedTies = false
): { source: string; orderBy: string } {
  const source =
    sortBy === SessionListCursorSortKey.LastActivity && !hydratedTies
      ? `sessions s INDEXED BY ${LAST_ACTIVITY_SORT_INDEX}`
      : "sessions s";
  return {
    source,
    orderBy: `${listCursorPageSortExpression(sortBy)} ${direction}, ${hydratedTies ? hydratedTieOrder(sortBy) : `${lastActivityTieNarrowing(sortBy, "tie_started_at")}id DESC`}`,
  };
}

/**
 * ISS-12439: the tie order of a read that carries an Owner, Harness, Model or
 * Priority facet. Those reads were served by the hydrated sort, which is stable
 * over the `updated_at DESC, id DESC` cursor sequence, so a tie on the sort key
 * keeps that sequence and is NOT narrowed by start time (the declared
 * `hydratedTieByCursorOrder` divergence). The rows a facet read returns stay
 * what they were; the Updated sort is already that sequence.
 */
function hydratedTieOrder(sortBy: SessionListCursorSortKey): string {
  return sortBy === SessionListCursorSortKey.Updated
    ? "id DESC"
    : "updated_at DESC, id DESC";
}

/**
 * ISS-9584: the term that narrows a last-activity tie by start time DESC in
 * both directions, before the id, as the cloud's `SESSION_DEFAULT_ORDER_BY`
 * does (owner ruling on PR #7961, item 4). Only the last-activity sort takes
 * it; the Started and Updated sorts do not. Empty or ends in `, `.
 */
export function lastActivityTieNarrowing(
  sortBy: SessionListCursorSortKey | undefined,
  startedAtColumn: string
): string {
  return sortBy === SessionListCursorSortKey.LastActivity
    ? `${startedAtColumn} DESC, `
    : "";
}

/** Migration 20260926091934_iss9584_sessions_last_activity_started_index. */
const LAST_ACTIVITY_SORT_INDEX = "idx_sessions_last_activity_started";
