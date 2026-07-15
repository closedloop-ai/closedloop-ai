/**
 * @file shared-agent-components-api.ts
 * @description Local (desktop) read handlers backing the two agent-components
 * IPC channels (FEA-2923 / T-16.3). Reads the org inventory straight from local
 * SQLite (`agent_components` + `agent_component_session_usage`) and projects it
 * into the shared `AgentComponent` / `AgentComponentListResponse` /
 * `AgentComponentDetail` shapes consumed by the `@repo/app` agents workspace.
 *
 * These are the concrete bodies the design-system runtime wires under
 * `desktop:db:list-agent-components` / `desktop:db:get-agent-component-detail`.
 * The renderer never round-trips to the cloud for the desktop-local source.
 *
 * Identity model (shared cross-surface codec — `encodeComponentSlug` /
 * `decodeComponentSlug` from `@repo/api/src/types/agent-component-analytics`):
 * a component's org-level identity is `${componentKind}::${normalizedKey}` where
 * `normalizedKey = (componentKey ?? name ?? "").toLowerCase().trim()`. That slug
 * is the `AgentComponent.id` returned by `list()` AND the argument `detail()`
 * accepts, so renderer navigation (`/agents/${encodeURIComponent(item.id)}`)
 * round-trips through the same key.
 *
 * Plugin child-usage rollup (§1c / T-13.4): a `plugin` component's
 * `invocations`/`sessions` are NOT read from its own usage rows (plugins are
 * never invoked directly). Instead they are summed on-read over the usage of the
 * child skill/command components whose `agent_components.pack_id` equals the
 * plugin's `pack_id` — the association `component-scanner.ts` back-fills.
 */

import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentKind,
  AgentComponentListResponse,
  AgentComponentProperties,
  AgentComponentQueryFilters,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
// Runtime value: the shared org-inventory cap. `agent-component.ts` is a
// pure types + const-object leaf (its own imports are all `import type`), so
// pulling this value in adds no side effects to the pglite boot path.
import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
// Cross-surface org-identity slug codec (SSOT). This is a pure-string leaf with
// no imports, so the runtime value import stays out of the pglite boot path
// (cf. #1618/#1620) — do NOT widen this to a barrel `@repo/api` import.
import {
  decodeComponentSlug,
  encodeComponentSlug,
  normalizeComponentKey,
} from "@repo/api/src/types/agent-component-analytics";
import type { AgentSessionSyncSource } from "./agent-session-sync-service.js";
import { maxIso, minIso } from "./database/db-helpers.js";
import type { DbHostPrisma } from "./database/prisma-client.js";
import {
  getSharedAgentSessionLocCostByIds,
  getSharedAgentSessionsWithLocCostByIds,
  type SharedAgentSessionLocCost,
} from "./shared-agent-sessions-api.js";

/** Minimal Prisma surface these readers need (clone-safe `client` reads only). */
export type AgentComponentsReadPrisma = Pick<DbHostPrisma, "client">;

type ComponentInventoryRow = {
  id: string;
  component_kind: string;
  external_id: string;
  component_key: string | null;
  name: string | null;
  harness: string | null;
  source: string | null;
  description: string | null;
  source_url: string | null;
  install_path: string | null;
  pack_id: string | null;
  scope: string | null;
  project_path: string | null;
  metadata: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

type UsageAggregateRow = {
  component_kind: string;
  component_key: string;
  invocations: bigint | number | null;
  session_count: bigint | number | null;
};

type PluginUsageRow = {
  pack_id: string;
  invocations: bigint | number | null;
  session_count: bigint | number | null;
};

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "subagent",
  "command",
  "skill",
  "workflow",
  "mcp",
  "hook",
  "config",
  "plugin",
  // FEA-3048: `tool` is a first-class observable-only kind. Without it here,
  // `toKind()` coerced every built-in tool row (Read/Grep/Bash …) to `config`
  // ("Memory & config") — the collapse-to-config bug. Keep it OUT of any
  // promote/catalog/distributable list: tools are observable, not distributable.
  "tool",
]);

const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "both",
]);

function toKind(value: string): AgentComponentKind {
  return (KNOWN_KINDS.has(value) ? value : "config") as AgentComponentKind;
}

function toHarness(value: string | null): Harness {
  return (value && KNOWN_HARNESSES.has(value) ? value : "claude") as Harness;
}

/** Map the inventory row's scope/pack provenance to a display SourceType. */
function toSourceType(row: ComponentInventoryRow): SourceType {
  if (row.component_kind === "mcp") {
    return "server";
  }
  if (row.pack_id) {
    return "pack";
  }
  if (row.project_path || row.scope === "project") {
    return "repo";
  }
  return "local";
}

function toNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * KLOC/$ for one component = (thousands of authored local-git lines produced by
 * the sessions that invoked it) / (their summed estimated cost). Sessions are
 * deduped by id (a component can carry multiple usage rows per session, so each
 * session's LOC + cost must count exactly once). Returns null when the summed
 * cost is 0 or the sessions produced no measurable lines (never a fabricated or
 * divide-by-zero number).
 *
 * Ported verbatim from the cloud reader (`computeKlocPerDollar` in
 * apps/api/app/agent-components/service.ts) so the desktop "KLOC/$" column agrees
 * with the web column (FEA-3090) instead of hardcoding null.
 */
function computeKlocPerDollar(
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): number | null {
  let totalLoc = 0;
  let totalCost = 0;
  for (const sessionId of sessionIds) {
    const entry = locCostBySession.get(sessionId);
    if (!entry) {
      continue;
    }
    totalLoc += entry.loc;
    totalCost += entry.cost;
  }
  if (totalCost <= 0 || totalLoc <= 0) {
    return null;
  }
  return totalLoc / 1000 / totalCost;
}

/** Coerce untrusted IPC input into a normalized query-filter object. */
export function coerceAgentComponentFilters(
  value: unknown
): AgentComponentQueryFilters {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const filters: AgentComponentQueryFilters = {};
  if (Array.isArray(raw.kinds)) {
    filters.kinds = raw.kinds.filter(
      (k): k is AgentComponentKind =>
        typeof k === "string" && KNOWN_KINDS.has(k)
    );
  }
  // NOTE: the `owner` filter is intentionally NOT accepted here. Desktop-local
  // reads never attribute an owner (see buildComponent — every component's
  // `owner` is null because the desktop has no org-wide user directory), so
  // honoring an owner filter would silently exclude every row. Dropping it
  // keeps the local surface from applying a filter that can only match nothing.
  if (typeof raw.source === "string") {
    filters.source = raw.source;
  }
  if (typeof raw.harness === "string" && KNOWN_HARNESSES.has(raw.harness)) {
    filters.harness = raw.harness as Harness;
  }
  if (typeof raw.search === "string") {
    filters.search = raw.search;
  }
  if (typeof raw.limit === "number" && raw.limit > 0) {
    // Clamp to the shared org-inventory cap (not a smaller local literal) so the
    // shared Agents workspace's single full-inventory fetch
    // (`AGENT_INVENTORY_FETCH_LIMIT`, the same value) is not silently truncated
    // on desktop — a local workspace with more than the old 1000-row clamp would
    // otherwise lose later pages and undercount the summary cards.
    filters.limit = Math.min(
      Math.floor(raw.limit),
      AGENT_COMPONENT_INVENTORY_CAP
    );
  }
  if (typeof raw.offset === "number" && raw.offset >= 0) {
    filters.offset = Math.floor(raw.offset);
  }
  return filters;
}

function displaySource(row: ComponentInventoryRow): string {
  if (row.pack_id) {
    return row.pack_id;
  }
  if (row.source) {
    return row.source;
  }
  if (row.scope) {
    return row.scope;
  }
  return row.install_path ?? row.external_id;
}

/**
 * Fold multiple inventory rows for the same org-identity slug into a single
 * canonical representative, tracking the earliest/latest seen timestamps.
 */
type MergedComponent = {
  slug: string;
  representative: ComponentInventoryRow;
  packIds: Set<string>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

function foldInventory(
  rows: ComponentInventoryRow[]
): Map<string, MergedComponent> {
  const merged = new Map<string, MergedComponent>();
  for (const row of rows) {
    const slug = encodeComponentSlug(
      row.component_kind,
      row.component_key,
      row.name
    );
    const existing = merged.get(slug);
    if (existing) {
      if (row.pack_id) {
        existing.packIds.add(row.pack_id);
      }
      existing.firstSeenAt = minIso(existing.firstSeenAt, row.first_seen_at);
      existing.lastSeenAt = maxIso(existing.lastSeenAt, row.last_seen_at);
      continue;
    }
    merged.set(slug, {
      slug,
      representative: row,
      packIds: new Set(row.pack_id ? [row.pack_id] : []),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    });
  }
  return merged;
}

/** Usage totals keyed by `${kind}::${lowercased key}` for O(1) join. */
function usageBySlug(
  rows: UsageAggregateRow[]
): Map<string, { invocations: number; sessions: number }> {
  const bySlug = new Map<string, { invocations: number; sessions: number }>();
  for (const row of rows) {
    const slug = encodeComponentSlug(
      row.component_kind,
      row.component_key,
      null
    );
    // `USAGE_AGGREGATE_SQL` already groups by the NORMALIZED key (matching this
    // slug's key normalization), so each slug maps to exactly one row here: the
    // session count is a distinct-session union across colliding raw variants
    // computed in SQL, never a sum of per-variant counts (which would
    // double-count a session shared by two variants). The accumulate branch
    // below is a defensive fallback for the impossible case of two rows folding
    // to one slug; invocations stay additive to match the identity fold in
    // `foldInventory` and the cloud producer (apps/api/app/agent-components).
    const existing = bySlug.get(slug);
    if (existing) {
      existing.invocations += toNumber(row.invocations);
      existing.sessions += toNumber(row.session_count);
    } else {
      bySlug.set(slug, {
        invocations: toNumber(row.invocations),
        sessions: toNumber(row.session_count),
      });
    }
  }
  return bySlug;
}

/** One distinct (component identity, session id) usage pair. */
type UsageSessionIdRow = {
  component_kind: string;
  component_key: string;
  session_id: string;
};

/**
 * The set of invoking session ids per org-identity slug (FEA-3090), keyed the
 * same way as {@link usageBySlug} (`${kind}::${normalized key}`) so it joins
 * against both live-inventory and unresolved-source components. Feeds the
 * per-session dedup in {@link computeKlocPerDollar}.
 */
function usageSessionIdsBySlug(
  rows: UsageSessionIdRow[]
): Map<string, Set<string>> {
  const bySlug = new Map<string, Set<string>>();
  for (const row of rows) {
    const slug = encodeComponentSlug(
      row.component_kind,
      row.component_key,
      null
    );
    const existing = bySlug.get(slug);
    if (existing) {
      existing.add(row.session_id);
    } else {
      bySlug.set(slug, new Set([row.session_id]));
    }
  }
  return bySlug;
}

function buildComponent(
  merged: MergedComponent,
  usage: { invocations: number; sessions: number } | undefined,
  pluginUsage: { invocations: number; sessions: number } | undefined,
  computeTargetId: string | null
): AgentComponent {
  const row = merged.representative;
  const kind = toKind(row.component_kind);
  // Plugins roll up child usage from their children; every other kind reads its
  // own usage rows. hook/config kinds legitimately have no usage rows, so they
  // reconcile to an honest 0 (not null) — matching the cloud service
  // (apps/api/app/agent-components/service.ts), which always emits a numeric
  // `totalInvocations`/`sessions` for the identical case. Returning null here
  // would make the same component read 0 on the cloud and null on the desktop.
  const isPlugin = kind === "plugin";
  const resolved = isPlugin ? pluginUsage : usage;
  return {
    id: merged.slug,
    name: row.name ?? row.component_key ?? row.external_id,
    kind,
    sourceType: toSourceType(row),
    source: displaySource(row),
    harness: toHarness(row.harness),
    invocations: resolved?.invocations ?? 0,
    sessions: resolved?.sessions ?? 0,
    klocPerDollar: null,
    trend: [],
    // Desktop-local reads are single-user/single-device: there is no org-wide
    // display-name directory to attribute an `owner` from (the cloud resolves
    // owners via the ComputeTarget→User relation, which the desktop lacks), so
    // `owner` stays intentionally null. `computeTargetIds` IS populated with
    // this device's local compute-target id when the runtime can resolve it,
    // so the local device shows up as an observing target like the cloud does.
    owner: null,
    collaborators: [],
    computeTargetIds: computeTargetId ? [computeTargetId] : [],
    firstSeenAt: merged.firstSeenAt ?? row.first_seen_at ?? "",
    lastSeenAt: merged.lastSeenAt ?? row.last_seen_at ?? "",
  };
}

function matchesFilters(
  component: AgentComponent,
  filters: AgentComponentQueryFilters
): boolean {
  if (
    filters.kinds &&
    filters.kinds.length > 0 &&
    !filters.kinds.includes(component.kind)
  ) {
    return false;
  }
  if (filters.harness && component.harness !== filters.harness) {
    return false;
  }
  if (filters.source && component.source !== filters.source) {
    return false;
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    if (!component.name.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return true;
}

const INVENTORY_SELECT = `SELECT
    id, component_kind, external_id, component_key, name, harness, source,
    description, source_url, install_path, pack_id, scope, project_path,
    metadata, first_seen_at, last_seen_at
  FROM agent_components
  WHERE uninstalled_at IS NULL`;

// Group by the NORMALIZED key (`lower(trim(...))`, null→"") so it matches the
// org-identity slug's key normalization. Grouping raw would emit one
// `COUNT(DISTINCT session_id)` per colliding raw variant (e.g. `Reviewer` vs
// `reviewer`), and a session that logged usage under both variants would be
// counted once per variant — the merge in `usageBySlug` would then sum those
// per-variant counts and double-count the session. Grouping by the normalized
// key instead makes `COUNT(DISTINCT session_id)` a true distinct-session union
// at the slug level (and `SUM(invocations)` an exact total), so the merged
// value can no longer overstate sessions — mirroring the cloud producer, which
// unions session ids per identity via a `Set` (apps/api/app/agent-components).
const USAGE_AGGREGATE_SQL = `SELECT
    component_kind,
    lower(trim(COALESCE(component_key, ''))) AS component_key,
    COALESCE(SUM(invocations), 0) AS invocations,
    COUNT(DISTINCT session_id) AS session_count
  FROM agent_component_session_usage
  GROUP BY component_kind, lower(trim(COALESCE(component_key, '')))`;

// FEA-3090: the DISTINCT (identity, session id) pairs behind the KLOC/$ metric.
// Grouped by the NORMALIZED key (matching `USAGE_AGGREGATE_SQL` and the slug
// normalization) so a session that logged usage under colliding raw variants
// (e.g. `Reviewer`/`reviewer`) contributes its id to the identity exactly once.
const USAGE_SESSION_IDS_SQL = `SELECT
    component_kind,
    lower(trim(COALESCE(component_key, ''))) AS component_key,
    session_id
  FROM agent_component_session_usage
  GROUP BY component_kind, lower(trim(COALESCE(component_key, ''))), session_id`;

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
const UNRESOLVED_USAGE_AGGREGATE_SQL = `SELECT
    acsu.component_kind AS component_kind,
    lower(trim(COALESCE(acsu.component_key, ''))) AS component_key,
    COALESCE(SUM(acsu.invocations), 0) AS invocations,
    COUNT(DISTINCT acsu.session_id) AS session_count,
    MIN(acsu.first_invoked_at) AS first_seen_at,
    MAX(acsu.last_invoked_at) AS last_seen_at,
    -- Collapse the identity's harness the same way the cloud orphan-only path
    -- does (deriveOrphanHarness in apps/api/app/agent-components/service.ts):
    -- a mixed claude+codex identity is the contract value 'both', never a
    -- lexicographic MAX (which would return 'codex' and hide the claude usage
    -- from a harness filter). NULL only when every row left the harness unset,
    -- which toHarness then coerces to the 'claude' default. When two ASCII-SQL
    -- groups re-fold to one JS slug (non-ASCII case variants), the JS fold
    -- re-derives 'both' across them (see foldUnresolvedUsage).
    CASE
      WHEN COUNT(DISTINCT acsu.harness)
        FILTER (WHERE acsu.harness IS NOT NULL) > 1 THEN 'both'
      ELSE MAX(acsu.harness)
    END AS harness
  FROM agent_component_session_usage acsu
  GROUP BY acsu.component_kind, lower(trim(COALESCE(acsu.component_key, '')))`;

/** One unresolved-source usage identity (no live inventory row). */
type UnresolvedUsageRow = {
  component_kind: string;
  component_key: string;
  invocations: bigint | number | null;
  session_count: bigint | number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  harness: string | null;
};

/**
 * Synthesize an `AgentComponent` for a usage identity that has no live
 * inventory row (source resolution failed). Tagged `sourceType: "local"` — the
 * existing SourceType value that means "no resolvable pack/repo/server
 * provenance" (see `toSourceType`'s default) — so the row is honestly surfaced
 * as unresolved rather than dropped. The identity slug is derived from the
 * usage row itself so renderer navigation to its detail round-trips through the
 * same `getAgentComponentDetailLocal` key.
 */
function buildUnresolvedComponent(row: UnresolvedUsageRow): AgentComponent {
  const kind = toKind(row.component_kind);
  const key = row.component_key;
  const slug = encodeComponentSlug(row.component_kind, key, null);
  return {
    id: slug,
    name: key,
    kind,
    // mcp usage is always server-provenance (mirrors `toSourceType`'s mcp
    // branch); every other unresolved kind falls back to "local" ==
    // builder-specific / no resolvable installed source: the honest marker for
    // an invocation whose source we could not resolve.
    sourceType: kind === "mcp" ? "server" : "local",
    source: key,
    harness: toHarness(row.harness),
    invocations: toNumber(row.invocations),
    sessions: toNumber(row.session_count),
    klocPerDollar: null,
    trend: [],
    owner: null,
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: row.first_seen_at ?? "",
    lastSeenAt: row.last_seen_at ?? "",
  };
}

/**
 * FEA-3205: merge two collapsed harness values the way the SQL CASE does — any
 * two DISTINCT real harnesses (or an already-'both') fold to the contract
 * 'both'; a null side is ignored so a single real harness survives.
 */
function mergeHarness(a: string | null, b: string | null): string | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  if (a === b) {
    return a;
  }
  // Two different non-null harnesses (e.g. claude + codex, or X + 'both').
  return "both";
}

/**
 * FEA-3205: compute the unresolved-source usage identities in APPLICATION CODE,
 * using the SAME JS Unicode-aware normalizer (`normalizeComponentKey` /
 * `encodeComponentSlug`) that the inventory + resolved folds use — instead of a
 * SQL `lower()` anti-join, which is ASCII-only and diverges on non-ASCII keys.
 *
 * `usageRows` are the per-(kind, ASCII-normalized key) aggregates from
 * {@link UNRESOLVED_USAGE_AGGREGATE_SQL} for ALL usage identities (no SQL
 * anti-join). We:
 *   1. re-key each row by the JS slug (`encodeComponentSlug`), MERGING rows that
 *      the ASCII SQL kept apart but JS folds together (e.g. `CAFÉ` / `café`) —
 *      invocations sum, harness merges, timestamps min/max;
 *   2. anti-join against `inventorySlugs` (the JS-normalized live-inventory slug
 *      set from {@link foldInventory}) so an identity that resolved to inventory
 *      under the JS fold is NOT also surfaced as unresolved (the double-count);
 *   3. take each identity's distinct `sessions` from `sessionIdsBySlug` (the
 *      true distinct-session union keyed by the same JS slug), so a session that
 *      logged usage under two folded variants counts once — never a sum of
 *      per-variant SQL `session_count`s.
 *
 * Each returned row's `component_key` is the JS-normalized key, so the slug the
 * list builds (`buildUnresolvedComponent` → `encodeComponentSlug`) matches the
 * one the detail path decodes (`decodeComponentSlug`) — list and detail agree.
 */
function foldUnresolvedUsage(
  usageRows: UnresolvedUsageRow[],
  inventorySlugs: ReadonlySet<string>,
  sessionIdsBySlug: Map<string, Set<string>>
): UnresolvedUsageRow[] {
  const bySlug = new Map<string, UnresolvedUsageRow>();
  for (const row of usageRows) {
    const normalizedKey = normalizeComponentKey(row.component_key);
    const slug = encodeComponentSlug(row.component_kind, normalizedKey, null);
    // Anti-join in JS against the JS-normalized inventory slug set. An identity
    // that folds onto a live inventory row is already surfaced as RESOLVED, so
    // skipping it here is what stops the non-ASCII double-count.
    if (inventorySlugs.has(slug)) {
      continue;
    }
    const existing = bySlug.get(slug);
    if (existing) {
      existing.invocations =
        toNumber(existing.invocations) + toNumber(row.invocations);
      existing.first_seen_at = minIso(
        existing.first_seen_at,
        row.first_seen_at
      );
      existing.last_seen_at = maxIso(existing.last_seen_at, row.last_seen_at);
      existing.harness = mergeHarness(existing.harness, row.harness);
    } else {
      bySlug.set(slug, {
        component_kind: row.component_kind,
        // Carry the JS-normalized key so name/source/slug all agree with detail.
        component_key: normalizedKey,
        invocations: toNumber(row.invocations),
        session_count: 0,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        harness: row.harness,
      });
    }
  }
  // Distinct-session union per identity from the JS-slug-keyed session id map —
  // authoritative over the SQL per-group `session_count` (which would
  // double-count a session shared across two folded variants).
  for (const [slug, row] of bySlug) {
    row.session_count = sessionIdsBySlug.get(slug)?.size ?? 0;
  }
  return [...bySlug.values()];
}

/**
 * Plugin usage rollup: SUM of child usage (join usage → child agent_components
 * on (kind, key), attribute to the child's pack_id). Keyed by pack_id so a
 * plugin whose `pack_id` matches gets its children's totals.
 */
const PLUGIN_USAGE_SQL = `SELECT
    ac.pack_id AS pack_id,
    COALESCE(SUM(acsu.invocations), 0) AS invocations,
    COUNT(DISTINCT acsu.session_id) AS session_count
  FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ac.component_kind = acsu.component_kind
    AND ac.component_key = acsu.component_key
  WHERE ac.pack_id IS NOT NULL
    AND ac.component_kind IN ('skill', 'command', 'subagent', 'mcp')
  GROUP BY ac.pack_id`;

// FEA-3090: the DISTINCT (pack id, session id) pairs the plugin KLOC/$ rolls up
// over. Same child-usage join as `PLUGIN_USAGE_SQL`, grouped down to distinct
// session ids so `computeKlocPerDollar` sees each child session once per plugin.
const PLUGIN_USAGE_SESSION_IDS_SQL = `SELECT
    ac.pack_id AS pack_id,
    acsu.session_id AS session_id
  FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ac.component_kind = acsu.component_kind
    AND ac.component_key = acsu.component_key
  WHERE ac.pack_id IS NOT NULL
    AND ac.component_kind IN ('skill', 'command', 'subagent', 'mcp')
  GROUP BY ac.pack_id, acsu.session_id`;

/** One distinct (pack id, session id) child-usage pair for a plugin rollup. */
type PluginUsageSessionIdRow = {
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
const PLUGIN_USAGE_SESSIONS_SQL = `SELECT
    acsu.session_id AS session_id,
    COALESCE(SUM(acsu.invocations), 0) AS invocation_count
  FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ac.component_kind = acsu.component_kind
    AND ac.component_key = acsu.component_key
  WHERE ac.pack_id = ?
    AND ac.component_kind IN ('skill', 'command', 'subagent', 'mcp')
  GROUP BY acsu.session_id
  ORDER BY MAX(acsu.last_invoked_at) DESC`;

function pluginUsageByPackId(
  rows: PluginUsageRow[]
): Map<string, { invocations: number; sessions: number }> {
  const byPack = new Map<string, { invocations: number; sessions: number }>();
  for (const row of rows) {
    byPack.set(row.pack_id, {
      invocations: toNumber(row.invocations),
      sessions: toNumber(row.session_count),
    });
  }
  return byPack;
}

/**
 * The set of pack ids a plugin identity rolls its child usage up over: every
 * pack id folded into the identity plus the plugin's own `component_key` (a
 * plugin's own pack_id equals its component_key). Usually a single id.
 */
function pluginPackCandidates(merged: MergedComponent): Set<string> {
  const candidates = new Set<string>(merged.packIds);
  const key = merged.representative.component_key;
  if (key) {
    candidates.add(key);
  }
  return candidates;
}

function resolvePluginUsage(
  merged: MergedComponent,
  pluginUsage: Map<string, { invocations: number; sessions: number }>
): { invocations: number; sessions: number } | undefined {
  let invocations = 0;
  let sessions = 0;
  let matched = false;
  for (const packId of pluginPackCandidates(merged)) {
    const usage = pluginUsage.get(packId);
    if (usage) {
      matched = true;
      invocations += usage.invocations;
      sessions += usage.sessions;
    }
  }
  return matched ? { invocations, sessions } : undefined;
}

/**
 * The set of child session ids per plugin pack id (FEA-3090), so a plugin's
 * KLOC/$ is computed from the SAME child sessions as its rolled-up usage.
 */
function pluginSessionIdsByPackId(
  rows: PluginUsageSessionIdRow[]
): Map<string, Set<string>> {
  const byPack = new Map<string, Set<string>>();
  for (const row of rows) {
    const existing = byPack.get(row.pack_id);
    if (existing) {
      existing.add(row.session_id);
    } else {
      byPack.set(row.pack_id, new Set([row.session_id]));
    }
  }
  return byPack;
}

/**
 * Union of the child session ids a plugin identity rolls up over, across every
 * candidate pack id (mirrors `resolvePluginUsage`). Sessions are deduped by the
 * Set, so a session touching two child packs of the same plugin counts once.
 */
function resolvePluginSessionIds(
  merged: MergedComponent,
  pluginSessionIds: Map<string, Set<string>>
): Set<string> {
  const ids = new Set<string>();
  for (const packId of pluginPackCandidates(merged)) {
    const set = pluginSessionIds.get(packId);
    if (set) {
      for (const id of set) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Per-session child-usage breakdown for a plugin identity, summed across every
 * candidate pack id and merged by session. Mirrors `resolvePluginUsage` (which
 * produces the rolled-up totals) so a plugin's `usageSessions` are drawn from
 * the same source as its `invocations`/`sessions`.
 */
async function resolvePluginUsageSessions(
  prisma: AgentComponentsReadPrisma,
  merged: MergedComponent
): Promise<{ session_id: string; invocation_count: number }[]> {
  const bySession = new Map<string, number>();
  const orderRank = new Map<string, number>();
  let rank = 0;
  for (const packId of pluginPackCandidates(merged)) {
    const rows = await prisma.client.$queryRawUnsafe<
      { session_id: string; invocation_count: bigint | number | null }[]
    >(PLUGIN_USAGE_SESSIONS_SQL, packId);
    for (const row of rows) {
      if (!orderRank.has(row.session_id)) {
        orderRank.set(row.session_id, rank++);
      }
      bySession.set(
        row.session_id,
        (bySession.get(row.session_id) ?? 0) + toNumber(row.invocation_count)
      );
    }
  }
  return [...bySession.entries()]
    .sort((a, b) => (orderRank.get(a[0]) ?? 0) - (orderRank.get(b[0]) ?? 0))
    .map(([session_id, invocation_count]) => ({
      session_id,
      invocation_count,
    }));
}

/**
 * List the local agent-component inventory, projected into the shared
 * `AgentComponentListResponse`. Applies `kinds`/`harness`/`source`/`search`
 * filters in-process and paginates with `limit`/`offset`.
 *
 * `computeTargetId` is this desktop's local compute-target id (resolved by the
 * runtime); when provided it is surfaced as each component's sole
 * `computeTargetIds` entry so the local device shows up as an observing target.
 *
 * `sessionSource` (optional) backs the KLOC/$ column (FEA-3090): when provided,
 * the returned PAGE's rows carry a real `klocPerDollar` computed from their
 * invoking sessions' local-git LOC + cost; without it the column stays null (the
 * honest fallback for callers that cannot resolve local sessions).
 */
export async function listAgentComponentsLocal(
  prisma: AgentComponentsReadPrisma,
  filters: AgentComponentQueryFilters,
  computeTargetId: string | null = null,
  sessionSource?: AgentSessionSyncSource | null
): Promise<AgentComponentListResponse> {
  const [
    inventoryRows,
    usageRows,
    pluginRows,
    unresolvedUsageRows,
    usageSessionIdRows,
    pluginSessionIdRows,
  ] = await Promise.all([
    prisma.client.$queryRawUnsafe<ComponentInventoryRow[]>(INVENTORY_SELECT),
    prisma.client.$queryRawUnsafe<UsageAggregateRow[]>(USAGE_AGGREGATE_SQL),
    prisma.client.$queryRawUnsafe<PluginUsageRow[]>(PLUGIN_USAGE_SQL),
    // FEA-3121: invocations whose source never resolved to a live inventory
    // row. Folded in as synthetic "unresolved" entries so they are counted,
    // not dropped (mirrors the cloud orphan-usage fold).
    prisma.client.$queryRawUnsafe<UnresolvedUsageRow[]>(
      UNRESOLVED_USAGE_AGGREGATE_SQL
    ),
    // FEA-3090: per-identity / per-pack invoking session ids for the KLOC/$
    // metric (id lists only — the heavy per-session LOC/cost load is bounded to
    // the returned page below).
    prisma.client.$queryRawUnsafe<UsageSessionIdRow[]>(USAGE_SESSION_IDS_SQL),
    prisma.client.$queryRawUnsafe<PluginUsageSessionIdRow[]>(
      PLUGIN_USAGE_SESSION_IDS_SQL
    ),
  ]);

  const merged = foldInventory(inventoryRows);
  const usage = usageBySlug(usageRows);
  const pluginUsage = pluginUsageByPackId(pluginRows);
  const sessionIdsBySlug = usageSessionIdsBySlug(usageSessionIdRows);
  const pluginSessionIds = pluginSessionIdsByPackId(pluginSessionIdRows);
  // FEA-3205: anti-join the unresolved-usage candidates against LIVE inventory
  // in APPLICATION CODE, using the identical JS Unicode fold `foldInventory`
  // keyed by (the map's keys ARE the JS-normalized inventory slugs). Doing the
  // anti-join in JS — not SQLite `lower()` — keeps one consistent Unicode fold
  // across the resolved fold and the unresolved surface, so a non-ASCII key
  // (`CAFÉ`) can no longer resolve AND surface as unresolved (double-count).
  const unresolvedUsage = foldUnresolvedUsage(
    unresolvedUsageRows,
    new Set(merged.keys()),
    sessionIdsBySlug
  );

  // FEA-3090: each surfaced component's deduped invoking-session id set, so the
  // KLOC/$ column can be computed for the returned page without re-querying.
  const sessionIdsByComponentId = new Map<string, Set<string>>();

  const all: AgentComponent[] = [];
  for (const entry of merged.values()) {
    const component = buildComponent(
      entry,
      usage.get(entry.slug),
      resolvePluginUsage(entry, pluginUsage),
      computeTargetId
    );
    if (matchesFilters(component, filters)) {
      sessionIdsByComponentId.set(
        component.id,
        component.kind === "plugin"
          ? resolvePluginSessionIds(entry, pluginSessionIds)
          : (sessionIdsBySlug.get(entry.slug) ?? new Set())
      );
      all.push(component);
    }
  }
  // FEA-3121: surface unresolved-source usage identities. A usage identity that
  // shares a slug with a live inventory row is already represented above (the
  // JS anti-join in `foldUnresolvedUsage` excludes it); the remaining rows have
  // NO live inventory row, so they would otherwise vanish and undercount usage.
  for (const row of unresolvedUsage) {
    const component = buildUnresolvedComponent(row);
    if (matchesFilters(component, filters)) {
      // Unresolved components share the usage-slug keying (kind::normalized key),
      // so their invoking sessions come from the same `sessionIdsBySlug` map.
      sessionIdsByComponentId.set(
        component.id,
        sessionIdsBySlug.get(component.id) ?? new Set()
      );
      all.push(component);
    }
  }
  all.sort((a, b) => a.name.localeCompare(b.name));

  const total = all.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? total;
  const items = all.slice(offset, offset + limit);

  // FEA-3090: compute KLOC/$ for the returned page only — load the page's
  // invoking-session LOC/cost once and fill each row's `klocPerDollar`.
  await attachKlocPerDollar(sessionSource, items, sessionIdsByComponentId);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
  };
}

/**
 * FEA-3090: fill the KLOC/$ column for the returned page. Gathers the page's
 * invoking-session ids, loads their local-git LOC + cost in one bounded call,
 * and sets each row's `klocPerDollar` via {@link computeKlocPerDollar}. A no-op
 * (rows keep the built-in null) when no sessions source is wired.
 */
async function attachKlocPerDollar(
  sessionSource: AgentSessionSyncSource | null | undefined,
  items: AgentComponent[],
  sessionIdsByComponentId: Map<string, Set<string>>
): Promise<void> {
  if (!sessionSource || items.length === 0) {
    return;
  }
  const pageSessionIds = new Set<string>();
  for (const item of items) {
    for (const id of sessionIdsByComponentId.get(item.id) ?? []) {
      pageSessionIds.add(id);
    }
  }
  if (pageSessionIds.size === 0) {
    return;
  }
  const locCost = await getSharedAgentSessionLocCostByIds(sessionSource, [
    ...pageSessionIds,
  ]);
  for (const item of items) {
    item.klocPerDollar = computeKlocPerDollar(
      sessionIdsByComponentId.get(item.id) ?? [],
      locCost
    );
  }
}

function buildProperties(row: ComponentInventoryRow): AgentComponentProperties {
  const format = inferFormat(row);
  const properties: AgentComponentProperties = {
    path: row.install_path ?? row.project_path ?? "",
    format,
  };
  const metadata = parseMetadata(row.metadata);
  const model = metadata?.model;
  if (typeof model === "string") {
    properties.model = model;
  }
  return properties;
}

function inferFormat(row: ComponentInventoryRow): string {
  const path = row.install_path ?? "";
  const dot = path.lastIndexOf(".");
  if (dot !== -1 && dot < path.length - 1) {
    return path.slice(dot + 1);
  }
  if (row.component_kind === "mcp") {
    return "json";
  }
  return "md";
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * FEA-3205: the DISTINCT raw `component_key` values in the usage table (for one
 * kind) whose JS Unicode fold (`normalizeComponentKey`) equals `normalizedKey`.
 *
 * The detail path decodes its slug into a JS-normalized key (`decodeComponentSlug`
 * → `normalizeComponentKey`) but then filtered usage with SQL `lower(trim(...))`,
 * which is ASCII-only. For a non-ASCII key (`café` vs a stored `CAFÉ`) the two
 * disagree, so the usage aggregate/session queries returned nothing and a
 * listed component read empty (or 404'd) on detail. Resolving the concrete raw
 * keys in APPLICATION CODE — the same Unicode fold the list uses — and feeding
 * them back as an explicit key list keeps the SQL aggregation (SUM / COUNT
 * DISTINCT) intact while the key MATCH obeys the JS codec. Returns `[]` when no
 * raw key folds to this identity.
 */
async function matchingUsageRawKeys(
  prisma: AgentComponentsReadPrisma,
  kind: string,
  normalizedKey: string
): Promise<string[]> {
  const rows = await prisma.client.$queryRawUnsafe<
    { component_key: string | null }[]
  >(
    `SELECT DISTINCT component_key
      FROM agent_component_session_usage
      WHERE component_kind = ?`,
    kind
  );
  const matched: string[] = [];
  for (const row of rows) {
    if (normalizeComponentKey(row.component_key) === normalizedKey) {
      // The aggregate/session SQL below matches on the trimmed COALESCE of the
      // raw key, so carry an empty string for a NULL key rather than dropping it.
      matched.push(row.component_key ?? "");
    }
  }
  return matched;
}

/**
 * FEA-3205: build a `component_key IN (?, ?, …)` fragment plus its bound params
 * for a concrete list of raw keys resolved in JS (see {@link matchingUsageRawKeys}).
 * The keys are compared trimmed (`trim(COALESCE(component_key, ''))`) so a raw
 * key stored with surrounding whitespace still matches its trimmed variant.
 * Returns a fragment that matches nothing when `rawKeys` is empty.
 */
function rawKeyInClause(rawKeys: string[]): {
  clause: string;
  params: string[];
} {
  if (rawKeys.length === 0) {
    // An empty IN-list is invalid SQL; a false predicate matches no rows.
    return { clause: "1 = 0", params: [] };
  }
  const placeholders = rawKeys.map(() => "?").join(", ");
  return {
    clause: `trim(COALESCE(component_key, '')) IN (${placeholders})`,
    params: rawKeys.map((k) => k.trim()),
  };
}

/**
 * FEA-3121: build the detail for a component that has usage rows but NO live
 * inventory row (source resolution failed). Without this the detail path 404s a
 * component that now legitimately appears in the list via the unresolved-usage
 * fold — a phantom. Assembles the detail directly from the usage rows, tagged
 * `sourceType: "local"` (unresolved). Mirrors the cloud `buildOrphanOnlyDetail`.
 * Returns null only when there is genuinely no usage for this identity (a true
 * 404). `plugin` is never resolved here — plugins have no direct usage rows, so
 * a plugin slug with no inventory row is a real not-found.
 */
async function buildUnresolvedOnlyDetail(
  prisma: AgentComponentsReadPrisma,
  kind: string,
  key: string,
  sessionSource?: AgentSessionSyncSource | null
): Promise<AgentComponentDetail | null> {
  if (kind === "plugin") {
    return null;
  }
  // FEA-3205: resolve the raw usage keys that fold to this identity in JS (the
  // Unicode-aware codec), then filter the SQL aggregates by that concrete key
  // list. A prior `lower(trim(...)) = ?` filter was ASCII-only and diverged from
  // the JS-normalized `key` on non-ASCII identities, so a component visible in
  // the list read empty / 404'd on detail.
  const rawKeys = await matchingUsageRawKeys(prisma, kind, key);
  const keyIn = rawKeyInClause(rawKeys);
  const [aggregateRows, usageSessionRows] = await Promise.all([
    prisma.client.$queryRawUnsafe<UnresolvedUsageRow[]>(
      `SELECT component_kind,
          lower(trim(COALESCE(component_key, ''))) AS component_key,
          COALESCE(SUM(invocations), 0) AS invocations,
          COUNT(DISTINCT session_id) AS session_count,
          MIN(first_invoked_at) AS first_seen_at,
          MAX(last_invoked_at) AS last_seen_at,
          -- Collapse mixed harnesses to the contract 'both' (see
          -- UNRESOLVED_USAGE_AGGREGATE_SQL) so the detail agrees with the list.
          CASE
            WHEN COUNT(DISTINCT harness)
              FILTER (WHERE harness IS NOT NULL) > 1 THEN 'both'
            ELSE MAX(harness)
          END AS harness
        FROM agent_component_session_usage
        WHERE component_kind = ?
          AND ${keyIn.clause}
        GROUP BY component_kind`,
      kind,
      ...keyIn.params
    ),
    prisma.client.$queryRawUnsafe<
      { session_id: string; invocation_count: bigint | number | null }[]
    >(
      `SELECT session_id, COALESCE(SUM(invocations), 0) AS invocation_count
        FROM agent_component_session_usage
        WHERE component_kind = ?
          AND ${keyIn.clause}
        GROUP BY session_id
        ORDER BY MAX(last_invoked_at) DESC`,
      kind,
      ...keyIn.params
    ),
  ]);

  const aggregate = aggregateRows[0];
  if (!aggregate || toNumber(aggregate.session_count) === 0) {
    // No usage for this identity → a genuine not-found.
    return null;
  }

  // FEA-3205: force the JS-normalized identity key so the built component's
  // id/name/source use the same Unicode fold as the list (SQL `lower()` would
  // otherwise leave a non-ASCII letter's case untouched, e.g. `cafÉ`).
  aggregate.component_key = key;
  const base = buildUnresolvedComponent(aggregate);
  const usageSessions = usageSessionRows.map((row) => ({
    sessionId: row.session_id,
    invocationCount: toNumber(row.invocation_count),
  }));
  const sessionIds = usageSessions.map((s) => s.sessionId);
  // One load backs both the sessionsTab projection and the KLOC/$ metric
  // (FEA-3090), matching the cloud `buildOrphanOnlyDetail`. Empty/null when no
  // sessions source is wired.
  const { items: sessionsTab, locCost } =
    await getSharedAgentSessionsWithLocCostByIds(sessionSource, sessionIds);

  return {
    ...base,
    klocPerDollar: computeKlocPerDollar(sessionIds, locCost),
    // mcp definitions are JSON, everything else md (mirrors `inferFormat`'s
    // extension-less fallback for the resolved path).
    properties: {
      path: base.source,
      format: base.kind === "mcp" ? "json" : "md",
    },
    // Unresolved-source components have no inventory row, so there is no
    // definition text to surface.
    prompt: null,
    sessionsTab,
    branchesTab: [],
    // No inventory row ⇒ no per-device install-path/scope provenance.
    provenance: [],
    usageSessions,
  };
}

/**
 * Fetch full detail for one component by its org-identity slug
 * (`${kind}::${normalizedKey}`). When no live inventory row matches, falls back
 * to an unresolved-source detail built from usage rows (FEA-3121); resolves
 * `null` only when there is genuinely no usage either, so the data source raises
 * its canonical 404.
 */
export async function getAgentComponentDetailLocal(
  prisma: AgentComponentsReadPrisma,
  slug: string,
  computeTargetId: string | null = null,
  // Optional local sessions source used to hydrate `sessionsTab` from the
  // session ids that invoked this component (FEA-2923 MEDIUM soul review). When
  // omitted (e.g. legacy callers, or a runtime with no synced sessions yet) the
  // tab falls back to `[]` — the renderer still has `usageSessions` to hydrate.
  sessionSource?: AgentSessionSyncSource | null
): Promise<AgentComponentDetail | null> {
  const parts = decodeComponentSlug(slug);
  if (!parts) {
    return null;
  }

  // FEA-3205: fetch the kind's live inventory and match the identity key in
  // APPLICATION CODE with the JS Unicode fold (`encodeComponentSlug`), instead
  // of a SQL `lower(trim(...)) = ?` predicate that is ASCII-only and diverges
  // from the JS-normalized `parts.key` on a non-ASCII key — which made a
  // component that appears RESOLVED in the list fall through to the unresolved
  // path (or 404) on detail. `foldInventory` keys by the same slug, so filtering
  // to rows whose slug === `slug` yields exactly this identity's rows.
  const kindInventoryRows = await prisma.client.$queryRawUnsafe<
    ComponentInventoryRow[]
  >(
    `${INVENTORY_SELECT}
      AND component_kind = ?`,
    parts.kind
  );
  const inventoryRows = kindInventoryRows.filter(
    (row) =>
      encodeComponentSlug(row.component_kind, row.component_key, row.name) ===
      slug
  );
  if (inventoryRows.length === 0) {
    // FEA-3121: no live inventory row for this identity — the source could not
    // be resolved. Rather than 404, build the detail from usage rows so an
    // unresolved-source component that appears in the list still resolves.
    return buildUnresolvedOnlyDetail(
      prisma,
      parts.kind,
      parts.key,
      sessionSource
    );
  }

  const merged = foldInventory(inventoryRows).get(slug);
  if (!merged) {
    return null;
  }

  // FEA-3123 (perf): `PLUGIN_USAGE_SQL` is a full-table INNER JOIN + GROUP BY
  // over `agent_component_session_usage`, but its result is only ever consumed
  // by `resolvePluginUsage`, which returns undefined for anything that is not a
  // plugin. The kind is already known here, so skip the whole-table aggregate
  // for the common non-plugin case and fall back to an empty pack map.
  const isPlugin = toKind(merged.representative.component_kind) === "plugin";

  // FEA-3205: resolve the raw usage keys that fold to this identity in JS (the
  // same Unicode codec the list uses), then filter the SQL aggregates by that
  // concrete key list. Filtering with SQL `lower(trim(...)) = ?` against the
  // JS-normalized `parts.key` was ASCII-only, so on a non-ASCII identity the
  // usage/session rows came back empty and the detail undercounted (or, for an
  // unresolved identity, 404'd) even though the list surfaced real usage.
  const rawUsageKeys = await matchingUsageRawKeys(
    prisma,
    parts.kind,
    parts.key
  );
  const usageKeyIn = rawKeyInClause(rawUsageKeys);

  const [usageRows, pluginRows, usageSessionRows] = await Promise.all([
    prisma.client.$queryRawUnsafe<UsageAggregateRow[]>(
      // Aggregate over the JS-resolved raw key list (matching the inventory
      // lookup above and the list path) so the detail endpoint reads the same
      // distinct-session union the list endpoint does. This spans every colliding
      // raw variant — casing/whitespace AND non-ASCII case (`CAFÉ`/`café`).
      `SELECT component_kind,
          COALESCE(SUM(invocations), 0) AS invocations,
          COUNT(DISTINCT session_id) AS session_count
        FROM agent_component_session_usage
        WHERE component_kind = ?
          AND ${usageKeyIn.clause}
        GROUP BY component_kind`,
      parts.kind,
      ...usageKeyIn.params
    ),
    isPlugin
      ? prisma.client.$queryRawUnsafe<PluginUsageRow[]>(PLUGIN_USAGE_SQL)
      : Promise.resolve<PluginUsageRow[]>([]),
    prisma.client.$queryRawUnsafe<
      { session_id: string; invocation_count: bigint | number | null }[]
    >(
      // Same JS-resolved key list (see above): the per-session breakdown must
      // span every colliding raw variant so it stays consistent with the
      // rolled-up `sessions` total.
      `SELECT session_id, COALESCE(SUM(invocations), 0) AS invocation_count
        FROM agent_component_session_usage
        WHERE component_kind = ?
          AND ${usageKeyIn.clause}
        GROUP BY session_id
        ORDER BY MAX(last_invoked_at) DESC`,
      parts.kind,
      ...usageKeyIn.params
    ),
  ]);

  // The aggregate SQL already filters to this one identity (the JS-resolved raw
  // key list) and groups by kind, so it returns at most one row — read it
  // directly rather than re-keying by a slug the SELECT no longer carries.
  const usageRow = usageRows[0];
  const usage = usageRow
    ? {
        invocations: toNumber(usageRow.invocations),
        sessions: toNumber(usageRow.session_count),
      }
    : undefined;
  const pluginUsage = pluginUsageByPackId(pluginRows);
  const base = buildComponent(
    merged,
    usage,
    resolvePluginUsage(merged, pluginUsage),
    computeTargetId
  );

  // A plugin's per-session breakdown must come from the SAME child-usage source
  // as its rolled-up `invocations` total (plugins have no direct usage rows, so
  // `usageSessionRows` above is empty for them). Query the child usage grouped
  // by session across every pack id folded into this plugin identity.
  const pluginUsageSessions =
    base.kind === "plugin"
      ? await resolvePluginUsageSessions(prisma, merged)
      : null;

  // Provenance is per-device. On the desktop every inventory row for this
  // identity was observed by THIS device, so each entry's `computeTargetId` is
  // the local compute-target id (matching the cloud, which uses the real
  // ComputeTarget id — never the inventory row's own primary key: `row.id` is a
  // content hash of the component definition, NOT a compute-target id, and
  // emitting it silently poisons any per-device grouping). When the runtime
  // cannot resolve a local compute-target id we emit an honest empty string
  // ("unknown local device") rather than the misleading hash — while still
  // surfacing the per-row install-path/scope provenance, which is useful
  // independently of the device id.
  const provenance = inventoryRows.map((row) => ({
    computeTargetId: computeTargetId ?? "",
    ...(row.install_path ? { installPath: row.install_path } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.project_path ? { projectPath: row.project_path } : {}),
  }));

  const usageSessions = (pluginUsageSessions ?? usageSessionRows).map(
    (row) => ({
      sessionId: row.session_id,
      invocationCount: toNumber(row.invocation_count),
    })
  );

  // Hydrate `sessionsTab` from the session ids that invoked this component,
  // projecting each into a full `AgentSessionListItem` via the shared local
  // sessions read path (the same `mapListItem` projection the Sessions list
  // uses). This matches the cloud, which populates `sessionsTab` off
  // `listByArtifactIds`, instead of hardcoding `[]`. When no sessions source is
  // wired the tab stays empty and the renderer still has `usageSessions` to
  // hydrate (FEA-2923 MEDIUM soul review).
  const sessionIds = usageSessions.map((s) => s.sessionId);
  // One load backs both the sessionsTab projection and the KLOC/$ metric: the
  // same value the list column shows and the cloud detail computes, deduped by
  // session id. Plugins use their child-usage sessions (`pluginUsageSessions`).
  // Empty/null when no sessions source is wired (FEA-3090).
  const { items: sessionsTab, locCost } =
    await getSharedAgentSessionsWithLocCostByIds(sessionSource, sessionIds);

  return {
    ...base,
    klocPerDollar: computeKlocPerDollar(sessionIds, locCost),
    properties: buildProperties(merged.representative),
    prompt:
      base.kind === "hook" || base.kind === "config"
        ? null
        : (merged.representative.description ?? null),
    sessionsTab,
    branchesTab: [],
    provenance,
    usageSessions,
  };
}
