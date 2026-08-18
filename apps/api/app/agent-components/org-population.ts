import "server-only";

import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import { Prisma, withDb } from "@repo/database";
import {
  type UsageContentScope,
  usageContentScopeWhere,
} from "./content-hash-identity";
import {
  inventoryVersionIdentityKey,
  resolveDefinitionHashes,
  resolveInventoryDefinitionHashes,
} from "./definition-hash-resolution";
import {
  buildInventorySlugById,
  collectNameMatchedIdentities,
  foldFkUsageIntoMerged,
  foldOrphanUsageIntoMerged,
  type InventoryRow,
  type MergedComponent,
  mergeComponentRows,
  type UsageGroupRow,
} from "./identity";
import {
  loadOrphanUsageRows,
  readOrgInventoryRows,
  type UsageSearchFacet,
  usageSearchWhere,
} from "./org-population-reads";
import {
  loadPluginChildUsage,
  type PackUsageBucket,
  pluginPackCandidates,
  sumPluginChildUsage,
  type UsageWindow,
  usageWindowWhere,
} from "./plugin-child-usage";

// ---------------------------------------------------------------------------
// ISS-4635: the ONE org-level agent-component population.
//
// The catalog LIST (`agentComponentsService.listForOrg`) and the usage RANKING
// (`rankingService.getRanking`) are two views of the same question — "what
// components does this org have, and how much were they used?" — and they MUST
// agree on both the population and the per-component usage. Before this module
// they each built their own: the list merged inventory on the subagent-normalized
// `${kind}::${key}` identity, folded FK-linked AND orphan (null-FK) usage, then
// collapsed content-hash version buckets into families; ranking keyed raw
// `encodeComponentSlug(kind, componentKey, name)` (no subagent rollup, no version
// families) and folded ONLY FK-linked usage. That produced two totals for one org
// (3311 vs 2132) and an all-zero ranking leaderboard for an org whose usage rows
// are predominantly orphaned — a component the detail page reported at 3
// invocations ranked at 0.
//
// This module owns the shared build: inventory read → version-bucket seeding →
// FK usage fold → ORPHAN usage fold → plugin child-usage rollup → optional
// window drop. Both endpoints call it and then apply their own presentation
// (`collapseToCanonicalFamilies` + sort/paginate), so the identity, the
// `uninstalledAt: null` scope, and every usage lane are single-sourced and
// cannot drift again.
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of merged version BUCKETS the usage folds may
 * synthesize on top of the inventory-seeded population, so usage rows for
 * components with no surviving inventory row cannot grow the working set without
 * bound (FEA-2923 review).
 *
 * ISS-4797: this is no longer the read cap. The inventory and orphan-usage READS
 * are bounded by distinct component identity in `./org-population-reads`
 * (`MAX_ORG_POPULATION_COMPONENTS`), because a raw-row cap applied after the
 * request's facets made a stricter filter return MORE data. This constant now
 * bounds only the fold's synthetic-bucket growth, which is already
 * identity-shaped (`mergedMap.size`).
 *
 * Shared `AGENT_COMPONENT_INVENTORY_CAP` so this bound, the validator's max
 * request `limit`, and the desktop local clamp stay one value.
 */
export const MAX_ORG_INVENTORY_ROWS = AGENT_COMPONENT_INVENTORY_CAP;

/**
 * Bucket grouped-usage rows by their (non-null) `agentComponentId` so each
 * inventory row can fold in exactly the usage the DB attributed to it — the
 * grouped-rows equivalent of the old nested `row.sessionUsages` relation walk.
 * The `groupBy`'s `agentComponentId: { in: inventoryIds }` already excludes the
 * null-FK group (orphan usage is folded separately), but the model's column is
 * nullable so the null case is skipped defensively for the type.
 */
export function groupUsageByComponentId(
  rows: UsageGroupRow[]
): Map<string, UsageGroupRow[]> {
  const byComponent = new Map<string, UsageGroupRow[]>();
  for (const row of rows) {
    if (row.agentComponentId === null) {
      continue;
    }
    const list = byComponent.get(row.agentComponentId);
    if (list) {
      list.push(row);
    } else {
      byComponent.set(row.agentComponentId, [row]);
    }
  }
  return byComponent;
}

/**
 * FEA-3467: the shared direct-usage rollup issued by the list, the ranking
 * leaderboard, and `getDetailForOrg` in place of the eager nested `sessionUsages`
 * load. Groups the org's usage rows by (component, session, branch) — scoped to
 * the caller's capped inventory ids + org (+ optional usage window) — so peak
 * heap scales with distinct grouped tuples rather than the full nested per-branch
 * collection. Returns `[]` without a query when there are no inventory ids to
 * scope to.
 */
export function loadUsageGroupsForInventory(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  inventoryIds: string[],
  window: UsageWindow = {},
  // FEA-4335: for a content-hash detail route, narrow the FK-linked usage to
  // exactly the requested content version. A current inventory row that moved
  // A→B still owns its historical A-version usage rows (same `agentComponentId`,
  // different `componentVersionHash`); without this scope the B-specific URI
  // would report A+B combined invocations/sessions. `null` for a legacy
  // name-level key (whole name-level identity, as before), matching the shared
  // token-trend read.
  contentScope: UsageContentScope | null = null,
  // ISS-4635 (shafty023 review): the requested `?kind=` facet. Because
  // `foldFkUsageIntoMerged` now attributes FK-linked usage by the usage row's OWN
  // `(componentKind, componentKey)` (ISS-4630) — and SEEDS a synthetic bucket for
  // an identity absent from the kind-filtered inventory — a usage row FK-linked to
  // a selected `skill` inventory row but carrying its own `command` kind would
  // otherwise leak a `command` row into a `?kind=skill` response. Scope the FK
  // groups to the requested kinds here, mirroring the orphan lane. Undefined ⇒ no
  // facet ⇒ all kinds (the detail read passes none — it reads one component, so
  // kind-filtering does not apply).
  kinds: readonly string[] | undefined = undefined,
  // ISS-4660 (item 3): the requested `?search=` facet, mirroring the orphan lane
  // through the shared `usageSearchWhere`. Same rationale as `kinds` above: the
  // fold seeds a synthetic bucket from the usage row's OWN identity, so without
  // this a row FK-linked to a search-matching inventory row but carrying a
  // different, non-matching own key leaks into a `?search=` response. Null ⇒ no
  // facet ⇒ all rows (the detail read passes none — it reads one component).
  searchFacet: UsageSearchFacet | null = null
): Promise<UsageGroupRow[]> {
  if (inventoryIds.length === 0) {
    return Promise.resolve([]);
  }
  return runUsageGroupBy(db, organizationId, {
    agentComponentId: { in: inventoryIds },
    // ISS-4635 (shafty023 review): scope the FK groups to the requested `?kind=`
    // so a mismatched-FK usage row (own kind ≠ the selected kind) can't seed a
    // cross-kind synthetic bucket into a kind-filtered response. The usage
    // table's `componentKind` is NON-null (schema `String`, not `String?`), so
    // every group carries a concrete own kind — no null/legacy DB branch is
    // needed here; the fold's own-key-absent fallback to the FK'd inventory slug
    // (already kind-scoped by the inventory read) covers the legacy group shape.
    // Absent facet ⇒ no predicate ⇒ all kinds (the detail read passes none).
    ...(kinds && kinds.length > 0 ? { componentKind: { in: [...kinds] } } : {}),
    // ISS-4660: the SAME `search` predicate the orphan lane applies, from the
    // one shared derivation, so a mismatched-FK usage row cannot seed a
    // synthetic bucket the search facet excluded.
    ...usageSearchWhere(searchFacet),
    // FEA-4335: for a content-hash route, keep only usage rows that carried the
    // requested content version at invocation (shared `usageContentScopeWhere`),
    // so a device that moved A→B does not fold its A usage into B's URI.
    ...usageContentScopeWhere(contentScope),
    // FEA-3160 / FEA-3178: window usage by invocation time so
    // invocationCount / session counts include only in-window usage. Both
    // bounds (start/end) apply; absent window ⇒ no predicate ⇒ all-time.
    ...usageWindowWhere(window),
  });
}

/**
 * ISS-5363: the usage lane the DETAIL read was missing — FK-linked usage whose
 * OWN `(componentKind, componentKey)` identity is this family but whose
 * `agentComponentId` points at some OTHER family's inventory row.
 *
 * The list and the detail were never disagreeing about *attribution* — since
 * ISS-4630 both credit a usage group by its own identity. They disagreed about
 * what gets LOADED. The list's FK read (`loadUsageGroupsForInventory`) is bounded
 * by EVERY inventory id in the org, so a row FK-linked to X but installed as Y is
 * read and then folded onto Y. The detail's FK read is bounded by ONE family's
 * inventory ids, so that same row is never read at all — and the orphan lane
 * cannot recover it either, because `fetchDetailOrphanUsage` matches only usage
 * no LIVE inventory row owns. The detail therefore reported a hard `0` for a
 * component the list showed real usage for.
 *
 * This lane closes that gap by asking the LIST's question inside the detail's
 * bound: "which usage rows say they ARE this family?", over the LIST's OWN
 * inventory population minus the ids the inventory lane already read. The two
 * lanes are therefore DISJOINT BY CONSTRUCTION and need no dedupe —
 * `agentComponentId` cannot be `in` two disjoint sets. Callers concatenate the
 * two and run `filterUsageGroupsToDetailIdentity` over the union.
 *
 * wongk (ISS-5363 review): the bound is an `in` over the list's current org
 * inventory ids (`readOrgInventoryIds`), NOT a `notIn` of this family's ids. A
 * `notIn` is BROADER than the list: it admits usage FK-linked to a current row
 * the identity cap truncated away, which the list can load through neither its FK
 * lane (`in <retained ids>`) nor its orphan lane. The detail would then read
 * HIGH — the same divergence pointed the other way. (A TOMBSTONED FK target used
 * to be in that set too; ISS-6180 gave BOTH surfaces the usage-only lane for it,
 * so it is now loaded by both rather than dropped by both.) It also gives the read an indexable bound
 * (`@@index([agentComponentId])`) rather than a case-insensitive key scan over
 * every same-kind row.
 *
 * Deliberately uncapped beyond that bound, matching the list lane it mirrors:
 * this predicate is strictly NARROWER than the list's FK read (a subset of the
 * same ids, plus one kind and one name set), so any org whose list can run that
 * read can run this one. A `take` here would silently truncate the detail's
 * total and reintroduce the very list⇄detail divergence this exists to close.
 *
 * Returns `[]` without a query when there is no name to match on (an identity
 * with no derivable key has nothing to ask for) or no other inventory row to
 * look at.
 */
export function loadUsageGroupsLinkedElsewhere(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  /** Every raw name this detail answers for (primary key + content aliases). */
  keys: readonly string[],
  /**
   * The list's current org inventory ids MINUS this family's own — i.e. every
   * inventory row the list would read FK-linked usage through that the detail's
   * inventory lane does not already cover.
   */
  otherInventoryIds: readonly string[],
  contentScope: UsageContentScope | null = null
): Promise<UsageGroupRow[]> {
  if (keys.length === 0 || otherInventoryIds.length === 0) {
    return Promise.resolve([]);
  }
  // Case-insensitive, mirroring `fetchDetailOrphanUsage` — the list's fold
  // normalizes through `encodeComponentSlug`, which lowercases. Over-matching a
  // raw variant is safe: `filterUsageGroupsToDetailIdentity` re-checks every
  // group against the authoritative normalized slug set.
  const nameWhere: Prisma.AgentComponentSessionUsageWhereInput = {
    OR: keys.map((k) => ({
      componentKey: { equals: k, mode: "insensitive" as const },
    })),
  };
  // wongk (ISS-5363 review): `usageContentScopeWhere` owns an `OR` key of its
  // own, so SPREADING it here silently REPLACED the name predicate above on
  // every content-hash route — leaving an unbounded groupBy over every
  // same-kind row in that content scope. Both predicates are combined under
  // `AND` instead, the same reason `loadOrphanUsageRows` nests its recency
  // bound rather than spreading it.
  const contentWhere = usageContentScopeWhere(contentScope);
  return runUsageGroupBy(db, organizationId, {
    // `in` already excludes NULLs in SQL — the null-FK rows are the ORPHAN
    // lane's, and double-reading them here would double-count them.
    agentComponentId: { in: [...otherInventoryIds] },
    componentKind: kind,
    AND: contentWhere ? [nameWhere, contentWhere] : [nameWhere],
  });
}

/**
 * The ONE `AgentComponentSessionUsage` rollup every usage lane reads through, so
 * the grouping key, the summed aggregates, and the `definitionHash` resolution
 * cannot drift between the list's lane and the detail's lanes. Callers supply
 * only the lane-specific predicate; org scoping is applied here.
 */
async function runUsageGroupBy(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  usageWhere: Prisma.AgentComponentSessionUsageWhereInput
): Promise<UsageGroupRow[]> {
  const groups = await db.agentComponentSessionUsage.groupBy({
    // FEA-3758: `harness` joins the grouping key so the rollup can attribute the
    // component's harness per session (see resolveComponentHarness).
    // FEA-3982 (wongk decision): `componentVersionHash` + `definitionVersionId`
    // join the key so each group carries the version identity the usage was
    // recorded against, and the fold attributes it to the MATCHING version
    // bucket (a device that moved hash A→B keeps its A sessions on A). The
    // natural key already pins one hash per (session, kind, key, branch), so
    // this only splits groups that carried different hashes — the summed
    // invocation totals and unioned session ids are unchanged.
    by: [
      "agentComponentId",
      // ISS-4630: the usage row's OWN identity joins the grouping key so the FK
      // fold can attribute by `(componentKind, componentKey)` — the same identity
      // the detail read uses — instead of the FK'd inventory row's slug. The
      // natural key already pins one `(kind, key)` per (session, kind, key,
      // branch), so for a normal FK-linked row this only names the identity the
      // group already had; it does not fragment the summed totals.
      "componentKind",
      "componentKey",
      "agentSessionId",
      "gitBranch",
      "harness",
      "componentVersionHash",
      "definitionVersionId",
    ],
    where: {
      ...usageWhere,
      // Usage carries no organizationId of its own; it isolates through
      // session→artifact.organizationId, exactly as the nested `where` this
      // replaces did. Applied HERE, after the lane predicate, so no lane can
      // forget it or spread it away.
      session: {
        artifact: {
          organizationId,
        },
      },
    },
    // ISS-4635: `errorCount` is summed alongside invocations so the ranking
    // leaderboard's `errorRate` is derived from the SAME fold as its invocation
    // count, instead of a second, differently-scoped usage read.
    _sum: { invocationCount: true, errorCount: true },
    _max: { lastInvokedAt: true },
  });
  // FEA-3982 (wongk decision): resolve each group's `definitionVersionId` link to
  // its exact provenance-free `definitionHash` (the F1 fingerprint), so the fold
  // attributes on the exact server version when linked and falls back to the
  // coarse `componentVersionHash` when it isn't (the legacy fallback the contract
  // promises). Org-scoped resolution — a foreign version id can never resolve.
  const definitionHashById = await resolveDefinitionHashes(
    db,
    organizationId,
    groups.map((g) => g.definitionVersionId)
  );
  return groups.map((g) => ({
    agentComponentId: g.agentComponentId,
    agentSessionId: g.agentSessionId,
    gitBranch: g.gitBranch,
    harness: g.harness,
    // ISS-4630: carry the usage row's own identity so `foldFkUsageIntoMerged`
    // attributes by `(componentKind, componentKey)`, mirroring the detail read.
    componentKind: g.componentKind,
    componentKey: g.componentKey,
    componentVersionHash: g.componentVersionHash,
    definitionHash: g.definitionVersionId
      ? (definitionHashById.get(g.definitionVersionId) ?? null)
      : null,
    _sum: g._sum,
    _max: g._max,
  }));
}

/**
 * REPLACE a plugin entry's usage aggregates with the child rollup summed over
 * its candidate packs (sessions unioned so a session touching multiple child
 * packs is counted once). Plugins have no real own-usage rows to preserve, so
 * REPLACE (not add) is safe. Errors roll up alongside invocations so the ranking
 * leaderboard's `errorRate` reflects a plugin's children's failures rather than
 * the plugin's (always-zero) own error count; the list view does not surface an
 * error rate but shares the same merged entry.
 */
function applyPackRollupToPlugin(
  plugin: MergedComponent,
  byPack: Map<string, PackUsageBucket>
): void {
  const rollup = sumPluginChildUsage(pluginPackCandidates(plugin), byPack);
  plugin.totalInvocations = rollup.invocations;
  plugin.totalErrors = rollup.errors;
  plugin.sessionIds = rollup.sessionIds;
  // Plugins carry no own usage rows, so their last-invocation time is the max
  // across rolled-up child usage (REPLACE, consistent with invocations/sessions).
  plugin.lastInvokedAt = rollup.lastInvokedAt;
}

/**
 * REPLACE each plugin entry's invocations/errors/sessions with its pack-id
 * child-usage rollup, mirroring the desktop reader (FEA-2923/FEA-3387).
 * Plugin-kind components are never invoked directly (no own usage rows), so their
 * usage is the SUM of their child skill/command/subagent/mcp rows, matched by the
 * child inventory row's `packId` and scoped to the org's sessions. Candidate
 * packs = every `packId` folded into the identity plus the plugin's own key (a
 * plugin's own `pack_id` usually equals its `componentKey`), via the shared
 * `pluginPackCandidates`. Sessions are unioned across candidate packs so a
 * session touching multiple child packs counts once.
 */
async function applyPluginChildUsageRollup(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  mergedMap: Map<string, MergedComponent>,
  organizationId: string,
  window: UsageWindow = {}
): Promise<void> {
  const plugins = [...mergedMap.values()].filter(
    (m) => m.kind === AgentComponentKind.Plugin
  );
  if (plugins.length === 0) {
    return;
  }

  const byPack = await loadPluginChildUsage(
    db,
    plugins,
    organizationId,
    window
  );

  // FEA-3982 (wongk decision): a plugin's usage is its CHILDREN's pack rollup,
  // which carries no plugin-version dimension — the children aren't tied to the
  // plugin's content hash. So a plugin name that split into several version
  // buckets (e.g. a plugin.json updated A->B) must NOT have the full pack total
  // REPLACED into every version bucket (the double-count wongk flagged). Apply the
  // rollup to ONE canonical bucket per plugin name; the sibling version buckets
  // zero out (their child usage already lives on the canonical one).
  const seenPluginSlugs = new Set<string>();
  for (const plugin of plugins) {
    if (seenPluginSlugs.has(plugin.slug)) {
      zeroPluginUsage(plugin);
      continue;
    }
    seenPluginSlugs.add(plugin.slug);
    applyPackRollupToPlugin(plugin, byPack);
  }
}

/**
 * Zero a plugin version bucket's usage aggregates. Used when a plugin name split
 * into several version buckets: the child-usage pack rollup is version-agnostic,
 * so it is applied to ONE canonical bucket and the siblings report zero rather
 * than each REPLACING with the full (double-counted) pack total.
 */
function zeroPluginUsage(plugin: MergedComponent): void {
  plugin.totalInvocations = 0;
  plugin.totalErrors = 0;
  plugin.sessionIds = new Set();
  plugin.lastInvokedAt = null;
}

/**
 * Kinds that carry NO usage-tracking signal: they are intentionally never
 * materialized into `AgentComponentSessionUsage`, so they always report
 * `invocations=0`/`sessions=0` by design (see `listForOrg`'s doc block). A zero
 * windowed usage for these kinds is therefore not evidence of "no in-window
 * activity" — it is the permanent, expected state — so they must survive the
 * windowed zero-usage drop and stay visible under every window. Only
 * usage-trackable kinds are dropped when they have zero in-window usage.
 */
const NON_USAGE_TRACKED_KINDS: ReadonlySet<string> = new Set<string>([
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
]);

/**
 * FEA-3160: after every usage lane has been windowed to
 * `lastInvokedAt >= windowStart`, a merged entry with no in-window usage has
 * `totalInvocations === 0` AND `sessionIds.size === 0` — an all-time inventory
 * row the requested window is meant to exclude. (The former client-side filter
 * keyed off `lastSeenAt`, which the pack scanner refreshes to `now()` on every
 * sync, so windowing never actually excluded anything.) Drop those in place so
 * the windowed list, summary population, and pagination all reflect activity.
 * Only called when a window is set; the all-time view keeps zero-usage kinds.
 *
 * Kinds with no usage-tracking signal (`NON_USAGE_TRACKED_KINDS`: hook/config)
 * are EXEMPT: they always report zero usage by design, so dropping them on a
 * zero window would erase the entire kind under any window rather than hiding a
 * genuinely inactive component. They stay visible regardless of the window.
 */
function dropZeroWindowUsage(mergedMap: Map<string, MergedComponent>): void {
  for (const [slug, merged] of mergedMap) {
    if (NON_USAGE_TRACKED_KINDS.has(merged.kind)) {
      continue;
    }
    if (merged.totalInvocations === 0 && merged.sessionIds.size === 0) {
      mergedMap.delete(slug);
    }
  }
}

/**
 * The facets that narrow an org population read. `kinds`/`search` mirror the
 * catalog list's query facets; `window` scopes every usage lane by invocation
 * time (and drops usage-trackable components with zero in-window usage).
 */
export type OrgPopulationQuery = {
  organizationId: string;
  kinds?: readonly string[];
  search?: string;
  window?: UsageWindow;
};

/**
 * ISS-4635: build the ONE org-level component population both the catalog list
 * and the usage ranking read from — the version-keyed merge map, with every
 * usage lane folded in.
 *
 * Passes, in order:
 *  1. the org inventory read (`readOrgInventoryRows` — bounded by distinct
 *     component identity, not by a facet-scoped raw-row cap, per ISS-4797), with
 *     each row's coarse `contentHash` resolved to its exact linked
 *     `definitionHash`;
 *  2. `mergeComponentRows` — seeds one bucket per (subagent-normalized
 *     `${kind}::${key}` identity × version fingerprint);
 *  3. `foldFkUsageIntoMerged` — FK-linked usage, routed to the bucket matching
 *     the hash the usage row itself carried;
 *  4. `foldOrphanUsageIntoMerged` — ORPHAN usage: the rows no LIVE inventory
 *     row owns (null FK, or a tombstoned one — ISS-6180). This lane is why
 *     ranking used to report zero: `agentComponentId` is nullable, so a surface
 *     that reads only the FK-keyed rollup misses every usage row the component
 *     -sync lane never linked, and reports 0 for a component whose detail page
 *     reports real invocations;
 *  5. `applyPluginChildUsageRollup` — plugins carry no own usage rows, so theirs
 *     is the sum of their children's, by `pack_id`;
 *  6. `dropZeroWindowUsage` — only when a window bound is set.
 *
 * Returns the version-keyed map. Callers collapse it to canonical FAMILIES with
 * `collapseToCanonicalFamilies` before presenting rows or counting a `total`, so
 * both endpoints page and count over the same one-row-per-component population.
 */
export async function buildOrgComponentPopulation(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  query: OrgPopulationQuery
): Promise<Map<string, MergedComponent>> {
  const { organizationId, kinds, search } = query;
  const window = query.window ?? {};

  // 1. Fetch the org's inventory rows for the requested facets.
  // FEA-3758: harness is intentionally NOT pre-filtered at the DB level — the
  // displayed harness is derived from usage (not the inventory-row column), so
  // pre-filtering on the inventory harness would drop rows that should surface
  // (and vice-versa). The harness facet is applied post-fold on the derived value
  // instead (mirroring the owner/source facets).
  //
  // ISS-4797: the read is bounded by DISTINCT COMPONENT IDENTITY, not by a raw
  // row `take` applied after the facets — see `readOrgInventoryRows`. The old
  // shape let a `?kinds=` request retain components the unfiltered request had
  // truncated away, so per-kind totals summed ABOVE the All total and a stricter
  // filter grew the count.
  //
  // ISS-6180 (shafty023 review on #5039): this read is INSIDE the usage snapshot
  // below, not pooled ahead of it. Its ids bound the FK lane, and the usage-only
  // lane now evaluates `agentComponent.uninstalledAt` — so the two lanes are
  // partitioned by the same fact, and reading it on a different snapshot lets a
  // concurrent tombstone/restore break the partition: a tombstone committing in
  // between leaves the id in the FK lane AND admits the row to the usage-only
  // lane (double-count), while a restore drops it from both (undercount). Same
  // failure ISS-4669 fixed for the two usage lanes, reached through the liveness
  // predicate instead of the FK column.
  const { inventoryRows, usageGroups, orphanUsageRows } =
    await readUsageSnapshot(organizationId, { kinds, search }, window);

  // 1b. FEA-3982 (wongk): resolve each inventory row's coarse `contentHash` to
  // its exact linked `definitionHash`, so the seeded version bucket keys on the
  // same fingerprint the usage fold computes. `DefinitionVersion` rows are
  // immutable version provenance — neither the FK relink nor the tombstone the
  // snapshot above guards — so this read deliberately stays OUTSIDE the
  // usage-snapshot transaction rather than lengthening it.
  const inventoryDefinitionHashByIdentity =
    await resolveInventoryDefinitionHashes(
      db,
      organizationId,
      inventoryRows.map((row) => ({
        componentKind: row.componentKind,
        componentKey: row.componentKey,
        contentHash: row.contentHash,
      }))
    );
  const typedInventoryRows: InventoryRow[] = inventoryRows.map((row) => ({
    ...row,
    definitionHash: row.contentHash
      ? (inventoryDefinitionHashByIdentity.get(
          inventoryVersionIdentityKey(
            row.componentKind,
            row.componentKey,
            row.contentHash
          )
        ) ?? null)
      : null,
  }));

  const usageByComponentId = groupUsageByComponentId(usageGroups);

  // 2. Seed the version buckets from inventory (no usage folded yet).
  const mergedMap = mergeComponentRows(typedInventoryRows);

  // 2a. FEA-3982 (wongk decision): fold FK-linked usage into the version bucket
  // the usage row's OWN carried hash points at, not whichever inventory row
  // currently holds its FK.
  foldFkUsageIntoMerged(
    mergedMap,
    buildInventorySlugById(typedInventoryRows),
    usageByComponentId,
    MAX_ORG_INVENTORY_ROWS
  );

  // 2b. Fold in orphaned usage — the rows no live inventory row owns — so
  // invocation and session totals don't undercount when usage synced before its
  // inventory row, before the component-sync lane linked the FK, or after the
  // linked row was tombstoned (ISS-6180). Read above in the same snapshot as the
  // FK lane (ISS-4669).
  foldOrphanUsageIntoMerged(mergedMap, orphanUsageRows, MAX_ORG_INVENTORY_ROWS);

  // 2c. Roll up child usage into plugin-kind entries by pack_id. Plugins are
  // never invoked directly (no own usage rows), so their invocations/sessions are
  // the SUM of their child components' usage — matching the desktop reader so
  // every surface reports the same number.
  await applyPluginChildUsageRollup(db, mergedMap, organizationId, window);

  // 2d. FEA-3160 / FEA-3178: when a time window is requested (either bound
  // present), drop components with zero in-window usage. No bound ⇒ keep the
  // all-time inventory view (including zero-usage kinds like hook/config).
  if (window.start || window.end) {
    dropZeroWindowUsage(mergedMap);
  }

  return mergedMap;
}

/**
 * ISS-4669: interactive-transaction timeout for the shared FK-usage + orphan-usage
 * snapshot read in `buildOrgComponentPopulation`. Both reads are row-capped
 * aggregates that previously ran on the pool with no transaction timeout; wrapping
 * them in one `RepeatableRead` transaction otherwise inherits Prisma's 5s default.
 * 30s leaves generous headroom over the caps' real cost so the consistency fix
 * never regresses a large org into a transaction timeout.
 */
const USAGE_SNAPSHOT_TX_TIMEOUT_MS = 30_000;

/**
 * Read the list/ranking population's three snapshot-coupled reads — the org
 * INVENTORY scan, the FK-linked usage, and the usage-only (no-live-owner) usage —
 * inside ONE `RepeatableRead` interactive transaction, so all three observe the
 * SAME committed MVCC snapshot.
 *
 * ISS-4669 established this for the two USAGE lanes: run as separate pooled
 * reads, an `agentComponentId` relink committing between them mis-counts. A
 * null→id relink is absent from the FK snapshot AND excluded from the orphan
 * snapshot (dropped from both → undercount); an id→null relink is seen by BOTH
 * (invocations + errors double-counted, since the per-session Set dedups only the
 * session COUNT, not the summed totals).
 *
 * ISS-6180 (shafty023 review on #5039) pulled the INVENTORY read in as well. Once
 * the usage-only lane began partitioning on `agentComponent.uninstalledAt`, the
 * live-inventory bound stopped being "which rows exist" — a fact the usage
 * snapshot did not need — and became the very predicate that separates the two
 * usage lanes. Read on the pool ahead of the transaction it is a SECOND snapshot,
 * and a concurrent tombstone/restore breaks the partition in both directions: a
 * tombstone committing in between leaves the id in the FK lane's `in` bound while
 * the transaction ALSO sees `uninstalledAt != null` and admits the row to the
 * usage-only lane (double-count); a restore removes it from the pooled bound while
 * the transaction sees it as live and rejects it from the usage-only lane (dropped
 * from both → undercount).
 *
 * Reads only — no writes, so there is nothing to catch-and-continue past (AGENTS.md
 * tx rule). `withDb.tx` joins an ambient transaction when one already surrounds the
 * call, preserving that outer snapshot instead of opening a nested one.
 */
async function readUsageSnapshot(
  organizationId: string,
  facets: { kinds?: readonly string[]; search?: string },
  window: UsageWindow
) {
  const { kinds, search } = facets;
  return await withDb.tx(
    async (tx) => {
      const inventoryRows = await readOrgInventoryRows(tx, organizationId, {
        kinds: kinds ? [...kinds] : undefined,
        search,
      });
      // ISS-4660: computed ONCE and handed to both usage lanes, so the FK groupBy
      // and the usage-only read admit exactly the same identities under a
      // `?search=` facet. Derived from the rows read in THIS snapshot.
      const nameMatchedIdentities = collectNameMatchedIdentities(
        inventoryRows,
        search
      );
      const usageGroups = await loadUsageGroupsForInventory(
        tx,
        organizationId,
        inventoryRows.map((row) => row.id),
        window,
        // No content-hash scope in the list/ranking population read (that is a
        // detail route concern); the kind and search facets follow.
        null,
        kinds,
        { search, nameMatchedIdentities }
      );
      const orphanUsageRows = await loadOrphanUsageRows(
        tx,
        organizationId,
        { kinds, search, nameMatchedIdentities },
        window
      );
      return { inventoryRows, usageGroups, orphanUsageRows };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      // These reads (each an identity-capped aggregate — see
      // MAX_ORG_POPULATION_COMPONENTS) ran on the pool with no transaction timeout
      // before ISS-4669. Wrapping them in an interactive transaction bounds them by
      // Prisma's 5s default, so a pathological (but still capped) org that
      // previously returned slowly could start erroring. Raise the ceiling
      // generously so the consistency fix does not regress large orgs; the row caps
      // keep the real cost far below this.
      timeout: USAGE_SNAPSHOT_TX_TIMEOUT_MS,
    }
  );
}
