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

// ISS-4403 (wongk): the SSOT definition-fingerprint used to WRITE
// `agent_component_session_usage.component_version_hash` at invocation time (via
// `agent_component_invocations.definition_hash`). A pure, dependency-free hash
// leaf — safe to import into the DB-host process. See `definitionUsageHash`.
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
// Types AND runtime values from one module. The values are imported as values,
// not types, so `KNOWN_KINDS` / `KNOWN_HARNESSES` derive from the const-object
// enums via `Object.values` and can never drift when a kind/harness is added.
// This module is a pure types + const leaf (its own imports are all
// `import type`), so it adds no pglite boot side effects.
import {
  AGENT_COMPONENT_INVENTORY_CAP,
  type AgentComponent,
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  type AgentComponentProperties,
  type AgentComponentQueryFilters,
  ComponentResolvedState,
  Harness,
  isLocPerDollarVerifiableKind,
  SourceType,
} from "@repo/api/src/types/agent-component";
// Cross-surface org-identity slug codec (SSOT). This is a pure-string leaf with
// no imports, so the runtime value import stays out of the pglite boot path
// (cf. #1618/#1620) — do NOT widen this to a barrel `@repo/api` import.
import {
  decodeComponentHashKey,
  encodeComponentSlug,
  fingerprintIdentityKey,
  normalizeComponentKey,
  resolveVersionFingerprint,
  routableComponentHashKey,
  shortFingerprint,
  usageVersionIdentityKey,
} from "@repo/api/src/types/agent-component-analytics";
// Cross-surface Properties builder (SSOT) — another pure leaf, kept out of the
// barrel import for the same pglite-boot reason as the slug codec above.
import { buildComponentProperties } from "@repo/api/src/types/agent-component-properties";
// Canonical empty cohort-metrics constant (SSOT next to the `CohortDeliveryMetrics`
// type it satisfies) — the desktop-LOCAL detail has no org baseline, so these
// fields are always empty here; the cloud reader populates them for web/overlay.
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
// FEA-3704: shared org-level resolution fold (SSOT with the cloud service) — the
// precedence + fold live in `component-resolution` so this desktop dashboard and
// `apps/api` share ONE implementation. A pure types/const + pure-function leaf
// (its only imports are pure leaves), so the runtime import stays out of the
// pglite boot path — do NOT widen this to a barrel `@repo/api` import.
import { foldResolvedState } from "@repo/api/src/types/component-resolution";
// ISS-6232: the cross-surface `source` derivation (SSOT with the cloud detail
// read). Another pure types/const + pure-function leaf, so the runtime import
// stays out of the pglite boot path — do NOT widen to a barrel `@repo/api`.
import { unionComponentSourceProvenance } from "@repo/api/src/types/component-source";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
// FEA-3633: shared per-branch LOC-dedup helper (SSOT with the cloud aggregations)
// — a pure-function leaf, so the runtime import stays out of the pglite boot path.
import {
  type SessionLocEntry,
  sumSessionLocDedupedByBranch,
} from "@repo/api/src/utils/session-loc";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import type { BranchDefaultEligibilitySource } from "../branch/shared-branches-default-eligibility.js";
// ISS-6094: the kind LIST is the cross-surface contract in `@repo/api`, but
// rendering it into SQLite text is persistence, so it lives with the other SQL
// helpers. The three rollups below and `packs/component-scanner.ts` read it.
import {
  maxIso,
  minIso,
  PLUGIN_CHILD_KINDS_SQL_LIST,
  numberOrZero as toNumber,
} from "../database/db-helpers.js";
import type { DbHostPrisma } from "../database/prisma-client.js";
import type { SharedAgentSessionLocCost } from "../session/session-loc-cost.js";
import {
  getSharedAgentSessionLocCostByIds,
  getSharedAgentSessionsWithLocCostByIds,
} from "../session/shared-agent-sessions-api.js";
// ISS-5009: the whole Source-column projection — legacy `toSourceType`/
// `displaySource` plus the honest provenance resolver — lives in one sibling
// module, so a change to either is made next to the other.
import {
  displaySource,
  honestSourceOf,
  noProvenanceHonestSource,
  sourceProvenanceOf,
  toSourceType,
} from "./agent-component-honest-source.js";
// ISS-5534: the plugin pack-identity pair (`pluginPackCandidates` and the wire
// `emitPackIdentity` built from it) lives in its own sibling module — the
// desktop mirror of `apps/api/app/agent-components/plugin-child-usage.ts`.
import {
  emitPackIdentity,
  pluginPackCandidates,
  resolvePluginUsage,
} from "./agent-component-pack-identity.js";
// ISS-6232: the content-hash version-history read is its own sibling module —
// the desktop twin of the cloud's `detail-version-history.ts`.
import { readComponentVersions } from "./agent-component-versions-read.js";
import { collapseLocalFamilies } from "./agent-components-family-collapse.js";
import {
  rawKeyInClause,
  unresolvedUsagePredicate,
  versionHashScopeClause,
} from "./hash-scope-predicates.js";
import { localDetailSessionTabs } from "./local-detail-session-tabs";
import { readAgentComponentInvocationPage } from "./local-invocation-read.js";

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
  content: string | null;
  content_hash: string | null;
  // F1 (FEA-3290) honest resolution state, synced from the cloud
  // `AgentComponent.resolvedState` and set locally by the definition-content
  // collector. May be NULL for legacy rows synced before the column existed
  // (treated as `unresolved` — see `foldResolvedState`).
  resolved_state: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

type UsageAggregateRow = {
  component_kind: string;
  component_key: string;
  // FEA-3982 (wongk decision): the version hash this usage bucket ran against, so
  // usage attributes to the MATCHING fingerprint bucket rather than being applied
  // to every same-named version. NULL for a hash-less (version-agnostic) row,
  // which stays on the name-level bucket (skew-safe). The desktop store has no
  // `definition_version_id`, so it attributes on `component_version_hash` alone —
  // the same fallback the cloud takes for a still-unlinked usage row.
  component_version_hash: string | null;
  invocations: bigint | number | null;
  session_count: bigint | number | null;
  last_invoked_at: string | null;
};

type PluginUsageRow = {
  pack_id: string;
  invocations: bigint | number | null;
  session_count: bigint | number | null;
  last_invoked_at: string | null;
};

/**
 * Per-identity usage totals joined onto a component. `lastInvokedAt` is the max
 * usage `last_invoked_at` across the folded rows — the real usage-recency signal
 * the "recently active" indicator keys off (FEA-3179), distinct from the
 * inventory-observation `lastSeenAt` the pack scanner refreshes on every sync.
 * Null when no usage rows folded in (FEA-3310).
 */
type UsageTotals = {
  invocations: number;
  sessions: number;
  lastInvokedAt: string | null;
};

// Derived from the canonical `AgentComponentKind` const object (SSOT) so a new
// kind added there is recognized on desktop automatically — never a separately
// maintained mirror that silently drifts, coercing an unlisted kind to `config`
// in `toKind()`. This intentionally includes the observable-only kinds `tool`
// (FEA-3048) and `orchestration` (FEA-2642): without them `toKind()` would
// collapse those rows to `config` (the "Memory & config" bucket). They remain
// observable, not distributable — keep them OUT of any promote/catalog list.
const KNOWN_KINDS: ReadonlySet<string> = new Set(
  Object.values(AgentComponentKind)
);

// The set of harness values a caller may FILTER the inventory by — derived from
// the canonical display `Harness` const object (SSOT) so a new display harness
// is accepted automatically. This gates the `harness` query param only (see
// below); it deliberately does NOT gate `toHarness()`, which passes any stored
// harness through so a real value is never coerced to `claude` (FEA-4028).
const KNOWN_HARNESSES: ReadonlySet<string> = new Set(Object.values(Harness));

function toKind(value: string): AgentComponentKind {
  return (
    KNOWN_KINDS.has(value) ? value : AgentComponentKind.Config
  ) as AgentComponentKind;
}

// Coerce a stored `agent_components.harness` / usage-rollup harness string to
// the display `Harness` union. Only a NULL / blank value defaults to `claude`
// (the pre-existing default for a genuinely harness-less row). A non-empty
// stored value passes through as-is — even one outside the display contract's
// {claude,codex,both}, e.g. a `cursor`/`copilot`/`opencode` session harness the
// live collectors persist (FEA-4028, wongk review). Coercing those to `claude`
// is exactly the misattribution this fix removes: we never silently relabel a
// real harness. This mirrors the cloud `normalizeHarness`
// (apps/api/app/agent-components/harness-attribution.ts), which passes an
// unknown stored harness through for the same reason; the union is widened at
// the boundary exactly as the pre-fix `as Harness` cast did.
function toHarness(value: string | null): Harness {
  const trimmed = value?.trim();
  return (trimmed ? trimmed : Harness.Claude) as Harness;
}

/**
 * LOC/$ for one component = (authored local-git lines produced by the sessions
 * that invoked it) / (their summed estimated cost) — ISS-4667: raw lines per
 * dollar, no divide-by-1000. Sessions are deduped by id (a component can carry
 * multiple usage rows per session, so each session's LOC + cost must count
 * exactly once). Returns null when the summed cost is 0 or the sessions produced
 * no measurable lines (never a fabricated or divide-by-zero number).
 *
 * Ported from the cloud reader (`computeLocPerDollar` in
 * apps/api/app/agent-components/loc-per-dollar.ts) and sharing its SSOT ratio,
 * so the desktop "LOC / $" column agrees with the web column (FEA-3090).
 */
function computeLocPerDollar(
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): number | null {
  // FEA-3633: LOC is deduped PER BRANCH (mirrors the cloud twin in
  // apps/api/app/agent-components/service.ts) — a branch whose LOC came from the
  // branch/PR-total fallback contributes its total once, not once per authoring
  // session. Commit-sourced LOC sums per-session; cost always sums per-session.
  const locEntries: SessionLocEntry[] = [];
  let totalCost = 0;
  const seen = new Set<string>();
  for (const sessionId of sessionIds) {
    // Dedup by session id first (a component can carry multiple usage rows per
    // session, but each session's LOC + cost must count at most once here).
    if (seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    const entry = locCostBySession.get(sessionId);
    if (!entry) {
      continue;
    }
    locEntries.push({
      loc: entry.loc,
      locSource: entry.locSource,
      repositoryFullName: entry.repositoryFullName,
      branch: entry.branch,
    });
    totalCost += entry.cost;
  }
  const totalLoc = sumSessionLocDedupedByBranch(locEntries);
  // ISS-4667: raw lines per dollar via the shared SSOT — NO divide-by-1000, and
  // its guards return null (never a fabricated 0) for zero cost / zero lines.
  return locPerDollarFromLines(totalLoc, totalCost);
}

/**
 * FEA-4052: LOC/$ for one component GATED on its kind's per-component
 * attribution reliability ({@link isLocPerDollarVerifiableKind}) — the desktop-local
 * twin of the cloud `locPerDollarForKind` in
 * apps/api/app/agent-components/loc-per-dollar.ts. A non-verifiable kind returns
 * null so the desktop surface hides LOC/$ exactly as the web does. Only `subagent` is
 * verifiable today; skill/command are excluded until a session can be
 * partitioned across its co-invoked components (wongk, PR #3720).
 */
function locPerDollarForKind(
  kind: string,
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SharedAgentSessionLocCost>
): number | null {
  if (!isLocPerDollarVerifiableKind(kind as AgentComponentKind)) {
    return null;
  }
  return computeLocPerDollar(sessionIds, locCostBySession);
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
  // NOTE: the `collaborator` (author) filter is intentionally NOT accepted here.
  // FEA-4098 (Slice 3): desktop-local reads have no DefinitionVersion authors
  // lineage (every component's `collaborators` is empty — that join is
  // cloud-side), so honoring a collaborator filter would silently exclude every
  // row. Dropping it keeps the local surface from applying a filter that can
  // only match nothing.
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
  // FEA-3196: the USAGE time window backing the Agents workspace's
  // All/30/60/90-day control. Accepted here so the desktop honors the same
  // window the cloud reader does (FEA-3160/FEA-3178) — without these, the
  // shared `AgentsGroupedList` (which desktop mounts) passed `startDate` over
  // IPC only for it to be silently dropped, making the control a no-op that
  // always returned the all-time inventory.
  //
  // Permissive like the cloud validator (`isoDateQuerySchema` in
  // apps/api/app/agent-components/validators.ts): any `Date.parse`-able string,
  // so the bare-date form the date control can emit (`2026-07-14`) is accepted,
  // not just a full timestamp. An unparseable bound is DROPPED rather than
  // throwing — an untrusted IPC payload must not be able to fail the read, and
  // a dropped bound degrades to the all-time view this surface showed before.
  const startDate = coerceIsoBound(raw.startDate);
  if (startDate) {
    filters.startDate = startDate;
  }
  const endDate = coerceIsoBound(raw.endDate);
  if (endDate) {
    filters.endDate = endDate;
  }
  return filters;
}

/**
 * FEA-3196: normalize one untrusted usage-window bound to a canonical
 * `toISOString()` value, or undefined when absent/unparseable.
 *
 * Canonicalizing here (rather than passing the raw string through to SQL) is
 * what makes the lexicographic comparison in {@link usageWindowClause} correct:
 * `last_invoked_at` is TEXT holding `toISOString()` values, so a bound must be
 * in that same canonical shape to order against them. It also matches the cloud
 * reader, which parses each bound with `new Date(value)` before comparing —
 * so a bare `2026-07-14` means midnight UTC on both surfaces.
 */
function coerceIsoBound(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return;
  }
  return new Date(parsed).toISOString();
}

/**
 * Fold multiple inventory rows for the same org-identity slug into a single
 * canonical representative, tracking the earliest/latest seen timestamps.
 */
type MergedComponent = {
  // Name-only org-identity slug (`kind::normalizedKey`) — the detail/nav key. A
  // name can now own SEVERAL merged entries (one per distinct content version,
  // FEA-3982); `slug` stays name-level while the MAP is keyed by the fingerprint
  // identity key so two versions do not collide (see `foldInventory`).
  slug: string;
  // FEA-3982 (Slice 2): the exact-version fingerprint this identity was bucketed
  // on (`content_hash`), or null for a hash-less legacy/event-minted row. Backs
  // the emitted `versionId` + short `fingerprint` badge so two same-named /
  // different-bytes components are distinguishable on desktop exactly as they are
  // on the cloud list (P1 parity — foldInventory used to key by slug ALONE, so
  // web split the versions while Electron collapsed them into one row).
  versionFingerprint: string | null;
  representative: ComponentInventoryRow;
  packIds: Set<string>;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  // F1 (FEA-3704): the honest org-level resolution state, folded across every
  // device row for this identity — no longer hardcoded to `unresolved`. Seeded
  // from the representative and widened by `foldResolvedState`.
  resolvedState: ComponentResolvedState;
};

/**
 * F1 (FEA-3704): narrow a raw `resolved_state` column value (which may be NULL
 * for legacy rows, or an unrecognized string) to the canonical
 * `ComponentResolvedState`. An unknown/absent value is honestly `unresolved`
 * (the DB column default) — NEVER silently promoted to `resolved`.
 */
const KNOWN_RESOLVED_STATES: ReadonlySet<string> = new Set<string>(
  Object.values(ComponentResolvedState)
);
function toResolvedState(raw: string | null): ComponentResolvedState {
  return raw !== null && KNOWN_RESOLVED_STATES.has(raw)
    ? (raw as ComponentResolvedState)
    : ComponentResolvedState.Unresolved;
}

/**
 * FEA-3982 (Slice 2): fold inventory rows into org-level identities keyed by the
 * fingerprint identity key (`slug@fingerprint`, or the bare `slug` when the row
 * is hash-less) — mirroring the cloud `mergeComponentRows`
 * (apps/api/app/agent-components/identity.ts). Two same-named components with
 * DIFFERENT `content_hash` therefore split into two rows instead of collapsing;
 * the previous slug-only keying is exactly the divergence the P1 review flagged
 * (web split them, desktop merged them). `slug` stays name-only on each entry so
 * detail/nav round-trips and the name-keyed sibling lanes (`usageBySlug`, the
 * unresolved anti-join) still join by name.
 *
 * The returned map's KEYS are fingerprint identity keys; consumers that need the
 * name-only inventory-slug set must read each entry's `.slug`, NOT the map keys.
 */
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
    const fingerprint = resolveVersionFingerprint(row.content_hash);
    const identityKey = fingerprintIdentityKey(slug, fingerprint);
    const existing = merged.get(identityKey);
    if (existing) {
      if (row.pack_id) {
        existing.packIds.add(row.pack_id);
      }
      existing.firstSeenAt = minIso(existing.firstSeenAt, row.first_seen_at);
      existing.lastSeenAt = maxIso(existing.lastSeenAt, row.last_seen_at);
      existing.resolvedState = foldResolvedState(
        existing.resolvedState,
        toResolvedState(row.resolved_state)
      );
      continue;
    }
    merged.set(identityKey, {
      slug,
      versionFingerprint: fingerprint,
      representative: row,
      packIds: new Set(row.pack_id ? [row.pack_id] : []),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      resolvedState: toResolvedState(row.resolved_state),
    });
  }
  return merged;
}

/**
 * The first seeded bucket whose name-level `slug` matches, or null. FEA-3982:
 * `foldInventory` keys by the fingerprint identity key (`slug@fingerprint`), so a
 * name-only `.get(slug)` misses a hashed row. The detail read aggregates across a
 * name's versions, so any bucket for the name is a fine representative source.
 */
function firstBucketForSlug(
  merged: Map<string, MergedComponent>,
  slug: string
): MergedComponent | null {
  // Fast path: a hash-less identity is keyed by the bare slug.
  const direct = merged.get(slug);
  if (direct) {
    return direct;
  }
  for (const entry of merged.values()) {
    if (entry.slug === slug) {
      return entry;
    }
  }
  return null;
}

/**
 * Usage totals keyed by the fingerprint identity key
 * (`usageVersionIdentityKey(slug, component_version_hash)`) for O(1) join to the
 * matching version bucket. FEA-3982 (wongk decision): usage attributes to the
 * version it ran against — `slug@hash` when the usage carried a hash, or the
 * name-level `slug` bucket when hash-less (skew-safe) — mirroring the cloud fold.
 * Previously this keyed name-only, so the same total was applied to EVERY
 * same-named version bucket.
 *
 * `USAGE_AGGREGATE_SQL` groups by (kind, normalized key, version hash), so each
 * (identity, hash) maps to exactly one row: its distinct-session count is a
 * per-version SQL union, never a sum of per-variant counts. The accumulate branch
 * is a defensive fallback for the impossible case of two rows folding to one
 * identity key; invocations stay additive to match `foldInventory` and the cloud.
 */
function usageBySlug(rows: UsageAggregateRow[]): Map<string, UsageTotals> {
  const byIdentity = new Map<string, UsageTotals>();
  for (const row of rows) {
    const slug = encodeComponentSlug(
      row.component_kind,
      row.component_key,
      null
    );
    const identityKey = usageVersionIdentityKey(
      slug,
      row.component_version_hash
    );
    const existing = byIdentity.get(identityKey);
    if (existing) {
      existing.invocations += toNumber(row.invocations);
      existing.sessions += toNumber(row.session_count);
      existing.lastInvokedAt = maxIso(
        existing.lastInvokedAt,
        row.last_invoked_at
      );
    } else {
      byIdentity.set(identityKey, {
        invocations: toNumber(row.invocations),
        sessions: toNumber(row.session_count),
        lastInvokedAt: row.last_invoked_at,
      });
    }
  }
  return byIdentity;
}

/**
 * FEA-3982 (wongk decision): synthesize version buckets for usage that carries a
 * hash whose version was NOT seeded by a live inventory row — the common
 * hash-at-invocation ≠ current-inventory-hash case (a component updated A→B keeps
 * the SINGLE inventory row on B, but historical sessions carried A). Without
 * this, that A usage would attach to no version bucket AND be excluded from the
 * name-only unresolved lane (its name IS in inventory), silently vanishing.
 * Mirrors the cloud `foldFkUsageIntoMerged`/`foldOrphanUsageIntoMerged` synthesis
 * of a version bucket keyed on the usage row's own hash. Only versioned usage
 * whose name already has a live inventory bucket is synthesized here; a name with
 * NO inventory at all stays the unresolved lane's job. The borrowed representative
 * (from the same name's first inventory bucket) carries honest name/source/kind;
 * only the fingerprint differs. Bounded by the inventory cap.
 */
function synthesizeUsageVersionBuckets(
  merged: Map<string, MergedComponent>,
  usageRows: UsageAggregateRow[]
): void {
  // Index one representative per NAME slug so a synthetic version bucket borrows
  // honest name/source/kind from a real same-name inventory row.
  const representativeBySlug = new Map<string, MergedComponent>();
  for (const entry of merged.values()) {
    if (!representativeBySlug.has(entry.slug)) {
      representativeBySlug.set(entry.slug, entry);
    }
  }
  for (const row of usageRows) {
    const fingerprint = resolveVersionFingerprint(row.component_version_hash);
    // Hash-less usage folds into the name-level bucket, handled by usageBySlug.
    if (fingerprint === null) {
      continue;
    }
    const slug = encodeComponentSlug(
      row.component_kind,
      row.component_key,
      null
    );
    const identityKey = fingerprintIdentityKey(slug, fingerprint);
    if (merged.has(identityKey)) {
      continue;
    }
    // Only synthesize for a name that already has live inventory; a name with no
    // inventory at all is the unresolved lane's responsibility (name-only).
    const base = representativeBySlug.get(slug);
    if (!base || merged.size >= AGENT_COMPONENT_INVENTORY_CAP) {
      continue;
    }
    merged.set(identityKey, {
      slug,
      versionFingerprint: fingerprint,
      representative: base.representative,
      packIds: new Set(base.packIds),
      firstSeenAt: null,
      lastSeenAt: null,
      resolvedState: base.resolvedState,
    });
  }
}

/** One distinct (component identity, version hash, session id) usage pair. */
type UsageSessionIdRow = {
  component_kind: string;
  component_key: string;
  // FEA-3982 (wongk decision): the version hash the session ran against, so the
  // resolved lane's LOC/$ session set is per-version too. NULL ⇒ name-level.
  component_version_hash: string | null;
  session_id: string;
};

/** Add a session id to a keyed set, creating the set on first insert. */
function addSessionId(
  map: Map<string, Set<string>>,
  key: string,
  sessionId: string
): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(sessionId);
  } else {
    map.set(key, new Set([sessionId]));
  }
}

/**
 * The set of invoking session ids per identity (FEA-3090), keyed BOTH ways from
 * one query: the `byVersion` map is keyed by the fingerprint identity key
 * (`usageVersionIdentityKey(slug, hash)`) for the resolved-inventory version
 * buckets (FEA-3982 — wongk), and the `byName` map is keyed name-only
 * (`${kind}::${normalized key}`) for the unresolved-source lane and
 * {@link foldUnresolvedUsage}. Both feed the per-session dedup in
 * {@link computeLocPerDollar}.
 */
function usageSessionIdsBySlug(rows: UsageSessionIdRow[]): {
  byVersion: Map<string, Set<string>>;
  byName: Map<string, Set<string>>;
} {
  const byVersion = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  for (const row of rows) {
    const slug = encodeComponentSlug(
      row.component_kind,
      row.component_key,
      null
    );
    addSessionId(
      byVersion,
      usageVersionIdentityKey(slug, row.component_version_hash),
      row.session_id
    );
    addSessionId(byName, slug, row.session_id);
  }
  return { byVersion, byName };
}

function buildComponent(
  merged: MergedComponent,
  usage: UsageTotals | undefined,
  pluginUsage: UsageTotals | undefined,
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
  const isPlugin = kind === AgentComponentKind.Plugin;
  const resolved = isPlugin ? pluginUsage : usage;
  // FEA-4335: the routable detail key is content-hash-based
  // (`${kind}::${versionFingerprint}`, or the name-level slug when the row has no
  // captured content hash) — mirroring the cloud list emit
  // (apps/api/app/agent-components/service.ts). Two same-named-different-bytes
  // components emit DISTINCT slugs so their detail URIs no longer collide.
  const routableKey = routableComponentHashKey(
    row.component_kind,
    merged.versionFingerprint,
    row.component_key,
    row.name
  );
  return {
    id: routableKey,
    slug: routableKey,
    name: row.name ?? row.component_key ?? row.external_id,
    kind,
    sourceType: toSourceType(row),
    source: displaySource(row),
    // ISS-5009: the honest projection rides ALONGSIDE the legacy pair above,
    // never in place of it — `source`/`sourceType` stay byte-identical so the
    // flag-OFF render and every older reader are unchanged.
    honestSource: honestSourceOf(row, kind),
    harness: toHarness(row.harness),
    invocations: resolved?.invocations ?? 0,
    sessions: resolved?.sessions ?? 0,
    // ISS-5534 (wongk review on #4902): the parent-pack identity, additive and
    // optional, mirroring the cloud list emit (`emitPackIdentity`). A plugin
    // emits the SAME candidate set `resolvePluginUsage` summed its total over,
    // so a consumer can drop a plugin's rollup only when THAT plugin's own
    // children are in view. Omitted (never `[]`) when there is nothing to say.
    ...emitPackIdentity(merged, isPlugin),
    locPerDollar: null,
    trend: [],
    // FEA-4098 (Slice 3): desktop-local reads have no org-wide DefinitionVersion
    // lineage to attribute authors from (that join lives cloud-side), so the
    // authors people-set is intentionally empty. `computeTargetIds` IS populated
    // with this device's local compute-target id when the runtime can resolve
    // it, so the local device shows up as an observing target like the cloud.
    collaborators: [],
    // FEA-3982 (Slice 2): the exact-version fingerprint + short badge, mirroring
    // the cloud list (apps/api/app/agent-components/service.ts). Both omitted
    // (never null) for a hash-less legacy/event-minted row so absence stays
    // skew-safe "unversioned / name-only" on the wire and old readers ignore it.
    ...(merged.versionFingerprint
      ? {
          versionId: merged.versionFingerprint,
          fingerprint: shortFingerprint(merged.versionFingerprint) ?? undefined,
        }
      : {}),
    computeTargetIds: computeTargetId ? [computeTargetId] : [],
    firstSeenAt: merged.firstSeenAt ?? row.first_seen_at ?? "",
    lastSeenAt: merged.lastSeenAt ?? row.last_seen_at ?? "",
    // Real usage-recency (max usage `last_invoked_at`), distinct from the
    // sync-refreshed inventory `lastSeenAt` — the "recently active" indicator
    // keys off this (FEA-3179). Omitted when the component has no usage rows,
    // matching the cloud reader (apps/api/app/agent-components/service.ts).
    ...(resolved?.lastInvokedAt
      ? { lastInvokedAt: resolved.lastInvokedAt }
      : {}),
  };
}

/**
 * Kinds EXEMPT from the zero-in-window drop, so a component with no usage in
 * the requested window is not erased from the inventory. `config` is pure
 * inventory (never invoked). `hook` firings ARE now captured (FEA-4093), but
 * hooks are kept exempt so a genuinely never-fired hook stays a knowable
 * inventory row rather than vanishing under a window — dropping on a zero
 * window would erase the entire kind rather than hide one inactive component.
 * Mirrors `NON_USAGE_TRACKED_KINDS` in the cloud reader
 * (apps/api/app/agent-components/service.ts).
 */
const NON_USAGE_TRACKED_KINDS: ReadonlySet<string> = new Set<string>([
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
]);

/**
 * FEA-3196: with a usage window requested, a usage-tracked component that had
 * ZERO usage inside the window is not part of that window's inventory — keeping
 * it would make 30/60/90 return the same rows as All (the exact no-op this
 * fixes). No window ⇒ never drops, so the all-time view keeps its zero-usage
 * rows and stays identical to before. Mirrors the cloud `dropZeroWindowUsage`.
 */
function isZeroInWindow(component: AgentComponent, windowed: boolean): boolean {
  if (!windowed || NON_USAGE_TRACKED_KINDS.has(component.kind)) {
    return false;
  }
  return component.invocations === 0 && component.sessions === 0;
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
    metadata, content, content_hash, resolved_state, first_seen_at, last_seen_at
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
/**
 * FEA-3196: the USAGE time window (the Agents workspace's All/30/60/90-day
 * control). Bounds are canonical `toISOString()` strings — see
 * {@link coerceIsoBound}. Both absent ⇒ the all-time view: every lane then
 * renders with no window predicate and no bindings, leaving the default surface
 * behaviorally unchanged. Mirrors the cloud `UsageWindow`
 * (apps/api/app/agent-components/service.ts).
 */
type UsageWindow = { start?: string; end?: string };

/** One raw SQL query plus its positional bindings. */
type UsageQuery = { sql: string; params: string[] };

function toUsageWindow(filters: AgentComponentQueryFilters): UsageWindow {
  return { start: filters.startDate, end: filters.endDate };
}

function hasUsageWindow(window: UsageWindow): boolean {
  return Boolean(window.start || window.end);
}

/**
 * `last_invoked_at` is TEXT (`String?` in the desktop schema) and is not
 * schema-enforced ISO: it is written as `MAX(events.created_at)` (and friends),
 * which is NULL when a row has no timestamped invocation, and whose string form
 * is passed through un-normalized by `isoTs`. A row that fails this date-prefix
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
 * FEA-3196: the `last_invoked_at` bound(s) for a usage lane, as SQL conditions
 * plus their bindings. Lexicographic comparison against canonical ISO bounds —
 * the desktop convention for ISO text columns (see sync-source.ts); NOT
 * `julianday()`, which sync-source.ts documents as drifting.
 *
 * Every usage lane feeding the list must apply this, or the windowed and
 * all-time reads disagree with each other within a single response.
 */
function usageWindowClause(window: UsageWindow): {
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
    conditions.push("acsu.last_invoked_at >= ?");
    params.push(window.start);
  }
  if (window.end) {
    conditions.push("acsu.last_invoked_at <= ?");
    params.push(window.end);
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

function usageAggregateSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    acsu.component_kind AS component_kind,
    lower(trim(COALESCE(acsu.component_key, ''))) AS component_key,
    -- FEA-3982 (wongk decision): group usage by the version hash it ran against
    -- so it attributes to the MATCHING fingerprint bucket, not every same-named
    -- version. The natural key pins one hash per (session, kind, key, branch), so
    -- this only splits groups that carried different hashes — the summed
    -- invocation totals and distinct-session counts are unchanged.
    acsu.component_version_hash AS component_version_hash,
    COALESCE(SUM(acsu.invocations), 0) AS invocations,
    COUNT(DISTINCT acsu.session_id) AS session_count,
    -- FEA-3310: real usage-recency for the "recently active" indicator, as its
    -- OWN column (never folded into last_seen_at). Mirrors the cloud reader's
    -- max usage lastInvokedAt (apps/api/app/agent-components/service.ts).
    MAX(acsu.last_invoked_at) AS last_invoked_at
  FROM agent_component_session_usage acsu
  ${whereClause(conditions)}
  GROUP BY acsu.component_kind, lower(trim(COALESCE(acsu.component_key, ''))), acsu.component_version_hash`,
    params,
  };
}

// FEA-3090: the DISTINCT (identity, version hash, session id) pairs behind the
// LOC/$ metric. Grouped by the NORMALIZED key (matching `USAGE_AGGREGATE_SQL`
// and the slug normalization) so a session that logged usage under colliding raw
// variants (e.g. `Reviewer`/`reviewer`) contributes its id to the identity
// exactly once. FEA-3982 (wongk): `component_version_hash` joins the key so the
// resolved lane can dedup sessions per version too; the name-level roll-up (for
// the unresolved lane) is re-derived in application code by `usageSessionIdsBySlug`.
function usageSessionIdsSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    acsu.component_kind AS component_kind,
    lower(trim(COALESCE(acsu.component_key, ''))) AS component_key,
    acsu.component_version_hash AS component_version_hash,
    acsu.session_id AS session_id
  FROM agent_component_session_usage acsu
  ${whereClause(conditions)}
  GROUP BY acsu.component_kind, lower(trim(COALESCE(acsu.component_key, ''))), acsu.component_version_hash, acsu.session_id`,
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
function unresolvedUsageAggregateSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
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
  ${whereClause(conditions)}
  GROUP BY acsu.component_kind, lower(trim(COALESCE(acsu.component_key, '')))`,
    params,
  };
}

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
    slug,
    name: key,
    kind,
    // mcp usage is always server-provenance (mirrors `toSourceType`'s mcp
    // branch); every other unresolved kind falls back to "local" ==
    // builder-specific / no resolvable installed source: the honest marker for
    // an invocation whose source we could not resolve.
    sourceType:
      kind === AgentComponentKind.Mcp ? SourceType.Server : SourceType.Local,
    source: key,
    // ISS-5009: `source: key` above IS the echo — this identity has no inventory
    // row, so there is nothing but its own key to show. Routed through the SAME
    // terminal `honestSourceOf` falls back to, so the two producers cannot drift.
    honestSource: noProvenanceHonestSource(kind),
    harness: toHarness(row.harness),
    invocations: toNumber(row.invocations),
    sessions: toNumber(row.session_count),
    locPerDollar: null,
    trend: [],
    // FEA-4098 (Slice 3): no desktop-local DefinitionVersion authors lineage.
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: row.first_seen_at ?? "",
    lastSeenAt: row.last_seen_at ?? "",
    // An unresolved identity has NO inventory observation — it exists only
    // because of its usage rows — so its `last_seen_at` IS the max usage
    // `last_invoked_at`. Surface that same value as the distinct usage-recency
    // field so the "recently active" indicator works here too (FEA-3310),
    // matching the cloud orphan path where lastSeenAt == lastInvokedAt.
    ...(row.last_seen_at ? { lastInvokedAt: row.last_seen_at } : {}),
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
  return Harness.Both;
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
function pluginUsageSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    ac.pack_id AS pack_id,
    COALESCE(SUM(acsu.invocations), 0) AS invocations,
    COUNT(DISTINCT acsu.session_id) AS session_count,
    -- FEA-3310: max child-usage recency, rolled up so a plugin's real
    -- last-invocation time reflects its most recently used child.
    MAX(acsu.last_invoked_at) AS last_invoked_at
  FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ac.component_kind = acsu.component_kind
    AND lower(trim(COALESCE(ac.component_key, ''))) = lower(trim(COALESCE(acsu.component_key, '')))
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
    -- ISS-6180 (wongk review): the natural-key join is the FALLBACK, not the
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
    AND (acsu.agent_component_id IS NULL OR ac.id = acsu.agent_component_id)
    AND ac.component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
    ${andClause(conditions)}
  GROUP BY ac.pack_id`,
    params,
  };
}

// FEA-3090: the DISTINCT (pack id, session id) pairs the plugin LOC/$ rolls up
// over. Same child-usage join as `PLUGIN_USAGE_SQL`, grouped down to distinct
// session ids so `computeLocPerDollar` sees each child session once per plugin.
function pluginUsageSessionIdsSql(window: UsageWindow): UsageQuery {
  const { conditions, params } = usageWindowClause(window);
  return {
    sql: `SELECT
    ac.pack_id AS pack_id,
    acsu.session_id AS session_id
  FROM agent_component_session_usage acsu
  INNER JOIN agent_components ac
    ON ac.component_kind = acsu.component_kind
    AND lower(trim(COALESCE(ac.component_key, ''))) = lower(trim(COALESCE(acsu.component_key, '')))
  WHERE ac.pack_id IS NOT NULL
    AND ac.component_key IS NOT NULL
    -- Live-inventory scope, for the reason spelled out in pluginUsageSql: a
    -- tombstoned child must not contribute the sessions its plugin's LOC/$ is
    -- computed over either, or the metric disagrees with the rollup it divides.
    AND ac.uninstalled_at IS NULL
    -- Authoritative-FK guard, for the reason spelled out in pluginUsageSql. The
    -- session set must come from the same matches the invocation total did.
    AND (acsu.agent_component_id IS NULL OR ac.id = acsu.agent_component_id)
    AND ac.component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
    ${andClause(conditions)}
  GROUP BY ac.pack_id, acsu.session_id`,
    params,
  };
}

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
    AND lower(trim(COALESCE(ac.component_key, ''))) = lower(trim(COALESCE(acsu.component_key, '')))
  WHERE ac.pack_id = ?
    AND ac.component_key IS NOT NULL
    -- Live-inventory scope, for the reason spelled out in pluginUsageSql: the
    -- detail's per-session breakdown must come from the SAME children the list's
    -- rolled-up total did, or detail and list contradict each other.
    AND ac.uninstalled_at IS NULL
    -- Authoritative-FK guard, for the reason spelled out in pluginUsageSql. The
    -- per-session breakdown must be built from the same matches the total was.
    AND (acsu.agent_component_id IS NULL OR ac.id = acsu.agent_component_id)
    AND ac.component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
  GROUP BY acsu.session_id
  ORDER BY MAX(acsu.last_invoked_at) DESC`;

function pluginUsageByPackId(rows: PluginUsageRow[]): Map<string, UsageTotals> {
  const byPack = new Map<string, UsageTotals>();
  for (const row of rows) {
    byPack.set(row.pack_id, {
      invocations: toNumber(row.invocations),
      sessions: toNumber(row.session_count),
      lastInvokedAt: row.last_invoked_at,
    });
  }
  return byPack;
}

/**
 * The set of child session ids per plugin pack id (FEA-3090), so a plugin's
 * LOC/$ is computed from the SAME child sessions as its rolled-up usage.
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
 * The invoking-session id set backing a list entry's LOC/$: the plugin child
 * session union for the CANONICAL plugin bucket, the version-keyed usage sessions
 * for a normal component, and an empty set for a plugin's zeroed sibling version
 * bucket (FEA-3982 — its usage was attributed to the canonical bucket).
 */
function resolveEntrySessionIds(
  component: AgentComponent,
  entry: MergedComponent,
  entryIdentityKey: string,
  isCanonicalPlugin: boolean,
  pluginSessionIds: Map<string, Set<string>>,
  sessionIdsByVersion: Map<string, Set<string>>
): Set<string> {
  if (component.kind === AgentComponentKind.Plugin) {
    return isCanonicalPlugin
      ? resolvePluginSessionIds(entry, pluginSessionIds)
      : new Set();
  }
  return sessionIdsByVersion.get(entryIdentityKey) ?? new Set();
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
 * `sessionSource` (optional) backs the LOC/$ column (FEA-3090): when provided,
 * the returned PAGE's rows carry a real `locPerDollar` computed from their
 * invoking sessions' local-git LOC + cost; without it the column stays null (the
 * honest fallback for callers that cannot resolve local sessions).
 */
export async function listAgentComponentsLocal(
  prisma: AgentComponentsReadPrisma,
  filters: AgentComponentQueryFilters,
  computeTargetId: string | null = null,
  sessionSource?: AgentSessionSyncSource | null
): Promise<AgentComponentListResponse> {
  // FEA-3196: every usage lane below is scoped to the same window, so a
  // component's invocations, sessions, plugin rollup and LOC/$ all describe the
  // SAME period. The inventory lane is deliberately NOT windowed — the window is
  // a USAGE observation bound, and the zero-in-window drop below (not an
  // inventory predicate) is what removes components that were idle in it.
  const window = toUsageWindow(filters);
  const usageAggregateQuery = usageAggregateSql(window);
  const pluginUsageQuery = pluginUsageSql(window);
  const unresolvedUsageQuery = unresolvedUsageAggregateSql(window);
  const usageSessionIdsQuery = usageSessionIdsSql(window);
  const pluginSessionIdsQuery = pluginUsageSessionIdsSql(window);
  const [
    inventoryRows,
    usageRows,
    pluginRows,
    unresolvedUsageRows,
    usageSessionIdRows,
    pluginSessionIdRows,
  ] = await Promise.all([
    prisma.client.$queryRawUnsafe<ComponentInventoryRow[]>(
      `${INVENTORY_SELECT} ORDER BY component_kind, component_key, last_seen_at DESC`
    ),
    prisma.client.$queryRawUnsafe<UsageAggregateRow[]>(
      usageAggregateQuery.sql,
      ...usageAggregateQuery.params
    ),
    prisma.client.$queryRawUnsafe<PluginUsageRow[]>(
      pluginUsageQuery.sql,
      ...pluginUsageQuery.params
    ),
    // FEA-3121: invocations whose source never resolved to a live inventory
    // row. Folded in as synthetic "unresolved" entries so they are counted,
    // not dropped (mirrors the cloud orphan-usage fold).
    prisma.client.$queryRawUnsafe<UnresolvedUsageRow[]>(
      unresolvedUsageQuery.sql,
      ...unresolvedUsageQuery.params
    ),
    // FEA-3090: per-identity / per-pack invoking session ids for the LOC/$
    // metric (id lists only — the heavy per-session LOC/cost load is bounded to
    // the returned page below).
    prisma.client.$queryRawUnsafe<UsageSessionIdRow[]>(
      usageSessionIdsQuery.sql,
      ...usageSessionIdsQuery.params
    ),
    prisma.client.$queryRawUnsafe<PluginUsageSessionIdRow[]>(
      pluginSessionIdsQuery.sql,
      ...pluginSessionIdsQuery.params
    ),
  ]);
  const windowed = hasUsageWindow(window);

  const merged = foldInventory(inventoryRows);
  // FEA-3982 (wongk decision): surface version buckets for usage whose carried
  // hash was NOT seeded by a live inventory row (hash-at-invocation ≠ current
  // inventory hash), so that usage attributes to its own version instead of
  // vanishing. Mirrors the cloud fold's synthesis of usage-only version buckets.
  synthesizeUsageVersionBuckets(merged, usageRows);
  const usage = usageBySlug(usageRows);
  const pluginUsage = pluginUsageByPackId(pluginRows);
  // FEA-3982 (wongk decision): `byVersion` keys the resolved-inventory version
  // buckets' LOC/$ session sets; `byName` keys the unresolved lane and
  // `foldUnresolvedUsage` (which anti-join by name-only slug).
  const { byVersion: sessionIdsByVersion, byName: sessionIdsByName } =
    usageSessionIdsBySlug(usageSessionIdRows);
  const pluginSessionIds = pluginSessionIdsByPackId(pluginSessionIdRows);
  // FEA-3205: anti-join the unresolved-usage candidates against LIVE inventory
  // in APPLICATION CODE, using the identical JS Unicode fold `foldInventory`.
  // Doing the anti-join in JS — not SQLite `lower()` — keeps one consistent
  // Unicode fold across the resolved fold and the unresolved surface, so a
  // non-ASCII key (`CAFÉ`) can no longer resolve AND surface as unresolved
  // (double-count).
  //
  // FEA-3982 (Slice 2): the anti-join is by NAME-ONLY inventory slug, so it must
  // read each entry's `.slug` rather than the map keys — the map is now keyed by
  // the fingerprint identity key (`slug@fingerprint`), and version-agnostic usage
  // rows carry no fingerprint, so a bare-slug anti-join keeps orphan usage
  // attributed to the real component (never split off as a phantom unresolved
  // row) exactly as it was before the fingerprint split.
  const inventorySlugs = new Set<string>();
  for (const entry of merged.values()) {
    inventorySlugs.add(entry.slug);
  }
  const unresolvedUsage = foldUnresolvedUsage(
    unresolvedUsageRows,
    inventorySlugs,
    sessionIdsByName
  );

  // FEA-3090: each surfaced component's deduped invoking-session id set, so the
  // LOC/$ column can be computed for the returned page without re-querying.
  //
  // FEA-4267: keyed by the per-version IDENTITY key (`slug@fingerprint`), NOT the
  // name-only `component.id` — a family's version buckets all share one `id`, so a
  // `component.id` key would let each version clobber its siblings' session set and
  // leave the collapse to union from an already-lost map (the plugin/multi-version
  // `sessions` under-count wongk flagged). `collapseLocalFamilies` reads this by the
  // per-row identity key and writes the unioned set back under the canonical `id`.
  const sessionIdsByIdentityKey = new Map<string, Set<string>>();
  // The identity key each built row was stored under, so the collapse can look up
  // that row's own (uncollided) session set.
  const identityKeyByRow = new Map<AgentComponent, string>();
  // FEA-4335: the NAME-level family key (`${kind}::${normalizedKey}`) each built
  // row belongs to. The emitted `row.slug` is now the CONTENT-HASH routable key
  // (unique per version), so the FEA-4267 family collapse can no longer group on
  // `row.slug` or every version would split into its own family. It groups on
  // this name-level key instead so a component's versions still collapse into ONE
  // row while each row keeps its content-hash detail URI.
  const familyKeyByRow = new Map<AgentComponent, string>();

  // FEA-3982 (wongk decision): a plugin's usage is its version-agnostic child pack
  // rollup, so a plugin name split into several version buckets must attribute the
  // full pack total to ONE canonical bucket — not to every version bucket (the
  // double-count wongk flagged). Track which plugin names already claimed it.
  const seenPluginSlugs = new Set<string>();

  const all: AgentComponent[] = [];
  for (const entry of merged.values()) {
    // FEA-3982 (wongk decision): join usage by the entry's VERSION identity key,
    // so a version bucket receives only the usage recorded against that version
    // (not the full name-level total applied to every same-named version).
    const entryIdentityKey = fingerprintIdentityKey(
      entry.slug,
      entry.versionFingerprint
    );
    const isPluginEntry =
      toKind(entry.representative.component_kind) === AgentComponentKind.Plugin;
    // Only the first version bucket of a plugin name receives the pack rollup;
    // its siblings zero out (their child usage already lives on the canonical one).
    let entryPluginUsage: UsageTotals | undefined;
    if (isPluginEntry && !seenPluginSlugs.has(entry.slug)) {
      seenPluginSlugs.add(entry.slug);
      entryPluginUsage = resolvePluginUsage(entry, pluginUsage);
    }
    const component = buildComponent(
      entry,
      usage.get(entryIdentityKey),
      entryPluginUsage,
      computeTargetId
    );
    if (
      matchesFilters(component, filters) &&
      !isZeroInWindow(component, windowed)
    ) {
      sessionIdsByIdentityKey.set(
        entryIdentityKey,
        resolveEntrySessionIds(
          component,
          entry,
          entryIdentityKey,
          entryPluginUsage !== undefined,
          pluginSessionIds,
          sessionIdsByVersion
        )
      );
      identityKeyByRow.set(component, entryIdentityKey);
      // Group the FEA-4267 family collapse on the NAME-level slug (still carried
      // on the merge entry), not the content-hash `component.slug`.
      familyKeyByRow.set(component, entry.slug);
      all.push(component);
    }
  }
  // FEA-3121: surface unresolved-source usage identities. A usage identity that
  // shares a slug with a live inventory row is already represented above (the
  // JS anti-join in `foldUnresolvedUsage` excludes it); the remaining rows have
  // NO live inventory row, so they would otherwise vanish and undercount usage.
  for (const row of unresolvedUsage) {
    const component = buildUnresolvedComponent(row);
    // The zero-in-window test is applied here too, for parity with the cloud
    // (whose `dropZeroWindowUsage` runs over the merged map AFTER the orphan
    // fold). It is near-vacuous on this lane — an unresolved identity only
    // exists because it has in-window usage rows — but keeping it uniform means
    // the two lanes cannot drift on what "present in this window" means.
    if (
      matchesFilters(component, filters) &&
      !isZeroInWindow(component, windowed)
    ) {
      // Unresolved components are name-only identities (no fingerprint), so their
      // invoking sessions come from the name-keyed `sessionIdsByName` map. Their
      // identity key is the bare slug (no fingerprint) — unique among unresolved
      // rows and disjoint from resolved inventory slugs (the anti-join above).
      const unresolvedIdentityKey = fingerprintIdentityKey(
        component.slug,
        null
      );
      sessionIdsByIdentityKey.set(
        unresolvedIdentityKey,
        sessionIdsByName.get(component.id) ?? new Set()
      );
      identityKeyByRow.set(component, unresolvedIdentityKey);
      // An unresolved identity is name-only (no content fingerprint), so its
      // content-hash routable key IS its name-level slug — the family key equals
      // `component.slug`.
      familyKeyByRow.set(component, component.slug);
      all.push(component);
    }
  }
  // FEA-4267: collapse the per-version rows into ONE canonical row per component
  // FAMILY (org-level `slug`) BEFORE filters' sort and pagination, mirroring the
  // cloud `collapseToCanonicalFamilies`. Without this, the offline/desktop
  // Sessions→Agents catalog kept showing one row per version fingerprint — the
  // exact duplicate-row bug the cloud list already fixed (wongk). Runs after the
  // per-version filter/zero-window drop above so a family aggregates only its
  // surviving versions, and unions each version's invoking-session id set (read by
  // the per-version identity key so sibling versions can't clobber each other's
  // set) so the collapsed `sessions` count and the page's LOC/$ session load stay
  // correct. Returns the per-canonical-id session map the LOC/$ loader reads.
  const { rows: collapsed, sessionIdsByComponentId } = collapseLocalFamilies(
    all,
    identityKeyByRow,
    sessionIdsByIdentityKey,
    familyKeyByRow
  );

  collapsed.sort((a, b) => a.name.localeCompare(b.name));

  const total = collapsed.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? total;
  const items = collapsed.slice(offset, offset + limit);

  // FEA-3090: compute LOC/$ for the returned page only — load the page's
  // invoking-session LOC/cost once and fill each row's `locPerDollar`.
  await attachLocPerDollar(sessionSource, items, sessionIdsByComponentId);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
  };
}

/**
 * FEA-3090: fill the LOC/$ column for the returned page. Gathers the page's
 * invoking-session ids, loads their local-git LOC + cost in one bounded call,
 * and sets each row's `locPerDollar` via {@link computeLocPerDollar}. A no-op
 * (rows keep the built-in null) when no sessions source is wired.
 */
async function attachLocPerDollar(
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
    item.locPerDollar = locPerDollarForKind(
      item.kind,
      sessionIdsByComponentId.get(item.id) ?? [],
      locCost
    );
  }
}

function buildProperties(row: ComponentInventoryRow): AgentComponentProperties {
  // Delegate to the shared cross-surface builder so desktop and cloud produce
  // identical Properties (path, per-kind format, model/allowedTools/server/…).
  return buildComponentProperties({
    kind: row.component_kind,
    path: row.install_path ?? row.project_path ?? "",
    metadata: parseMetadata(row.metadata),
  });
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
 * The detail path resolves its slug into a JS-normalized key (via
 * `decodeComponentHashKey` — FEA-4335 — then the matched inventory row's key, or
 * the legacy decoded name) but then filtered usage with SQL `lower(trim(...))`,
 * which is ASCII-only. For a non-ASCII key (`café` vs a stored `CAFÉ`) the two
 * disagree, so the usage aggregate/session queries returned nothing and a
 * listed component read empty (or 404'd) on detail. Resolving the concrete raw
 * keys in APPLICATION CODE — the same Unicode fold the list uses — and feeding
 * them back as an explicit key list keeps the SQL aggregation (SUM / COUNT
 * DISTINCT) intact while the key MATCH obeys the JS codec. Returns `[]` when no
 * raw key folds to this identity.
 *
 * Exported for the Optimization-analytics IPC handlers in
 * `agent-dashboard-design-system-runtime.ts` (FEA-3264), which filter the same
 * usage table by the same JS-normalized slug key.
 */
export async function matchingUsageRawKeys(
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
 * ISS-4403 (wongk): translate a content-hash ROUTE fingerprint into the
 * `component_version_hash` value that usage rows actually carry.
 *
 * The routable slug / `versionId` fingerprint is derived from
 * `agent_components.content_hash = sha256Hex(def.content)` — a RAW-content
 * digest. But `agent_component_session_usage.component_version_hash` is stamped
 * from `agent_component_invocations.definition_hash`, which is
 * `computeDefinitionHash({ frontmatter: "", body: content, kind })` — a
 * DOMAIN-tagged, kind-scoped, length-framed digest. The two differ for the same
 * file, so scoping usage by the raw `content_hash` matched NOTHING and every
 * content-scoped read returned empty. Both sides now key off the same canonical
 * definition-fingerprint contract: this recomputes it from the resolved row's
 * captured `content` + `kind` (matching the invocation-time producer exactly),
 * so the version-hash scope predicate targets the value stored on the row.
 *
 * Returns null when the route did not resolve by hash (a name-level read, which
 * aggregates the whole name) or the row has no captured content (a hash-less /
 * unresolved row) — the caller then falls back to a name-level (unscoped) read.
 */
function resolvedUsageScopeHash(
  resolvedByHash: boolean,
  content: string | null | undefined,
  kind: string
): string | null {
  if (!(resolvedByHash && content)) {
    return null;
  }
  return computeDefinitionHash({
    frontmatter: "",
    body: content,
    kind: toKind(kind),
  }).definitionHash;
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
  sessionSource?: AgentSessionSyncSource | null,
  branchEligibilitySource?: BranchDefaultEligibilitySource,
  // FEA-4335: content-hash orphan scope; null preserves legacy name scope.
  fingerprint: string | null = null
): Promise<AgentComponentDetail | null> {
  if (kind === AgentComponentKind.Plugin) {
    return null;
  }
  // FEA-3205: resolve Unicode-folded raw keys in JS before SQL aggregation.
  const rawKeys = await matchingUsageRawKeys(prisma, kind, key);
  // FEA-4335: compose the usage predicate. For a legacy name route it is the raw
  // key IN-list (as before). For a content-hash route that matched no inventory
  // row `key` is empty, so the key list is empty — the coarse
  // `component_version_hash = fingerprint` predicate stands in for it (filtering
  // the empty key list alone would `1 = 0` every row). When BOTH are present
  // (content-hash route whose usage rows also carry a resolvable name) they AND.
  const usagePredicate = unresolvedUsagePredicate(rawKeys, fingerprint);
  const [aggregateRows, usageSessionRows, invocationRows] = await Promise.all([
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
          AND ${usagePredicate.clause}
        GROUP BY component_kind`,
      kind,
      ...usagePredicate.params
    ),
    prisma.client.$queryRawUnsafe<
      { session_id: string; invocation_count: bigint | number | null }[]
    >(
      `SELECT session_id, COALESCE(SUM(invocations), 0) AS invocation_count
        FROM agent_component_session_usage
        WHERE component_kind = ?
          AND ${usagePredicate.clause}
        GROUP BY session_id
        ORDER BY MAX(last_invoked_at) DESC`,
      kind,
      ...usagePredicate.params
    ),
    readAgentComponentInvocationPage(
      prisma,
      kind,
      key,
      [],
      branchEligibilitySource
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
  // One load backs both the sessionsTab projection and the LOC/$ metric
  // (FEA-3090), matching the cloud `buildOrphanOnlyDetail`. Empty/null when no
  // sessions source is wired.
  const { items: sessionsTab, locCost } =
    await getSharedAgentSessionsWithLocCostByIds(sessionSource, sessionIds);

  return {
    ...base,
    locPerDollar: locPerDollarForKind(base.kind, sessionIds, locCost),
    // No inventory row ⇒ no parsed metadata; the shared builder still yields an
    // honest { path, per-kind format } (mcp→json, workflow→yml, hook→bash, …).
    properties: buildComponentProperties({
      kind: base.kind,
      path: base.source,
    }),
    // Unresolved-source components have no inventory row, so there is no
    // definition text or version history to surface.
    prompt: null,
    versions: [],
    // F1 (FEA-3290, Slice 6): the local desktop read has no resolution
    // derivation (that lives on the cloud `AgentComponent.resolvedState`), so a
    // locally-surfaced component is honestly `unresolved` — never claimed
    // resolved. Matches the cloud DB column default.
    resolvedState: ComponentResolvedState.Unresolved,
    ...(invocationRows ? { invocationRows } : {}),
    ...localDetailSessionTabs(sessionsTab, sessionIds),
    // No inventory row ⇒ no per-device install-path/scope provenance.
    provenance: [],
    usageSessions,
    // FEA-4335: the resolved name-level analytics key (the renderer keys
    // optimization IPC on `component_key`, not the routable slug). Omitted for the
    // orphan-only content-hash case where `key` is empty (no name to resolve).
    ...(key ? { analyticsKey: key } : {}),
    // ISS-4403: no `analyticsFingerprint` on the unresolved-only path. This row
    // has NO captured `content`, so the canonical `component_version_hash` digest
    // (`computeDefinitionHash(content, kind)`) that usage rows carry cannot be
    // recomputed here — the only fingerprint available is the raw route hash,
    // which never equals `component_version_hash` and would make the panel scope
    // to a value no usage row has and render empty. Omitting it degrades the panel
    // to an honest name-level read instead of a false empty. (The unresolved
    // detail's own `component_version_hash = fingerprint` usage predicate has the
    // same latent limitation and predates ISS-4403; it is unchanged here.)
    ...EMPTY_COHORT_DELIVERY_METRICS,
  };
}

/**
 * Fetch component detail by org-identity slug, falling back to unresolved usage
 * evidence when inventory is absent (FEA-3121).
 */
export async function getAgentComponentDetailLocal(
  prisma: AgentComponentsReadPrisma,
  slug: string,
  computeTargetId: string | null = null,
  // Optional local session and branch-authority sources; legacy callers degrade.
  sessionSource?: AgentSessionSyncSource | null,
  branchEligibilitySource?: BranchDefaultEligibilitySource
): Promise<AgentComponentDetail | null> {
  // FEA-4335: the slug is the content-hash routable key
  // (`${kind}::${versionFingerprint}`) for a new link, or the legacy name-level
  // `${kind}::${key}` for old links / hash-less rows. Decode both shapes and
  // resolve the live inventory rows + name-level key for this identity
  // (content-hash-first, name-slug fallback). Returns null only when the slug is
  // undecodable.
  const scope = await resolveDetailInventoryScope(prisma, slug);
  if (!scope) {
    return null;
  }
  const { resolvedByHash, effectiveFingerprint, inventoryRows, parts } = scope;
  if (inventoryRows.length === 0) {
    // FEA-3121: build absent inventory from usage so a listed orphan resolves. A
    // content-hash key with no matching inventory row has no name to fall back
    // on, so it resolves as unresolved usage under an empty key (404 unless
    // orphan usage exists) rather than a wrong component.
    return buildUnresolvedOnlyDetail(
      prisma,
      parts.kind,
      parts.key,
      sessionSource,
      branchEligibilitySource,
      effectiveFingerprint
    );
  }

  // Pick the fingerprint bucket the routable key points at. `foldInventory` keys
  // by `slug@fingerprint` (FEA-3982); for a content-hash key every remaining row
  // shares that fingerprint so any bucket is the right one, for a name-level key
  // (incl. a 64-hex legacy name that fell back to name matching) we scan for the
  // matching name-slug (the detail read aggregates a name's versions).
  const foldedInventory = foldInventory(inventoryRows);
  const merged = resolvedByHash
    ? foldedInventory.values().next().value
    : firstBucketForSlug(foldedInventory, slug);
  if (!merged) {
    return null;
  }

  // FEA-3123 (perf): `PLUGIN_USAGE_SQL` is a full-table INNER JOIN + GROUP BY
  // over `agent_component_session_usage`, but its result is only ever consumed
  // by `resolvePluginUsage`, which returns undefined for anything that is not a
  // plugin. The kind is already known here, so skip the whole-table aggregate
  // for the common non-plugin case and fall back to an empty pack map.
  const isPlugin =
    toKind(merged.representative.component_kind) === AgentComponentKind.Plugin;

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
  // FEA-4335 + ISS-4403: for a content-hash route, narrow the usage/session
  // aggregates to exactly the requested content version. The scope value is NOT
  // the route's raw `content_hash` fingerprint (`effectiveFingerprint`): usage
  // rows store `component_version_hash = computeDefinitionHash(content, kind)`, a
  // domain-tagged digest that never equals the raw-content hash (wongk), so
  // scoping by the raw hash matched nothing and the whole content-scoped read
  // came back empty. Recompute the canonical definition-fingerprint from the
  // resolved row's captured `content` (the exact invocation-time producer) so the
  // predicate targets the value actually on the row. Null (name-level, no
  // predicate) for a legacy name-level route or a row with no captured content.
  const usageScopeHash = resolvedUsageScopeHash(
    resolvedByHash,
    merged.representative.content,
    parts.kind
  );
  const versionHashScope = versionHashScopeClause(usageScopeHash);

  const [usageRows, pluginRows, usageSessionRows] = await Promise.all([
    prisma.client.$queryRawUnsafe<UsageAggregateRow[]>(
      // Aggregate over the JS-resolved raw key list (matching the inventory
      // lookup above and the list path) so the detail endpoint reads the same
      // distinct-session union the list endpoint does. This spans every colliding
      // raw variant — casing/whitespace AND non-ASCII case (`CAFÉ`/`café`).
      `SELECT component_kind,
          COALESCE(SUM(invocations), 0) AS invocations,
          COUNT(DISTINCT session_id) AS session_count,
          MAX(last_invoked_at) AS last_invoked_at
        FROM agent_component_session_usage
        WHERE component_kind = ?
          AND ${usageKeyIn.clause}${versionHashScope.clause}
        GROUP BY component_kind`,
      parts.kind,
      ...usageKeyIn.params,
      ...versionHashScope.params
    ),
    isPlugin
      ? // FEA-3196: the DETAIL reader is all-time (it takes a slug, not the
        // list's filters — the workspace's time-window control scopes the list
        // only), so it passes the empty window: no predicate is added and the
        // query stays the all-time rollup this read before.
        prisma.client.$queryRawUnsafe<PluginUsageRow[]>(pluginUsageSql({}).sql)
      : Promise.resolve<PluginUsageRow[]>([]),
    prisma.client.$queryRawUnsafe<
      {
        session_id: string;
        invocation_count: bigint | number | null;
        component_version_hash: string | null;
      }[]
    >(
      // Same JS-resolved key list (see the usage-aggregate query above): the
      // per-session breakdown must span every colliding raw variant so it stays
      // consistent with the rolled-up `sessions` total. FEA-2923: MAX() surfaces
      // the (single, per component+session) hash-at-invocation for attribution.
      `SELECT session_id, COALESCE(SUM(invocations), 0) AS invocation_count,
              MAX(component_version_hash) AS component_version_hash
        FROM agent_component_session_usage
        WHERE component_kind = ?
          AND ${usageKeyIn.clause}${versionHashScope.clause}
        GROUP BY session_id
        ORDER BY MAX(last_invoked_at) DESC`,
      parts.kind,
      ...usageKeyIn.params,
      ...versionHashScope.params
    ),
  ]);

  // The aggregate SQL already filters to this one identity (the JS-resolved raw
  // key list) and groups by kind, so it returns at most one row — read it
  // directly rather than re-keying by a slug the SELECT no longer carries.
  const usageRow = usageRows[0];
  const usage: UsageTotals | undefined = usageRow
    ? {
        invocations: toNumber(usageRow.invocations),
        sessions: toNumber(usageRow.session_count),
        lastInvokedAt: usageRow.last_invoked_at,
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
    base.kind === AgentComponentKind.Plugin
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
      // FEA-2923: hash-at-invocation attribution. Plugin rollup rows have no
      // per-child hash, so this is null for plugins.
      versionHash:
        "component_version_hash" in row
          ? (row.component_version_hash ?? null)
          : null,
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
  // One load backs both the sessionsTab projection and the LOC/$ metric: the
  // same value the list column shows and the cloud detail computes, deduped by
  // session id. Plugins use their child-usage sessions (`pluginUsageSessions`).
  // Empty/null when no sessions source is wired (FEA-3090).
  const { items: sessionsTab, locCost } =
    await getSharedAgentSessionsWithLocCostByIds(sessionSource, sessionIds);

  const [versions, invocationRows] = await Promise.all([
    readComponentVersions(
      prisma,
      merged.representative.component_kind,
      merged.representative.component_key,
      merged.representative.content_hash,
      // ISS-6232: fold provenance across the whole family, representative
      // first, so a component whose pack was recorded on a non-representative
      // row still reports its pack rather than the `organic` terminal.
      unionComponentSourceProvenance(
        [merged.representative, ...inventoryRows].map(sourceProvenanceOf),
        [merged.representative.component_key, merged.representative.external_id]
      )
    ),
    readAgentComponentInvocationPage(
      prisma,
      parts.kind,
      parts.key,
      inventoryRows.map((row) => row.id),
      branchEligibilitySource
    ),
  ]);

  return {
    ...base,
    locPerDollar: locPerDollarForKind(base.kind, sessionIds, locCost),
    properties: buildProperties(merged.representative),
    versions,
    // Real definition text (FEA-2923 content pipeline). Falls back to the
    // frontmatter `description` for rows synced before the content column
    // existed; the frontend only shows the panel for prompt-kinds anyway.
    prompt:
      merged.representative.content ??
      (base.kind === AgentComponentKind.Hook ||
      base.kind === AgentComponentKind.Config
        ? null
        : (merged.representative.description ?? null)),
    // F1 (FEA-3704): honest org-level resolution state, folded across every
    // device's `agent_components.resolved_state` (synced from the cloud
    // `AgentComponent.resolvedState` + set locally by the definition-content
    // collector). Legacy rows with NULL `resolved_state` still default to
    // `unresolved` (`toResolvedState`).
    resolvedState: merged.resolvedState,
    ...(invocationRows ? { invocationRows } : {}),
    ...localDetailSessionTabs(sessionsTab, sessionIds),
    provenance,
    usageSessions,
    // FEA-4335: the resolved name-level analytics key. The renderer's
    // OptimizationAnalyticsPanel keys the desktop IPC on `component_key`, not the
    // (possibly content-hash) routable slug, so carry it here rather than making
    // the renderer re-derive it from a hash it cannot resolve.
    analyticsKey: parts.key,
    // ISS-4403: the ACTUAL content scope this detail's usage reads were narrowed
    // to — the SAME `component_version_hash` value (`usageScopeHash`) the
    // version-hash scope clause above filtered every usage lane by. This is the
    // canonical `computeDefinitionHash(content, kind)` digest usage rows carry,
    // NOT the route's raw `content_hash` fingerprint and NOT `versionId` (the
    // representative bucket hash, populated even on a name-level route). The panel
    // must scope its optimization IPC by THIS so its numbers match the page and
    // actually hit usage rows. Null for a legacy name-level route (aggregates the
    // whole name) or a row with no captured content; omitted then so absence
    // stays skew-safe "name-level" on the wire.
    ...(usageScopeHash ? { analyticsFingerprint: usageScopeHash } : {}),
    ...EMPTY_COHORT_DELIVERY_METRICS,
  };
}

/**
 * The resolved identity scope for a desktop component detail read: the live
 * inventory rows this slug maps to, whether it resolved as a REAL content-hash
 * route, the effective (matched) fingerprint, and the name-level key the usage/
 * session aggregate reads key off. Consumed by `getAgentComponentDetailLocal`.
 */
type DetailInventoryScope = {
  resolvedByHash: boolean;
  effectiveFingerprint: string | null;
  inventoryRows: ComponentInventoryRow[];
  parts: { kind: string; key: string };
};

/**
 * FEA-4335: decode the routable slug and resolve the live inventory rows for one
 * component identity. Extracted verbatim from `getAgentComponentDetailLocal`
 * (ISS-4404) so that method stays under the cognitive-complexity budget; the
 * content-hash-first / name-slug-fallback resolution is unchanged.
 *
 * The slug is the content-hash routable key (`${kind}::${versionFingerprint}`)
 * for a new link, or the legacy name-level `${kind}::${key}` for old links /
 * hash-less rows. Returns null only when the slug is undecodable (the caller then
 * 404s). Otherwise fetches the kind's live inventory and matches the identity in
 * APPLICATION CODE with the JS Unicode fold (`encodeComponentSlug`), instead of a
 * SQL `lower(trim(...)) = ?` predicate that is ASCII-only and diverges from the
 * JS-normalized key on a non-ASCII key.
 */
async function resolveDetailInventoryScope(
  prisma: AgentComponentsReadPrisma,
  slug: string
): Promise<DetailInventoryScope | null> {
  const decoded = decodeComponentHashKey(slug);
  if (!decoded) {
    return null;
  }
  const { kind: decodedKind, fingerprint } = decoded;

  const kindInventoryRows = await prisma.client.$queryRawUnsafe<
    ComponentInventoryRow[]
  >(
    `${INVENTORY_SELECT}
      AND component_kind = ?
      ORDER BY component_kind, component_key, last_seen_at DESC`,
    decodedKind
  );
  // For a content-hash key, narrow to rows carrying that exact `content_hash`
  // (desktop has no DefinitionVersion linkage, so the coarse `content_hash` IS
  // the fingerprint here — `resolveVersionFingerprint(row.content_hash)`). Two
  // same-named-different-bytes components split, so their detail reads no longer
  // aggregate into one. A legacy name-level key matches by name slug as before.
  const nameSlugMatches = (row: ComponentInventoryRow) =>
    encodeComponentSlug(row.component_kind, row.component_key, row.name) ===
    slug;
  const hashMatches = fingerprint
    ? kindInventoryRows.filter((row) => row.content_hash === fingerprint)
    : [];
  // FEA-4335 (wongk): the 64-hex fingerprint segment is AMBIGUOUS — a legacy
  // hash-less component whose normalized `component_key`/`name` is itself exactly
  // 64 lowercase hex chars decodes to the same `${kind}::<64hex>` shape as a real
  // content-hash route. When the content-hash filter matches nothing, fall back to
  // the name-slug match so that legacy component's old link still resolves on
  // desktop (parity with the cloud resolver's name-level fallback). A legacy
  // name-level route matches by name slug as before.
  // Whether the slug resolved as a REAL content-hash route (a live inventory row
  // carries that coarse `content_hash`). A 64-hex segment that matches no hash row
  // is treated as a legacy NAME below (see the ambiguity note above), so all
  // downstream fingerprint-conditioned logic — the name-key derivation, the
  // version-hash usage scope, and the fold-bucket pick — keys off THIS, not the
  // raw `fingerprint`, or it would scope usage by a nonexistent hash and drop it.
  const resolvedByHash = fingerprint != null && hashMatches.length > 0;
  const effectiveFingerprint = resolvedByHash ? fingerprint : null;
  const inventoryRows = resolvedByHash
    ? hashMatches
    : kindInventoryRows.filter(nameSlugMatches);
  // The name-level key for the usage/session aggregate reads: derived from a
  // matched inventory row for a content-hash key, else the decoded legacy name.
  // For a 64-hex legacy name that fell back to name matching, the name IS the
  // fingerprint segment, so use the matched row's key (like the hash case).
  const parts = {
    kind: decodedKind,
    key: resolvedByHash
      ? normalizeComponentKey(
          inventoryRows[0]?.component_key,
          inventoryRows[0]?.name
        )
      : (decoded.key ??
        normalizeComponentKey(
          inventoryRows[0]?.component_key,
          inventoryRows[0]?.name
        )),
  };
  return { resolvedByHash, effectiveFingerprint, inventoryRows, parts };
}
