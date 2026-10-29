import type { AgentComponentQueryFilters } from "@repo/api/src/types/agent-component";
import {
  PLUGIN_CHILD_KINDS_SQL_LIST,
  toCanonicalIso,
} from "../database/db-helpers.js";
import {
  allOrNothingCanonicalSortSql,
  canonicalRankingKeySql,
} from "../database/session-timestamp-form.js";

/**
 * @file agent-components-usage-sql.ts
 * @description ISS-7663: the ranked source every `agent_component_session_usage`
 * recency read selects from, so the nine reads in
 * `shared-agent-components-api.ts` cannot drift from each other or from the
 * ISS-6815 sweep's own sites (`dashboard-recency-sql.ts`,
 * `dashboard-skill-sql.ts`, `optimization-analytics-queries.ts`).
 *
 * `first_invoked_at` / `last_invoked_at` are TEXT written from
 * `MIN`/`MAX(agent_component_invocations.invoked_at)` (component-invocations.ts),
 * itself bound from raw `agents.started_at` / `events.created_at` parser text
 * outside the FEA-3743 heal's `HEALED_COLUMNS`. The column therefore carries
 * mixed forms indefinitely, and byte order is only time order at a FIXED width:
 * a whole-second `Z` stamp beats a sub-second one at the same instant (`Z` 0x5A
 * sorts after `.` 0x2E), so a byte-wise `MAX` returns the EARLIER row.
 *
 * A new module rather than more SQL in `shared-agent-components-api.ts`, which
 * is grandfathered over the line ceiling and shrink-only.
 */

/** Shared with component-scoped session/UTC frequency reads; aliases are owning SQL literals. */
export const PLUGIN_CHILD_IDENTITY_SQL =
  "ac.component_kind = acsu.component_kind AND lower(trim(COALESCE(ac.component_key, ''))) = lower(trim(COALESCE(acsu.component_key, '')))";
export const PLUGIN_CHILD_OWNER_SQL =
  "(acsu.agent_component_id IS NULL OR ac.id = acsu.agent_component_id)";

const USAGE_ALIAS = "acsu";

const USAGE_FIRST_INVOKED_AT = "first_invoked_at";
const USAGE_LAST_INVOKED_AT = "last_invoked_at";

/** The ranking keys {@link usageRecencyRankedSource} exposes. Aggregate on these. */
export const FIRST_INVOKED_SORT = sortColumn(USAGE_FIRST_INVOKED_AT);
export const LAST_INVOKED_SORT = sortColumn(USAGE_LAST_INVOKED_AT);

/** Both bounds, for a reader that projects a first-seen beside a last-seen. */
export const BOTH_INVOKED_BOUNDS = [
  USAGE_FIRST_INVOKED_AT,
  USAGE_LAST_INVOKED_AT,
] as const;

/**
 * The ASCII normalization the usage lanes group an identity by, spelled once so
 * a reader's `GROUP BY` and the window it hands
 * {@link usageRecencyRankedSource} cannot drift — a partition that does not
 * match the compared set is the half-applied form
 * `allOrNothingCanonicalSortSql` documents as worse than no fix at all.
 *
 * The two lanes whose `component_key` outputs are joined on the ENCODED SLUG —
 * `usageBySlug` and `usageSessionIdsBySlug` in shared-agent-components-api.ts —
 * both derive it from here, so widening this fold cannot move one lane's key and
 * leave the other's behind. The plugin joins still spell it inline: they compare
 * `ac.component_key` against `acsu.component_key`, so they need the qualifier
 * this bare expression deliberately omits.
 *
 * Deliberately the SQL fold only. The Unicode-correct fold is the JS
 * `normalizeComponentKey` codec (FEA-3205); this narrows row counts, and the
 * application code re-folds on top of it.
 */
const USAGE_NORMALIZED_KEY_SQL = "lower(trim(COALESCE(component_key, '')))";

const USAGE_IDENTITY_PARTITION_SQL = `PARTITION BY component_kind, ${USAGE_NORMALIZED_KEY_SQL}`;

const USAGE_VERSION_IDENTITY_PARTITION_SQL = `${USAGE_IDENTITY_PARTITION_SQL}, component_version_hash`;

/**
 * The EMPTY window, for a reader whose answer IS the ranking BETWEEN its groups
 * (`ORDER BY MAX(sort)`) rather than a value projected from within one.
 *
 * Named rather than a bare `""` at three call sites because the choice is the
 * whole correctness argument: partitioning such a query by its grouping key
 * lets a group that canonicalized be ranked against a group that fell back to
 * raw, and canonicalizing an offset form LOWERS its text — so the earlier row
 * wins and the ordering is measurably worse than the unfixed query.
 */
export const BETWEEN_GROUP_RANKING_WINDOW_SQL = "";

type UsageRecencyRankedSourceOptions = {
  /** The `FROM …` (and any `WHERE …`) body, aliasing the usage table `acsu`. */
  fromSql: string;
  /**
   * The window body for the all-or-nothing guard, which must match the set the
   * reader actually COMPARES across — not always its `GROUP BY`. A reader that
   * projects a value from WITHIN each group partitions by the grouping key; one
   * whose answer is the ranking between groups passes
   * {@link BETWEEN_GROUP_RANKING_WINDOW_SQL}.
   */
  partitionSql: string;
  rankedColumns?: readonly string[];
  /** Extra projection appended to `acsu.*`, e.g. a joined `, ac.pack_id AS pack_id`. */
  extraProjectionSql?: string;
};

/**
 * A parenthesized sub-select over the usage table exposing, beside every column
 * the caller's `FROM` already had, one `<column>_sort` ranking key per entry in
 * `rankedColumns`. Aggregate on the sort key, never on the raw bytes.
 *
 * Two nesting levels, not one: `allOrNothingCanonicalSortSql` reads its two
 * arguments as column REFERENCES (each reaches the emitted SQL twice, and
 * `canonicalizeHealableTimestampSql` repeats its own argument six times), so the
 * canonicalization has to be materialized by an inner select or it expands
 * twelve-fold and re-evaluates per window.
 */
export function usageRecencyRankedSource({
  fromSql,
  partitionSql,
  rankedColumns = [USAGE_LAST_INVOKED_AT],
  extraProjectionSql = "",
}: UsageRecencyRankedSourceOptions): string {
  const canonicalProjections = rankedColumns
    .map(
      (column) =>
        `,\n          ${canonicalRankingKeySql(`${USAGE_ALIAS}.${column}`)} AS ${canonicalColumn(column)}`
    )
    .join("");
  const sortProjections = rankedColumns
    .map(
      (column) =>
        `,\n        ${allOrNothingCanonicalSortSql(canonicalColumn(column), column, partitionSql)} AS ${sortColumn(column)}`
    )
    .join("");
  return `(
      SELECT *${sortProjections}
      FROM (
        SELECT ${USAGE_ALIAS}.*${extraProjectionSql}${canonicalProjections}
        ${fromSql}
      )
    )`;
}

function canonicalColumn(column: string): string {
  return `canonical_${column}`;
}

function sortColumn(column: string): string {
  return `${column}_sort`;
}

/**
 * FEA-3196: the USAGE time window (the Agents workspace's All/30/60/90-day
 * control). Bounds are canonical `toISOString()` strings — see
 * {@link coerceIsoBound}. Both absent ⇒ the all-time view: every lane then
 * renders with no window predicate and no bindings, leaving the default surface
 * behaviorally unchanged. Mirrors the cloud `UsageWindow`
 * (apps/api/app/agent-components/service.ts).
 */
export type UsageWindow = { start?: string; end?: string };

/** One raw SQL query plus its positional bindings. */
export type UsageQuery = { sql: string; params: string[] };

export function toUsageWindow(
  filters: AgentComponentQueryFilters
): UsageWindow {
  return { start: filters.startDate, end: filters.endDate };
}

export function hasUsageWindow(window: UsageWindow): boolean {
  return Boolean(window.start || window.end);
}

/**
 * `last_invoked_at` is TEXT (`String?` in the desktop schema) and is not
 * schema-enforced ISO: it is written as `MAX(events.created_at)` (and friends),
 * which is NULL when a row has no timestamped invocation, and whose string form
 * was passed through un-normalized by `toIso` before ISS-6738 made it
 * canonicalize. A row that fails this date-prefix
 * guard therefore has NO comparable invocation instant, so it belongs to no
 * window at all.
 *
 * Requiring the guard (rather than routing failures to an epoch sentinel, as
 * `SESSION_STARTED_AT_TS_EXPR` in database/sync-source.ts does) is deliberate
 * and is what keeps parity with the cloud: an epoch sentinel is `<= endDate`,
 * so it would SURVIVE an upper-bounded window, while the cloud's Prisma
 * `lastInvokedAt: { lte }` drops NULL. sync-source's sentinel exists to mirror
 * its own hydrate path, which is a different requirement from this one.
 */
const USAGE_LAST_INVOKED_AT_IS_COMPARABLE = `acsu.last_invoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`;

/**
 * ISS-7663 (whitlockk review): the value the window bounds compare against —
 * the row's canonical INSTANT, or its raw bytes when it has none.
 *
 * The ranking key materializes INSIDE {@link usageRecencyRankedSource}, which
 * sits above this predicate, so a window filtering the raw column drops an
 * offset-form row BEFORE any sort key exists: `2026-06-22T07:00:00-05:00` is
 * 12:00Z and belongs in a window opening at 10:00Z, but its bytes sort under
 * that bound. That is strictly worse than the mis-ranking this ticket started
 * on — the row does not appear at all, so no downstream ordering can recover it.
 *
 * {@link allOrNothingCanonicalSortSql}'s two-mode guard deliberately does NOT
 * apply here. That guard exists because a grouped MAX compares rows against
 * EACH OTHER, so one canonicalized operand beside a raw one loses a true
 * winner. A window bound is per-row against a FIXED bound, so there is no
 * cross-row mix to protect: a row that canonicalizes is compared as an instant,
 * and a row that cannot falls back to exactly the byte comparison that shipped.
 * NULL propagates through the `COALESCE` and fails the comparison, which is the
 * same drop {@link USAGE_LAST_INVOKED_AT_IS_COMPARABLE} already makes above.
 */
const USAGE_LAST_INVOKED_AT_INSTANT = `COALESCE(${canonicalRankingKeySql(
  `${USAGE_ALIAS}.${USAGE_LAST_INVOKED_AT}`
)}, ${USAGE_ALIAS}.${USAGE_LAST_INVOKED_AT})`;

/**
 * FEA-3196: the `last_invoked_at` bound(s) for a usage lane, as SQL conditions
 * plus their bindings. Lexicographic comparison against canonical ISO bounds —
 * the desktop convention for ISO text columns (see sync-source.ts); NOT
 * `julianday()`, which sync-source.ts documents as drifting.
 *
 * Every usage lane feeding the list must apply this, or the windowed and
 * all-time reads disagree with each other within a single response.
 *
 * ISS-7663: BOTH sides of each comparison are canonicalized, not just the
 * column. Canonicalizing only the row would newly exclude an ordinary
 * `…T10:00:00.500Z` from an inclusive bound spelled `…T10:00:00Z`, because `.`
 * (0x2E) sorts under `Z` (0x5A). `coerceIsoBound` (shared-agent-components-api.ts)
 * already canonicalizes the IPC path's bounds and documents a bare `2026-07-14`
 * as meaning midnight UTC; doing it here too makes that hold for the page-data
 * reader, which passes `request.startDate` through unnormalized. An unparseable
 * bound is returned verbatim, degrading to today's comparison.
 */
export function usageWindowClause(window: UsageWindow): {
  conditions: string[];
  params: string[];
} {
  const conditions: string[] = [];
  const params: string[] = [];
  if (!hasUsageWindow(window)) {
    return { conditions, params };
  }
  // Any bound implies the row must carry a comparable instant — see above.
  conditions.push(USAGE_LAST_INVOKED_AT_IS_COMPARABLE);
  if (window.start) {
    conditions.push(`${USAGE_LAST_INVOKED_AT_INSTANT} >= ?`);
    params.push(toCanonicalIso(window.start));
  }
  if (window.end) {
    conditions.push(`${USAGE_LAST_INVOKED_AT_INSTANT} <= ?`);
    params.push(toCanonicalIso(window.end));
  }
  return { conditions, params };
}

/** Render `conditions` as a leading `WHERE …`, or nothing when unbounded. */
function whereClause(conditions: string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

/** Render `conditions` as trailing `AND …`s appended to an existing `WHERE`. */
function andClause(conditions: string[]): string {
  return conditions.map((condition) => `AND ${condition}`).join("\n    ");
}

export function usageAggregateSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    component_kind AS component_kind,
    ${USAGE_NORMALIZED_KEY_SQL} AS component_key,
    -- FEA-3982 (whitlockk decision): group usage by the version hash it ran against
    -- so it attributes to the MATCHING fingerprint bucket, not every same-named
    -- version. The natural key pins one hash per (session, kind, key, branch), so
    -- this only splits groups that carried different hashes — the summed
    -- invocation totals and distinct-session counts are unchanged.
    component_version_hash AS component_version_hash,
    COALESCE(SUM(invocations), 0) AS invocations,
    COUNT(DISTINCT session_id) AS session_count,
    -- FEA-3310: real usage-recency for the "recently active" indicator, as its
    -- OWN column (never folded into last_seen_at). Mirrors the cloud reader's
    -- max usage lastInvokedAt (apps/api/app/agent-components/service.ts).
    -- ISS-7663: ranked on the sort key, not the raw bytes.
    -- last_invoked_at stays the BARE column beside the single MAX, which
    -- SQLite takes from the row that produced that max, so the fix changes WHICH
    -- row wins and not the text form the renderer receives.
    last_invoked_at AS last_invoked_at,
    MAX(${LAST_INVOKED_SORT}) AS ${LAST_INVOKED_SORT}
  FROM ${usageRecencyRankedSource({
    fromSql: `FROM agent_component_session_usage acsu
  ${whereClause(conditions)}`,
    partitionSql: USAGE_VERSION_IDENTITY_PARTITION_SQL,
  })}
  GROUP BY component_kind, ${USAGE_NORMALIZED_KEY_SQL}, component_version_hash`,
    params,
  };
}

// FEA-3090: the DISTINCT (identity, version hash, session id) pairs behind the
// LOC/$ metric. Grouped by the NORMALIZED key (matching `USAGE_AGGREGATE_SQL`
// and the slug normalization) so a session that logged usage under colliding raw
// variants (e.g. `Reviewer`/`reviewer`) contributes its id to the identity
// exactly once. FEA-3982 (whitlockk): `component_version_hash` joins the key so the
// resolved lane can dedup sessions per version too; the name-level roll-up (for
// the unresolved lane) is re-derived in application code by `usageSessionIdsBySlug`.
export function usageSessionIdsSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    acsu.component_kind AS component_kind,
    ${USAGE_NORMALIZED_KEY_SQL} AS component_key,
    acsu.component_version_hash AS component_version_hash,
    acsu.session_id AS session_id
  FROM agent_component_session_usage acsu
  ${whereClause(conditions)}
  GROUP BY acsu.component_kind, ${USAGE_NORMALIZED_KEY_SQL}, acsu.component_version_hash, acsu.session_id`,
    params,
  };
}

/**
 * FEA-3121: usage aggregates for invocations whose SOURCE never resolved to a
 * LIVE `agent_components` inventory row. Source resolution fails when the
 * invoked component was local/discovered (never collected as installed
 * inventory), its usage landed before/without the inventory upsert, or its
 * inventory row was later tombstoned (`uninstalled_at`). The list/detail
 * readers otherwise fold ONLY `foldInventory` rows, so such invocations were
 * silently dropped from the desktop Agents workspace — undercounting the exact
 * "why is this session efficient" signal PRD-525 P4 requires. This mirrors the
 * cloud's orphan-usage fold (`foldOrphanUsageIntoMerged` /
 * `buildOrphanOnlyDetail` in `apps/api/app/agent-components/service.ts`) so both
 * surfaces surface the same components with the same counts.
 *
 * FEA-3205: this aggregate NO LONGER anti-joins in SQL. SQLite `lower()` is
 * ASCII-only (no ICU collation is loaded), so for a non-ASCII key (`CAFÉ`) it
 * diverges from the JS `normalizeComponentKey`/`encodeComponentSlug` codec the
 * inventory + resolved folds use — `lower("CAFÉ")` leaves `É` uppercase while JS
 * folds `CAFÉ`→`café`. That mismatch let the same identity attach to inventory
 * as RESOLVED *and* survive a SQL `NOT EXISTS` anti-join as UNRESOLVED, so it
 * was counted twice in the list + total (and, inversely, a listed component
 * could 404 on detail). We now group unresolved-candidate usage by the ASCII
 * SQL normalization ONLY to shrink the row count, then re-fold and anti-join in
 * application code against the JS-normalized inventory slug set
 * ({@link foldUnresolvedUsage}) so exactly one Unicode fold governs resolved
 * fold, unresolved anti-join, and detail.
 *
 * `plugin` usage never lands in this table (plugins have no direct usage rows —
 * their totals are a pack_id child rollup), so a plugin can never appear here as
 * an unresolved identity.
 */
export function unresolvedUsageAggregateSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    component_kind AS component_kind,
    ${USAGE_NORMALIZED_KEY_SQL} AS component_key,
    COALESCE(SUM(invocations), 0) AS invocations,
    COUNT(DISTINCT session_id) AS session_count,
    -- ISS-7663: the sort KEYS are projected here rather than a bare column
    -- beside a single aggregate, because this query carries three min/max
    -- aggregates (both bounds plus the harness collapse) and SQLite's
    -- bare-column rule applies only to a query holding exactly one. In legacy
    -- mode the key IS the raw column, so this is byte-identical to what
    -- shipped; in canonical mode it is the same INSTANT in canonical UTC, the
    -- form ISS-7449 settled on. Both bounds are consumed by the instant-wise
    -- minIso/maxIso cross-group fold below, never by a byte comparison.
    MIN(${FIRST_INVOKED_SORT}) AS first_seen_at,
    MAX(${LAST_INVOKED_SORT}) AS last_seen_at,
    -- Collapse the identity's harness the same way the cloud orphan-only path
    -- does (deriveOrphanHarness in apps/api/app/agent-components/service.ts):
    -- a mixed claude+codex identity is the contract value 'both', never a
    -- lexicographic MAX (which would return 'codex' and hide the claude usage
    -- from a harness filter). NULL only when every row left the harness unset,
    -- which toHarness then coerces to the 'claude' default. When two ASCII-SQL
    -- groups re-fold to one JS slug (non-ASCII case variants), the JS fold
    -- re-derives 'both' across them (see foldUnresolvedUsage).
    CASE
      WHEN COUNT(DISTINCT harness)
        FILTER (WHERE harness IS NOT NULL) > 1 THEN 'both'
      ELSE MAX(harness)
    END AS harness
  FROM ${usageRecencyRankedSource({
    fromSql: `FROM agent_component_session_usage acsu
  ${whereClause(conditions)}`,
    partitionSql: USAGE_IDENTITY_PARTITION_SQL,
    rankedColumns: BOTH_INVOKED_BOUNDS,
  })}
  GROUP BY component_kind, ${USAGE_NORMALIZED_KEY_SQL}`,
    params,
  };
}

/**
 * Plugin usage rollup: SUM of child usage (join usage → child agent_components
 * on (kind, key), attribute to the child's pack_id). Keyed by pack_id so a
 * plugin whose `pack_id` matches gets its children's totals.
 *
 * FEA-3239: the child-usage join normalizes `component_key` with
 * `lower(trim(COALESCE(...,'')))` on BOTH sides — the same fold every sibling
 * usage lane applies (`USAGE_AGGREGATE_SQL` et al.) and the org-identity slug
 * uses. A raw `ac.component_key = acsu.component_key` join is case/whitespace
 * sensitive, so a child whose usage-row key differs only in case from its
 * pack-manifest inventory key (`Reviewer` vs `reviewer`) was silently dropped,
 * undercounting the plugin's invocations/sessions/KLOC-$ below the cloud reader
 * (apps/api/app/agent-components/service.ts), which rolls up via the true FK.
 *
 * `ac.component_key IS NOT NULL` is retained (inventory `component_key` is
 * nullable) so the fold does NOT introduce a new over-match: `COALESCE(NULL,'')`
 * would otherwise collapse a null-key inventory child to `''` and join it to any
 * usage row whose key trims to empty — a match the raw `NULL = key` join never
 * made. Keeping the guard preserves the raw NULL-no-match semantics and lets the
 * partial index `idx_agent_components_kind_key` (WHERE component_key IS NOT NULL)
 * stay eligible.
 */
export function pluginUsageSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    pack_id AS pack_id,
    COALESCE(SUM(invocations), 0) AS invocations,
    COUNT(DISTINCT session_id) AS session_count,
    -- FEA-3310: max child-usage recency, rolled up so a plugin's real
    -- last-invocation time reflects its most recently used child. ISS-7663:
    -- ranked on the sort key, with the bare column beside the single MAX.
    last_invoked_at AS last_invoked_at,
    MAX(${LAST_INVOKED_SORT}) AS ${LAST_INVOKED_SORT}
  FROM ${usageRecencyRankedSource({
    partitionSql: "PARTITION BY pack_id",
    extraProjectionSql: ",\n          ac.pack_id AS pack_id",
    fromSql: `FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ${PLUGIN_CHILD_IDENTITY_SQL}
  WHERE ac.pack_id IS NOT NULL
    AND ac.component_key IS NOT NULL
    -- ISS-6180: roll up only LIVE inventory children — the same
    -- uninstalled_at IS NULL scope INVENTORY_SELECT and every sibling inventory
    -- read apply. Scanners TOMBSTONE rather than delete (mcp-discovery.ts stamps
    -- uninstalled_at on mcp rows, a plugin child kind since ISS-6094) and
    -- nothing clears the child's pack_id, so without this an uninstalled child's
    -- invocations keep rolling into its plugin's total while the SAME usage also
    -- surfaces as a standalone "unresolved" row (that lane anti-joins the LIVE
    -- inventory slug set, which a tombstoned row has left) — one invocation
    -- rendered twice in one response, which ISS-5534's sumDedupedInvocations
    -- cannot suppress because an unresolved row carries no packIds for its
    -- exact-intersection test to match. Mirrors the cloud twin's
    -- uninstalledAt: null child-inventory scope
    -- (apps/api/app/agent-components/plugin-child-usage.ts).
    AND ac.uninstalled_at IS NULL
    -- ISS-6180 (whitlockk review): the natural-key join is the FALLBACK, not the
    -- authority. acsu.agent_component_id names the exact inventory row the writer
    -- linked, so when a usage row carries one, that row is its only legal match —
    -- otherwise a STALE link joins whatever now shares its (kind, key). The link
    -- goes stale because relinkInvocationRows only re-runs for RE-DERIVED
    -- sessions: a child linked while it was the identity's only install keeps
    -- that FK after the install is uninstalled (tombstoned) or joined by a second
    -- install, and the fold would then credit the plugin through a row the writer
    -- never pointed at. Restricting the fallback to null-FK rows leaves the
    -- FEA-3239 case-fold intact for exactly the rows that need it (usage that was
    -- never linked), and is a WHERE guard rather than an OR join condition so
    -- idx_acsu_kind_key stays eligible.
    --
    -- NOT fixed here, and not in ISS-6180's scope: relinkInvocationRows writes a
    -- NULL local_component_id whenever a (kind, key) matches more than one
    -- inventory row (match_count <> 1 => ELSE NULL), and that column is what the
    -- rebuild copies into agent_component_id. So a FRESHLY re-derived session
    -- whose child is installed at two scopes still takes the fallback arm, still
    -- joins both live rows, and still doubles SUM(acsu.invocations). That
    -- duplicate-install multiplication predates this change and needs its own
    -- ticket -- a distinct-install join, not an FK guard.
    AND ${PLUGIN_CHILD_OWNER_SQL}
    AND ac.component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
    ${andClause(conditions)}`,
  })}
  GROUP BY pack_id`,
    params,
  };
}

// FEA-3090: the DISTINCT (pack id, session id) pairs the plugin LOC/$ rolls up
// over. Same child-usage join as `PLUGIN_USAGE_SQL`, grouped down to distinct
// session ids so `computeLocPerDollar` sees each child session once per plugin.
export function pluginUsageSessionIdsSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    ac.pack_id AS pack_id,
    acsu.session_id AS session_id
  FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ${PLUGIN_CHILD_IDENTITY_SQL}
  WHERE ac.pack_id IS NOT NULL
    AND ac.component_key IS NOT NULL
    -- Live-inventory scope, for the reason spelled out in pluginUsageSql: a
    -- tombstoned child must not contribute the sessions its plugin's LOC/$ is
    -- computed over either, or the metric disagrees with the rollup it divides.
    AND ac.uninstalled_at IS NULL
    -- Authoritative-FK guard, for the reason spelled out in pluginUsageSql. The
    -- session set must come from the same matches the invocation total did.
    AND ${PLUGIN_CHILD_OWNER_SQL}
    AND ac.component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
    ${andClause(conditions)}
  GROUP BY ac.pack_id, acsu.session_id`,
    params,
  };
}

/** One distinct (pack id, session id) child-usage pair for a plugin rollup. */
export type PluginUsageSessionIdRow = {
  pack_id: string;
  session_id: string;
};

/**
 * Plugin per-session usage: the same child-usage rollup as `PLUGIN_USAGE_SQL`
 * but grouped by (pack_id, session_id) so a plugin's `usageSessions` breakdown
 * is built from the identical source as its rolled-up `invocations` total —
 * plugins have no direct usage rows, so reading their own rows would yield an
 * empty breakdown that contradicts the nonzero rollup.
 */
export const PLUGIN_USAGE_SESSIONS_SQL = `SELECT
    session_id AS session_id,
    COALESCE(SUM(invocations), 0) AS invocation_count
  FROM ${usageRecencyRankedSource({
    partitionSql: BETWEEN_GROUP_RANKING_WINDOW_SQL,
    fromSql: `FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ${PLUGIN_CHILD_IDENTITY_SQL}
  WHERE ac.pack_id = ?
    AND ac.component_key IS NOT NULL
    -- Live-inventory scope, for the reason spelled out in pluginUsageSql: the
    -- detail's per-session breakdown must come from the SAME children the list's
    -- rolled-up total did, or detail and list contradict each other.
    AND ac.uninstalled_at IS NULL
    -- Authoritative-FK guard, for the reason spelled out in pluginUsageSql. The
    -- per-session breakdown must be built from the same matches the total was.
    AND ${PLUGIN_CHILD_OWNER_SQL}
    AND ac.component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})`,
  })}
  GROUP BY session_id
  ORDER BY MAX(${LAST_INVOKED_SORT}) DESC, session_id ASC`;

/**
 * One row of {@link usageAggregateSql} / {@link unresolvedUsageAggregateSql}.
 * Lives beside the SQL that produces it (ISS-10341), with its sibling
 * {@link PluginUsageSessionIdRow}, so a second reader of these queries does not
 * re-declare the shape.
 */
export type UsageAggregateRow = {
  component_kind: string;
  component_key: string;
  // FEA-3982 (whitlockk decision): the version hash this usage bucket ran against, so
  // usage attributes to the MATCHING fingerprint bucket rather than being applied
  // to every same-named version. NULL for a hash-less (version-agnostic) row,
  // which stays on the name-level bucket (skew-safe). The desktop store has no
  // `definition_version_id`, so it attributes on `component_version_hash` alone —
  // the same fallback the cloud takes for a still-unlinked usage row.
  component_version_hash: string | null;
  invocations: bigint | number | null;
  session_count: bigint | number | null;
  last_invoked_at: string | null;
  /**
   * ISS-7663: the query's only min/max aggregate. Nothing maps from it, but it
   * MUST stay in the SELECT list — dropping it leaves the query with no min/max
   * aggregate at all, so SQLite's bare-column rule stops applying and
   * `last_invoked_at` silently rebinds to an arbitrary row of the group.
   */
  last_invoked_at_sort: string | null;
};

/** One row of {@link pluginUsageSql}. */
export type PluginUsageRow = {
  pack_id: string;
  invocations: bigint | number | null;
  session_count: bigint | number | null;
  last_invoked_at: string | null;
  /** The single min/max aggregate — see `UsageAggregateRow.last_invoked_at_sort`. */
  last_invoked_at_sort: string | null;
};
