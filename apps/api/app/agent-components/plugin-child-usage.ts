import "server-only";

import {
  AgentComponentKind,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import type { Prisma, withDb } from "@repo/database";

// ---------------------------------------------------------------------------
// Plugin child-usage rollup + usage-window primitives (extracted from
// service.ts, FEA-4337). Plugin-kind components are never invoked directly, so
// their invocations/sessions are the SUM of their CHILD components' usage. This
// module owns HOW that child usage is loaded and attributed to a plugin's pack —
// the shared read reused by `listForOrg`, the detail view, the ranking
// leaderboard, and the pack-analytics overlay. Kept separate to shrink the
// grandfathered service.ts and give the rollup contract its own test target.
//
// The usage-window helpers live here too because they are shared verbatim by the
// direct-usage lane in service.ts and the child-usage lane here (SSOT).
// ---------------------------------------------------------------------------

/**
 * Hard cap on the child-usage / orphaned-usage rows folded into the org
 * aggregates, bounding the working set so a pathological org can never OOM or
 * time out the request.
 */
export const MAX_ORG_ORPHAN_USAGE_ROWS = 20_000;

/**
 * A usage window: an optional `lastInvokedAt` lower/upper bound. Each bound is
 * absent: no `start` ⇒ unbounded below, no `end` ⇒ unbounded above. When both
 * are absent the window is all-time and no predicate is emitted.
 */
export type UsageWindow = { start?: Date; end?: Date };

/**
 * Build the `lastInvokedAt` where-fragment for a usage window, or `{}` (no
 * predicate) when the window has neither bound. Single source of truth so every
 * usage lane windows identically: `start` → `gte`, `end` → `lte`. FEA-3178
 * adds the upper bound (`end`) so a bounded PRECEDING window can be fetched for
 * the period-over-period delta; the pre-FEA-3178 lower-bound-only behavior is
 * unchanged when `end` is absent.
 */
export function usageWindowWhere(window: UsageWindow): {
  lastInvokedAt?: { gte?: Date; lte?: Date };
} {
  const bound: { gte?: Date; lte?: Date } = {};
  if (window.start) {
    bound.gte = window.start;
  }
  if (window.end) {
    bound.lte = window.end;
  }
  return Object.keys(bound).length > 0 ? { lastInvokedAt: bound } : {};
}

/**
 * The set of pack ids a plugin identity rolls its child usage up over: every
 * pack id folded into the identity plus the plugin's own key (a plugin's own
 * `pack_id` usually equals its `componentKey`). Mirrors the desktop reader's
 * `pluginPackCandidates` in `shared-agent-components-api.ts` so both surfaces
 * derive plugin usage from the identical source.
 */
export function pluginPackCandidates(merged: {
  packIds: Set<string>;
  key: string | null;
}): Set<string> {
  const candidates = new Set<string>(merged.packIds);
  if (merged.key) {
    candidates.add(merged.key);
  }
  return candidates;
}

/**
 * Child-usage aggregate for one pack id: rolled-up invocations + sessions, plus
 * the max child `lastInvokedAt` so a plugin's real last-invocation time reflects
 * its most recently used child (plugins have no own usage rows — FEA-3179).
 */
export type PackUsageBucket = {
  invocations: number;
  errors: number;
  sessionIds: Set<string>;
  lastInvokedAt: Date | null;
};

/**
 * The `${componentKind}::${normalizedComponentKey}` natural identity of one
 * child usage or inventory row — the key the child-usage rollup joins on. Kept
 * identical to the desktop reader's `lower(trim(coalesce(...)))` normalization
 * (FEA-3239) so both surfaces match a child to its pack even when the usage
 * row's key differs from the inventory key only in case/whitespace.
 */
function childIdentityKey(
  componentKind: string,
  componentKey: string | null
): string {
  return `${componentKind}::${normalizeComponentKey(componentKey)}`;
}

/**
 * The child-inventory JOIN side of the plugin child-usage rollup, resolved once
 * per requested pack set:
 *  - `packIdsByIdentity`: child identity (`kind::key`) → the set of requested
 *    pack ids whose inventory carries that child. The orphan-FK fallback join.
 *  - `packIdByComponentId`: inventory row id → its pack id. Lets a usage row that
 *    DOES carry an authoritative `agentComponentId` FK be credited to that exact
 *    inventory row's pack (wongk review), instead of the org-global identity
 *    match — which could otherwise credit a compute-target-A usage row to a pack
 *    whose same `kind::key` exists only on compute-target B.
 *  - `identityPrefilter`: a Prisma `OR` of `(componentKind, componentKey CONTAINS
 *    normalizedKey case-insensitively)` predicates, so the usage read can be
 *    restricted to just these children in SQL BEFORE the
 *    `MAX_ORG_ORPHAN_USAGE_ROWS` cap — otherwise unrelated org child activity
 *    fills the cap and the requested pack rolls up to zero (wongk review). It is
 *    deliberately WIDER than the exact identity: `normalizeComponentKey` is
 *    `lower().trim()`, so a case/whitespace-variant usage key (`" Reviewer "` for
 *    inventory `reviewer`) must still be admitted (FEA-3239 desktop parity). A
 *    case-insensitive `contains` of the normalized (already lower+trim) key
 *    matches every such variant and can only ADMIT extra rows — never drop a real
 *    match — which the normalized JS re-match below then rejects. Empty
 *    normalized keys are skipped (a `contains: ""` would match every row).
 */
export type UsageIdentityPredicate = {
  componentKind: string;
  componentKey: { contains: string; mode: "insensitive" };
};

type ChildInventoryJoin = {
  packIdsByIdentity: Map<string, Set<string>>;
  packIdByComponentId: Map<string, string>;
  identityPrefilter: UsageIdentityPredicate[];
};

/**
 * FEA-4337: resolve the child-inventory JOIN for the requested packs (see
 * `ChildInventoryJoin`). A child usage row is attributed to a pack by its
 * authoritative `agentComponentId` FK when present, else by matching its
 * `(componentKind, componentKey)` to a child INVENTORY row's pack id — the FK is
 * nullable (usage can sync before the inventory row exists, or the FK-link lane
 * may not have run). Keying off the FK ALONE silently dropped every orphan-FK
 * child usage row, so plugins whose children were used but whose usage rows were
 * unlinked rolled up to zero — the bug this fixes. Mirrors the desktop reader's
 * natural-key join in `shared-agent-components-api.ts` (`pluginUsageSql`).
 */
async function loadChildInventoryJoin(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string
): Promise<ChildInventoryJoin> {
  const childInventory = await db.agentComponent.findMany({
    where: {
      organizationId,
      packId: { in: packIds },
      componentKind: { in: [...PLUGIN_CHILD_KINDS] },
      // ISS-6180: roll up only LIVE inventory children, the same
      // `uninstalledAt: null` scope `orgInventoryWhere` applies (see FEA-4086
      // there for why the predicate is required). Scanners tombstone rather than
      // delete and nothing clears the child's `packId`, so without this an
      // uninstalled child's invocations keep rolling into its plugin's total
      // while the SAME usage also surfaces as a standalone orphan row — one
      // invocation counted twice in one response.
      uninstalledAt: null,
      // A key-less inventory child cannot be joined to a usage row
      // (`AgentComponentSessionUsage.componentKey` is non-null), and it would
      // over-match every empty-key usage row — exactly the `component_key IS NOT
      // NULL` guard the desktop join keeps.
      componentKey: { not: null },
    },
    select: {
      id: true,
      componentKind: true,
      componentKey: true,
      packId: true,
    },
  });

  const packIdsByIdentity = new Map<string, Set<string>>();
  const packIdByComponentId = new Map<string, string>();
  const prefilterSeen = new Set<string>();
  const identityPrefilter: UsageIdentityPredicate[] = [];
  for (const child of childInventory) {
    if (!(child.packId && child.componentKey)) {
      continue;
    }
    packIdByComponentId.set(child.id, child.packId);
    const identity = childIdentityKey(child.componentKind, child.componentKey);
    let packs = packIdsByIdentity.get(identity);
    if (!packs) {
      packs = new Set<string>();
      packIdsByIdentity.set(identity, packs);
    }
    packs.add(child.packId);
    // Build the SQL prefilter from the NORMALIZED key so a case/whitespace
    // variant usage row is still admitted (FEA-3239). Skip empty normalized
    // keys — a `contains: ""` would match every child-kind usage row.
    const normalizedKey = normalizeComponentKey(child.componentKey);
    const prefilterKey = `${child.componentKind}::${normalizedKey}`;
    if (normalizedKey !== "" && !prefilterSeen.has(prefilterKey)) {
      prefilterSeen.add(prefilterKey);
      identityPrefilter.push({
        componentKind: child.componentKind,
        componentKey: { contains: normalizedKey, mode: "insensitive" },
      });
    }
  }
  return { packIdsByIdentity, packIdByComponentId, identityPrefilter };
}

/**
 * Query the org's child usage rows and group them by pack id via the child
 * INVENTORY join (`loadChildInventoryJoin`), so orphaned (null-FK) child usage
 * still rolls up to its plugin. Scoped to the org's sessions, restricted to the
 * requested packs' child identities, and windowed identically to the
 * direct-usage lane.
 *
 * Each usage row is attributed to EXACTLY ONE pack (see
 * `resolveUsagePackId`) — its authoritative `agentComponentId` FK's pack when
 * present, else one deterministic pack from its identity's matched set. That
 * one-row-one-pack partition is what keeps the list rollup honest: because a
 * plugin's `sumPluginChildUsage` adds the invocation/error totals of every
 * candidate pack bucket, a row folded into two of a plugin's candidate packs
 * would be summed twice (wongk review). Cross-pack SESSION overlap still
 * de-dupes correctly because `sumPluginChildUsage` unions the session sets.
 */
export async function loadChildUsageByPackId(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string,
  window: UsageWindow = {}
): Promise<Map<string, PackUsageBucket>> {
  if (packIds.length === 0) {
    return new Map<string, PackUsageBucket>();
  }
  const { packIdsByIdentity, packIdByComponentId, identityPrefilter } =
    await loadChildInventoryJoin(db, packIds, organizationId);
  if (identityPrefilter.length === 0) {
    return new Map<string, PackUsageBucket>();
  }

  const childUsage = await db.agentComponentSessionUsage.findMany({
    where: {
      componentKind: { in: [...PLUGIN_CHILD_KINDS] },
      // Prefilter to the requested packs' child identities BEFORE the cap so an
      // unrelated busy org can't fill MAX_ORG_ORPHAN_USAGE_ROWS and starve the
      // requested pack to zero (wongk review). The `OR` is a case-insensitive
      // `contains` of each NORMALIZED (lower+trim) key, so it admits every
      // case/whitespace variant the FEA-3239 JS re-match keeps — it can only
      // ADMIT extras (rejected in JS below), never drop a real match.
      OR: identityPrefilter,
      // ISS-6180 (shafty023 review): drop rows owned by a TOMBSTONED child while
      // keeping the null-FK natural-key fallback — see
      // `usageWithoutTombstonedInventoryWhere` for why the live-only inventory
      // join above does not cover this on its own. Nested under `AND` rather
      // than spread in, because `identityPrefilter` owns the top-level `OR` key
      // and a spread would silently replace it.
      AND: [usageWithoutTombstonedInventoryWhere()],
      session: {
        artifact: {
          organizationId,
        },
      },
      // FEA-3160 / FEA-3178: window a plugin's child usage the same way as
      // direct usage, so a plugin's rolled-up invocations/sessions reflect only
      // in-window child activity (and a plugin with no in-window children zeroes
      // out). Both bounds (start/end) apply.
      ...usageWindowWhere(window),
    },
    select: {
      agentSessionId: true,
      agentComponentId: true,
      componentKind: true,
      componentKey: true,
      invocationCount: true,
      errorCount: true,
      lastInvokedAt: true,
    },
    // Deterministic order so the MAX_ORG_ORPHAN_USAGE_ROWS cap drops a stable
    // tail (mirrors the detail read at `orderBy: lastInvokedAt desc` with `id`
    // as a unique tiebreak). Without it a busy org over the cap gets an
    // arbitrary subset that varies request-to-request, silently under-counting
    // plugin invocations/sessions and the pack-analytics overlay. The cap now
    // bounds only the requested packs' child usage (the identity prefilter
    // above), so it drops the requested plugin's own least-recent activity
    // rather than being consumed by unrelated org rows.
    orderBy: [
      { lastInvokedAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });

  const byPack = new Map<string, PackUsageBucket>();
  for (const usage of childUsage) {
    const packId = resolveUsagePackId(
      usage,
      packIdsByIdentity,
      packIdByComponentId
    );
    if (packId) {
      foldChildUsageIntoPackBucket(byPack, packId, usage);
    }
  }
  return byPack;
}

/**
 * Attribute one child usage row to exactly one pack. Precedence:
 *  1. its authoritative `agentComponentId` FK's pack, when the FK resolves to a
 *     requested pack's inventory row — the exact pack the writer linked, scoped
 *     to that inventory row's compute target (wongk review).
 *  2. otherwise (orphan FK, or FK to a non-requested pack) one deterministic
 *     pack from the row's normalized identity match. A deterministic pick — not
 *     a fold into every candidate pack — so the list rollup's per-pack sum can't
 *     double-count one row across a plugin's candidate packs.
 * Returns null when the row matches no requested pack (a coarse-prefilter
 * admission the normalized identity re-match rejected).
 */
function resolveUsagePackId(
  usage: {
    agentComponentId: string | null;
    componentKind: string;
    componentKey: string | null;
  },
  packIdsByIdentity: Map<string, Set<string>>,
  packIdByComponentId: Map<string, string>
): string | null {
  if (usage.agentComponentId) {
    const fkPackId = packIdByComponentId.get(usage.agentComponentId);
    if (fkPackId) {
      return fkPackId;
    }
  }
  const identity = childIdentityKey(usage.componentKind, usage.componentKey);
  const packs = packIdsByIdentity.get(identity);
  if (!packs) {
    return null;
  }
  return pickDeterministicPackId(packs);
}

/**
 * Deterministically pick one pack id from a child's matched set so a child that
 * appears under several packs is attributed to a stable one (lexicographic
 * min) — request-to-request stable, and never spreading one usage row across
 * multiple candidate-pack buckets.
 */
function pickDeterministicPackId(packs: Set<string>): string | null {
  let picked: string | null = null;
  for (const packId of packs) {
    if (picked === null || packId < picked) {
      picked = packId;
    }
  }
  return picked;
}

/** Accumulate one child usage row into its pack's rolled-up bucket. */
function foldChildUsageIntoPackBucket(
  byPack: Map<string, PackUsageBucket>,
  packId: string,
  usage: {
    agentSessionId: string;
    invocationCount: number;
    errorCount: number;
    lastInvokedAt: Date | null;
  }
): void {
  let bucket = byPack.get(packId);
  if (!bucket) {
    bucket = {
      invocations: 0,
      errors: 0,
      sessionIds: new Set(),
      lastInvokedAt: null,
    };
    byPack.set(packId, bucket);
  }
  bucket.invocations += usage.invocationCount;
  bucket.errors += usage.errorCount;
  bucket.sessionIds.add(usage.agentSessionId);
  if (
    usage.lastInvokedAt &&
    (!bucket.lastInvokedAt || usage.lastInvokedAt > bucket.lastInvokedAt)
  ) {
    bucket.lastInvokedAt = usage.lastInvokedAt;
  }
}

/**
 * FEA-4337: whether an identity `(kind, key)` maps to at least one of the given
 * candidate packs. Used by the plugin DETAIL rollup, whose per-session map is a
 * plain sum (not per-pack), so it counts a child's usage once regardless of how
 * many of the plugin's candidate packs carry that child.
 */
export function buildChildIdentityPackLookup(
  packIdsByIdentity: Map<string, Set<string>>
): (componentKind: string, componentKey: string | null) => boolean {
  return (componentKind, componentKey) =>
    packIdsByIdentity.has(childIdentityKey(componentKind, componentKey));
}

/**
 * The DETAIL-side child-identity lookup: the normalized `packIdsByIdentity`
 * membership map (fed to `buildChildIdentityPackLookup`) PLUS the SQL
 * `identityPrefilter`, so the detail's usage read can restrict to just this
 * plugin's children BEFORE the MAX_ORG_ORPHAN_USAGE_ROWS cap — the same
 * starvation fix as the list rollup (wongk review). The detail path attributes
 * each row at most once (a boolean `belongsToPlugin`), so it needs no per-row
 * pack partition, only the prefilter.
 */
export type DetailChildIdentityLookup = {
  packIdsByIdentity: Map<string, Set<string>>;
  identityPrefilter: UsageIdentityPredicate[];
};

/**
 * FEA-4337: the detail-side child-identity lookup (`DetailChildIdentityLookup`).
 * Wraps `loadChildInventoryJoin` for callers that build a per-session map rather
 * than per-pack buckets and so cannot reuse `loadChildUsageByPackId` directly.
 */
export async function loadDetailChildIdentityLookup(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string
): Promise<DetailChildIdentityLookup> {
  if (packIds.length === 0) {
    return {
      packIdsByIdentity: new Map<string, Set<string>>(),
      identityPrefilter: [],
    };
  }
  const { packIdsByIdentity, identityPrefilter } = await loadChildInventoryJoin(
    db,
    packIds,
    organizationId
  );
  return { packIdsByIdentity, identityPrefilter };
}

/**
 * The child-usage rollup for one plugin identity, summed over its candidate pack
 * ids: total invocations + errors, the union of distinct child sessions, and the
 * max child `lastInvokedAt`. A superset of what any single caller assigns — the
 * list view surfaces sessions/lastInvokedAt, the ranking leaderboard surfaces
 * sessions/errorRate — so each call site picks the fields its merged-entry type
 * carries.
 */
export type PluginChildUsageRollup = {
  invocations: number;
  errors: number;
  sessionIds: Set<string>;
  lastInvokedAt: Date | null;
};

/**
 * Sum a plugin's child usage across its candidate pack ids: invocations and
 * errors accumulate, sessions union (a session touching multiple child packs is
 * counted once), and `lastInvokedAt` takes the max. Single source of truth for
 * the per-pack summation shared by both `listForOrg`'s `applyPackRollupToPlugin`
 * and the ranking service's `applyPluginChildUsageRollup`, so the two surfaces
 * roll plugins up identically (including error accounting) rather than drifting
 * across two hand-maintained copies of the same loop.
 */
export function sumPluginChildUsage(
  candidatePackIds: Iterable<string>,
  byPack: Map<string, PackUsageBucket>
): PluginChildUsageRollup {
  let invocations = 0;
  let errors = 0;
  const sessionIds = new Set<string>();
  let lastInvokedAt: Date | null = null;
  for (const packId of candidatePackIds) {
    const bucket = byPack.get(packId);
    if (!bucket) {
      continue;
    }
    invocations += bucket.invocations;
    errors += bucket.errors;
    for (const sid of bucket.sessionIds) {
      sessionIds.add(sid);
    }
    if (
      bucket.lastInvokedAt &&
      (!lastInvokedAt || bucket.lastInvokedAt > lastInvokedAt)
    ) {
      lastInvokedAt = bucket.lastInvokedAt;
    }
  }
  return { invocations, errors, sessionIds, lastInvokedAt };
}

/**
 * Union every plugin identity's candidate pack ids and load the org's child
 * usage grouped by pack id in one query — the shared first half of the plugin
 * child-usage rollup used by both `listForOrg` and the ranking service. With no
 * pack association there is nothing to roll up: returns an empty map and every
 * plugin correctly zeroes out (plugin-own usage is never a real signal).
 */
export async function loadPluginChildUsage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  plugins: Array<{ packIds: Set<string>; key: string | null }>,
  organizationId: string,
  window: UsageWindow = {}
): Promise<Map<string, PackUsageBucket>> {
  const allPackIds = new Set<string>();
  for (const plugin of plugins) {
    for (const packId of pluginPackCandidates(plugin)) {
      allPackIds.add(packId);
    }
  }

  return allPackIds.size === 0
    ? new Map<string, PackUsageBucket>()
    : await loadChildUsageByPackId(db, [...allPackIds], organizationId, window);
}

/**
 * ISS-5534 (wongk review on #4902): the additive `packIds` half of one emitted
 * list row — the parent-pack identity a consumer needs to tell a plugin's
 * rolled-up total apart from the specific child rows it was rolled up FROM.
 *
 * A `plugin` emits the SAME candidate set its rollup summed over
 * ({@link pluginPackCandidates}), so the two can never disagree about what the
 * number covers; every other kind emits the packs the row itself belongs to.
 * Sorted so the wire shape is request-to-request stable, and OMITTED rather than
 * emitted as `[]`/`null` when there is nothing to say, per the repo's skew rule
 * for optional cross-boundary fields.
 *
 * See `AgentComponent.packIds` for how a reader must interpret absence: on a
 * plugin row it means the producer predates the field, on any other kind it
 * means the component belongs to no pack.
 */
export function emitPackIdentity(merged: {
  kind: string;
  key: string | null;
  packIds: Set<string>;
}): { packIds?: string[] } {
  const ids =
    merged.kind === AgentComponentKind.Plugin
      ? pluginPackCandidates(merged)
      : merged.packIds;
  const sorted = [...ids].sort();
  return sorted.length > 0 ? { packIds: sorted } : {};
}

/**
 * ISS-6180 (wongk review): "no LIVE inventory row owns this usage" — the
 * usage-only lane's admission test, shared verbatim by the list's
 * `loadOrphanUsageRows` and the detail's `fetchDetailOrphanUsage`.
 *
 * A null FK is the original orphan case: usage synced before its inventory row
 * existed, or the component-sync lane never linked it. A FK still pointing at a
 * TOMBSTONED row is the second, and it only became reachable once the child-usage
 * rollup above scoped itself to live children — every FK-keyed lane is bounded by
 * the ids of an `uninstalledAt: null` inventory read, so such a row belonged to NO
 * lane and its invocations vanished from every surface instead of surfacing once.
 *
 * Both lanes apply it or they disagree about the same component again (ISS-5363):
 * the list would fold a tombstoned child's usage into a synthetic row while its
 * detail page reported a hard zero. It stays DISJOINT from every FK lane, which
 * partitions on exactly the complement — an FK that resolves to a live row.
 */
export function usageWithoutLiveInventoryWhere(): Prisma.AgentComponentSessionUsageWhereInput {
  return {
    OR: [
      { agentComponentId: null },
      { agentComponent: { uninstalledAt: { not: null } } },
    ],
  };
}

/**
 * ISS-6180 (shafty023 review on #5039): the CHILD-USAGE lane's admission test —
 * "this row is not owned by a TOMBSTONED inventory row". A null FK is admitted,
 * because the natural-key fallback ({@link resolveUsagePackId}) exists precisely
 * to roll an unlinked child's usage up to its plugin; a FK resolving to a LIVE
 * row is admitted as the ordinary case; a FK resolving to a tombstoned row is
 * REJECTED.
 *
 * Scoping `loadChildInventoryJoin` to live children was NOT enough on its own.
 * When a live child and a tombstoned child share one `(kind, key)`, the live row
 * still contributes that identity to `packIdsByIdentity` and to the SQL
 * `identityPrefilter`, so the dead row's usage is admitted by the prefilter, its
 * FK misses the live-only `packIdByComponentId`, and `resolveUsagePackId` falls
 * back to the LIVE sibling's identity — rolling the tombstoned child's
 * invocations into the plugin while {@link usageWithoutLiveInventoryWhere} also
 * emits them as usage-only. One invocation, two places, which is the exact
 * double-count ISS-6180 set out to remove.
 *
 * NOT the complement of {@link usageWithoutLiveInventoryWhere}: the two overlap
 * on a null FK by design. The usage-only lane is a PARTITION member; this is an
 * OVERLAY (a plugin's total is the sum of its children), so a null-FK child row
 * legitimately both rolls up to its plugin and is recovered onto the child's own
 * identity row. Only the tombstoned-FK arm is disjoint, and that is the arm that
 * has to be.
 */
export function usageWithoutTombstonedInventoryWhere(): Prisma.AgentComponentSessionUsageWhereInput {
  return {
    OR: [
      { agentComponentId: null },
      { agentComponent: { uninstalledAt: null } },
    ],
  };
}
