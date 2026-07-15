import "server-only";

import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import {
  decodeComponentSlug,
  encodeComponentSlug,
} from "@repo/api/src/types/agent-component-analytics";
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import { LinkType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { agentSessionsService } from "../agent-sessions/service";
import { normalizeSubagentIdentity } from "./subagent-identity";
import type { AgentComponentListQuery } from "./validators";

// ---------------------------------------------------------------------------
// Memory bounds
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of org inventory rows `listForOrg` materializes before
 * its in-memory dedupe/sort/paginate (FEA-2923 review). The endpoint dedupes by
 * org-level identity in JS, so DB LIMIT/OFFSET cannot map 1:1 to the paginated
 * result; instead we bound the working set so a pathological org (tens of
 * thousands of inventory rows across many compute targets) can never OOM or
 * time out the request. 5000 pre-dedup rows comfortably exceeds any realistic
 * org's distinct-component count while keeping the payload bounded. If an org
 * ever exceeds this, the tail is dropped deterministically (rows are ordered)
 * rather than crashing the request — a follow-up would move dedupe into SQL.
 *
 * Shared `AGENT_COMPONENT_INVENTORY_CAP` so this DB read cap, the validator's
 * max request `limit`, and the desktop local clamp stay one value.
 */
const MAX_ORG_INVENTORY_ROWS = AGENT_COMPONENT_INVENTORY_CAP;

/**
 * Hard cap on orphaned (`agentComponentId IS NULL`) usage rows folded into the
 * org aggregates, for the same reason as `MAX_ORG_INVENTORY_ROWS`.
 */
const MAX_ORG_ORPHAN_USAGE_ROWS = 20_000;

/**
 * Hard cap on the number of session artifact ids fanned into the `IN (...)`
 * clauses of the two branch-attribution `artifactLink.findMany` queries in
 * `getDetailForOrg`. A popular component can be used in thousands of sessions;
 * an unbounded `IN` list bloats the query plan and can exceed parameter limits.
 * The excess sessions still count toward totals — only their per-session branch
 * attribution rows are bounded (most-recently-seen sessions win, since
 * `sessionIdSet` is populated in row order).
 */
const MAX_DETAIL_SESSION_IN_IDS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The org-level identity slug codec (`${kind}::${normalizedKey}`) is the shared
// SSOT `encodeComponentSlug`/`decodeComponentSlug` in
// `@repo/api/src/types/agent-component-analytics`. This cloud consumer keys the
// same identity space the desktop encodes into, so it must use the SSOT rather
// than a local copy — otherwise the two drift silently (FEA-3039 / FEA-3117).

/**
 * FEA-3160 / FEA-3178: the shared USAGE time-window bounds every usage lane
 * (direct sessionUsages, orphan usage, plugin child-usage rollup) filters on.
 * Both bounds are on `AgentComponentSessionUsage.lastInvokedAt`. Either may be
 * absent: no `start` ⇒ unbounded below, no `end` ⇒ unbounded above. When both
 * are absent the window is all-time and no predicate is emitted.
 */
type UsageWindow = { start?: Date; end?: Date };

/**
 * Build the `lastInvokedAt` where-fragment for a usage window, or `{}` (no
 * predicate) when the window has neither bound. Single source of truth so every
 * usage lane windows identically: `start` → `gte`, `end` → `lte`. FEA-3178
 * adds the upper bound (`end`) so a bounded PRECEDING window can be fetched for
 * the period-over-period delta; the pre-FEA-3178 lower-bound-only behavior is
 * unchanged when `end` is absent.
 */
function usageWindowWhere(window: UsageWindow): {
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

// ---------------------------------------------------------------------------
// listForOrg helpers
// ---------------------------------------------------------------------------

type MergedComponent = {
  id: string; // first encountered row id (canonical representative)
  kind: string;
  key: string;
  name: string | null;
  harness: string | null;
  sourceUrl: string | null;
  computeTargetIds: string[];
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  // Max `AgentComponentSessionUsage.lastInvokedAt` across every usage row folded
  // into this identity — the component's real last-invocation time (a genuine
  // usage-recency signal), as opposed to `lastSeenAt` (inventory-observation
  // time the pack scanner refreshes to now() every sync). Null when the identity
  // has no usage rows at all. Powers the "active in the last hour" dot (FEA-3179)
  // and is the honest counterpart to the FEA-3160 usage windowing.
  lastInvokedAt: Date | null;
  // Every distinct `pack_id` folded into this identity across inventory rows.
  // For plugin-kind entries this is the set of packs whose CHILD usage rolls up
  // into the plugin's invocations/sessions (see `applyPluginChildUsageRollup`).
  packIds: Set<string>;
  // Org-wide usage aggregation across all inventory rows
  totalInvocations: number;
  sessionIds: Set<string>;
  ownerIds: Set<string>;
  ownerDisplayNames: string[];
};

type InventoryRow = {
  id: string;
  organizationId: string;
  computeTargetId: string;
  componentKind: string;
  externalComponentId: string;
  harness: string | null;
  name: string | null;
  componentKey: string | null;
  sourceUrl: string | null;
  installPath: string | null;
  packId: string | null;
  scope: string | null;
  projectPath: string | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  computeTarget: {
    id: string;
    userId: string;
    user: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string;
    } | null;
  };
  sessionUsages: Array<{
    agentSessionId: string;
    invocationCount: number;
    lastInvokedAt: Date | null;
    session: {
      artifactId: string;
      userId: string;
      artifact: {
        organizationId: string;
      } | null;
    };
  }>;
};

// The Claude parser names every typeless subagent spawn with an
// instance-unique label ("Claude subagent <8 hex>"), so pre-rollup installs
// synced one inventory row per spawn. `normalizeSubagentIdentity` (shared with
// the token-trend drill-down via `./subagent-identity`) collapses those to a
// single 'general-purpose' identity at read time so the listing rolls them up
// regardless of what was synced.
function mergeComponentRows(
  inventoryRows: InventoryRow[],
  organizationId: string
): Map<string, MergedComponent> {
  const mergedMap = new Map<string, MergedComponent>();

  for (const row of inventoryRows) {
    const { key: normKey, name: normName } = normalizeSubagentIdentity(
      row.componentKind,
      row.componentKey,
      row.name
    );
    const slug = encodeComponentSlug(row.componentKind, normKey, normName);

    let merged = mergedMap.get(slug);
    if (!merged) {
      merged = {
        id: row.id,
        kind: row.componentKind,
        key: (normKey ?? normName ?? "").toLowerCase().trim(),
        name: normName,
        harness: row.harness,
        sourceUrl: row.sourceUrl,
        computeTargetIds: [],
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        // Seeded from usage rows below (aggregateUsageIntoMerged), not from the
        // inventory row's observation timestamps.
        lastInvokedAt: null,
        packIds: new Set(),
        totalInvocations: 0,
        sessionIds: new Set(),
        ownerIds: new Set(),
        ownerDisplayNames: [],
      };
      mergedMap.set(slug, merged);
    }

    // Per-device provenance
    merged.computeTargetIds.push(row.computeTargetId);
    if (row.packId) {
      merged.packIds.add(row.packId);
    }

    // Timestamps: min firstSeenAt, max lastSeenAt
    if (
      row.firstSeenAt &&
      (!merged.firstSeenAt || row.firstSeenAt < merged.firstSeenAt)
    ) {
      merged.firstSeenAt = row.firstSeenAt;
    }
    if (
      row.lastSeenAt &&
      (!merged.lastSeenAt || row.lastSeenAt > merged.lastSeenAt)
    ) {
      merged.lastSeenAt = row.lastSeenAt;
    }

    aggregateUsageIntoMerged(merged, row.sessionUsages, organizationId);
    trackOwner(merged, row.computeTarget.user);
  }

  return mergedMap;
}

/**
 * Widen `merged.lastInvokedAt` to the later of its current value and `candidate`
 * — the running max real-invocation time across every usage row folded into the
 * identity (see MergedComponent.lastInvokedAt). No-op when `candidate` is null.
 */
function bumpLastInvokedAt(
  merged: MergedComponent,
  candidate: Date | null
): void {
  if (
    candidate &&
    (!merged.lastInvokedAt || candidate > merged.lastInvokedAt)
  ) {
    merged.lastInvokedAt = candidate;
  }
}

function aggregateUsageIntoMerged(
  merged: MergedComponent,
  sessionUsages: InventoryRow["sessionUsages"],
  organizationId: string
): void {
  for (const usage of sessionUsages) {
    // Org-scope guard (already filtered in query, belt-and-suspenders)
    if (usage.session.artifact?.organizationId !== organizationId) {
      continue;
    }
    merged.totalInvocations += usage.invocationCount;
    merged.sessionIds.add(usage.agentSessionId);
    bumpLastInvokedAt(merged, usage.lastInvokedAt);
  }
}

/**
 * Owner display name from a user record: "First Last" when either name is
 * present, else the email. Single source of truth for both the inventory merge
 * (`trackOwner`) and the per-pack analytics owner rollup (`getPackAnalytics`).
 */
function resolveOwnerDisplayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  return (
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email
  );
}

function trackOwner(
  merged: MergedComponent,
  user: InventoryRow["computeTarget"]["user"]
): void {
  if (user && !merged.ownerIds.has(user.id)) {
    merged.ownerIds.add(user.id);
    merged.ownerDisplayNames.push(resolveOwnerDisplayName(user));
  }
}

/**
 * A usage row that has no `agentComponentId` FK yet (usage synced before the
 * inventory row existed, or the component-sync lane hasn't linked it). These
 * rows are invisible to the FK-based `sessionUsages` relation walk, so they are
 * fetched separately and folded into the matching org-identity merge entry by
 * `(componentKind, componentKey)` — otherwise invocation/session totals would
 * silently undercount depending on sync ordering.
 *
 * When no inventory row shares the identity, the orphan usage is the ONLY
 * cloud-side evidence that the org used the component (Gap B: session-sync
 * already delivers `AgentComponentSessionUsage`, but no inventory row exists
 * because the component was never collected as installed). Such rows now
 * SEED a synthetic merged entry so the component still surfaces in the list.
 */
type OrphanUsageRow = {
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  // `AgentComponentSessionUsage` carries no display `name`; synthetic entries
  // fall back to `componentKey` for their label.
  harness: string | null;
  invocationCount: number;
  firstInvokedAt: Date | null;
  lastInvokedAt: Date | null;
};

/**
 * Fold orphaned (null-FK) usage rows into merged entries by identity slug.
 * Because `AgentComponentSessionUsage` is unique on
 * `(agentSessionId, componentKind, componentKey)`, a given usage row is either
 * FK-linked (already counted via the relation walk) or orphaned (counted here)
 * — never both, so there is no double count.
 *
 * When an orphan's identity has no inventory row, a synthetic merged entry is
 * created from the usage row's own fields (Gap B fast fix) so components a user
 * only USED (never had collected as installed inventory) still surface. The
 * synthetic entry is keyed by the same `encodeComponentSlug(...)`, so if a real
 * inventory row later appears it MERGES into the same entry rather than
 * duplicating. Synthetic-entry creation respects `MAX_ORG_INVENTORY_ROWS` so
 * the total working set (inventory + synthetic) stays bounded.
 */
function foldOrphanUsageIntoMerged(
  mergedMap: Map<string, MergedComponent>,
  orphanUsages: OrphanUsageRow[]
): void {
  for (const usage of orphanUsages) {
    // Roll up instance-unique subagent usage the same way inventory rows are
    // normalized (see normalizeSubagentIdentity), so orphan (usage-only)
    // subagent rows collapse into the single 'general-purpose' entry too.
    const { key: normKey } = normalizeSubagentIdentity(
      usage.componentKind,
      usage.componentKey,
      null
    );
    const slug = encodeComponentSlug(usage.componentKind, normKey, null);
    let merged = mergedMap.get(slug);
    if (!merged) {
      // No inventory row for this identity — surface it as a synthetic entry
      // seeded from the usage row, subject to the working-set cap.
      if (mergedMap.size >= MAX_ORG_INVENTORY_ROWS) {
        continue;
      }
      merged = {
        // No canonical inventory row id exists; use the identity slug as a
        // stable, deterministic id. Detail lookups re-resolve by slug, not id,
        // so this synthetic id never needs to match a real row.
        id: slug,
        kind: usage.componentKind,
        key: (normKey ?? "").toLowerCase().trim(),
        // No display name on the usage row; the response falls back to `key`.
        name: null,
        harness: usage.harness,
        sourceUrl: null,
        // No installed inventory ⇒ no compute-target provenance to attribute.
        computeTargetIds: [],
        firstSeenAt: usage.firstInvokedAt,
        lastSeenAt: usage.lastInvokedAt,
        lastInvokedAt: null,
        packIds: new Set(),
        totalInvocations: 0,
        sessionIds: new Set(),
        ownerIds: new Set(),
        ownerDisplayNames: [],
      };
      mergedMap.set(slug, merged);
    }
    // Timestamps: widen to min firstSeen / max lastSeen using invocation times.
    if (
      usage.firstInvokedAt &&
      (!merged.firstSeenAt || usage.firstInvokedAt < merged.firstSeenAt)
    ) {
      merged.firstSeenAt = usage.firstInvokedAt;
    }
    if (
      usage.lastInvokedAt &&
      (!merged.lastSeenAt || usage.lastInvokedAt > merged.lastSeenAt)
    ) {
      merged.lastSeenAt = usage.lastInvokedAt;
    }
    bumpLastInvokedAt(merged, usage.lastInvokedAt);
    merged.totalInvocations += usage.invocationCount;
    merged.sessionIds.add(usage.agentSessionId);
  }
}

/**
 * The set of pack ids a plugin identity rolls its child usage up over: every
 * pack id folded into the identity plus the plugin's own key (a plugin's own
 * `pack_id` usually equals its `componentKey`). Mirrors the desktop reader's
 * `pluginPackCandidates` in `shared-agent-components-api.ts` so both surfaces
 * derive plugin usage from the identical source.
 */
function pluginPackCandidates(merged: MergedComponent): Set<string> {
  const candidates = new Set<string>(merged.packIds);
  if (merged.key) {
    candidates.add(merged.key);
  }
  return candidates;
}

/**
 * FEA-2923 (soul review): plugin-kind components are never invoked directly, so
 * they have NO usage rows of their own. Their invocations/sessions are the SUM
 * of their CHILD components' usage — the same `pack_id` child-usage rollup the
 * desktop reader (`PLUGIN_USAGE_SQL` in `shared-agent-components-api.ts`)
 * performs. Without this, the cloud would attribute a plugin's usage solely from
 * its own (always-empty) usage rows and every plugin would surface with
 * invocations=0/sessions=0 — diverging from the desktop, which rolls up children.
 *
 * We REPLACE (not add to) each plugin entry's usage aggregates with the child
 * rollup: plugin-own usage rows do not exist in the real sync pipeline, so
 * there is nothing to double-count. Child usage is matched by the child
 * inventory row's `packId` (via the `agentComponent` FK relation), scoped to the
 * org's sessions, and restricted to the invocation-carrying child kinds
 * (skill/command/subagent/mcp) — identical to the desktop predicate.
 */
/**
 * Child-usage aggregate for one pack id: rolled-up invocations + sessions, plus
 * the max child `lastInvokedAt` so a plugin's real last-invocation time reflects
 * its most recently used child (plugins have no own usage rows — FEA-3179).
 */
type PackUsageBucket = {
  invocations: number;
  sessionIds: Set<string>;
  lastInvokedAt: Date | null;
};

/** Query + group the org's child usage rows by their pack id. */
async function loadChildUsageByPackId(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string,
  window: UsageWindow = {}
): Promise<Map<string, PackUsageBucket>> {
  const childUsage = await db.agentComponentSessionUsage.findMany({
    where: {
      componentKind: { in: ["skill", "command", "subagent", "mcp"] },
      agentComponent: {
        packId: { in: packIds },
      },
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
      invocationCount: true,
      lastInvokedAt: true,
      agentComponent: {
        select: {
          packId: true,
        },
      },
    },
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });

  const byPack = new Map<string, PackUsageBucket>();
  for (const usage of childUsage) {
    const packId = usage.agentComponent?.packId;
    if (!packId) {
      continue;
    }
    let bucket = byPack.get(packId);
    if (!bucket) {
      bucket = { invocations: 0, sessionIds: new Set(), lastInvokedAt: null };
      byPack.set(packId, bucket);
    }
    bucket.invocations += usage.invocationCount;
    bucket.sessionIds.add(usage.agentSessionId);
    if (
      usage.lastInvokedAt &&
      (!bucket.lastInvokedAt || usage.lastInvokedAt > bucket.lastInvokedAt)
    ) {
      bucket.lastInvokedAt = usage.lastInvokedAt;
    }
  }
  return byPack;
}

/**
 * REPLACE a plugin entry's usage aggregates with the child rollup summed over
 * its candidate packs (sessions unioned so a session touching multiple child
 * packs is counted once). Plugins have no real own-usage rows to preserve.
 */
function applyPackRollupToPlugin(
  plugin: MergedComponent,
  byPack: Map<string, PackUsageBucket>
): void {
  let invocations = 0;
  const sessionIds = new Set<string>();
  let lastInvokedAt: Date | null = null;
  for (const packId of pluginPackCandidates(plugin)) {
    const bucket = byPack.get(packId);
    if (!bucket) {
      continue;
    }
    invocations += bucket.invocations;
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
  plugin.totalInvocations = invocations;
  plugin.sessionIds = sessionIds;
  // Plugins carry no own usage rows, so their last-invocation time is the max
  // across rolled-up child usage (REPLACE, consistent with invocations/sessions).
  plugin.lastInvokedAt = lastInvokedAt;
}

async function applyPluginChildUsageRollup(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  mergedMap: Map<string, MergedComponent>,
  organizationId: string,
  window: UsageWindow = {}
): Promise<void> {
  const plugins = [...mergedMap.values()].filter((m) => m.kind === "plugin");
  if (plugins.length === 0) {
    return;
  }

  // Union of every candidate pack id across all plugin entries — one query
  // fetches all child usage, then each plugin sums only the packs it owns.
  const allPackIds = new Set<string>();
  for (const plugin of plugins) {
    for (const packId of pluginPackCandidates(plugin)) {
      allPackIds.add(packId);
    }
  }

  // With no pack association there is nothing to roll up; `loadChildUsageByPackId`
  // returns an empty map and every plugin correctly zeroes out (plugin-own usage
  // is never a real signal).
  const byPack =
    allPackIds.size === 0
      ? new Map<string, PackUsageBucket>()
      : await loadChildUsageByPackId(
          db,
          [...allPackIds],
          organizationId,
          window
        );

  for (const plugin of plugins) {
    applyPackRollupToPlugin(plugin, byPack);
  }
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

// ---------------------------------------------------------------------------
// KLOC/$ efficiency metric (FEA-2923 follow-up)
// ---------------------------------------------------------------------------

/**
 * Per-session local-git LOC + cost, keyed by session id (SessionDetail.artifactId).
 * `loc` is the total lines changed (linesAdded + linesRemoved) the session
 * produced — mirroring the org KLOC "totalLines" definition in
 * `apps/api/app/insights/service.ts` (added + deleted, not additions only).
 * `cost` is the session's `estimatedCost` in USD (Decimal → number).
 *
 * These are the *local-git enrichment* scalars synced from the desktop
 * (`SessionDetail.lines_added/lines_removed`, provenance `loc_source`); they are
 * the day-0 KLOC signal available BEFORE any GitHub connection (governing design:
 * KLOC is never gated behind GitHub — only Owner attribution is).
 */
type SessionLocCost = { loc: number; cost: number };

/**
 * Load the local-git LOC + cost for a set of session ids (SessionDetail rows).
 * One bounded query; sessions with no LOC scalars contribute 0 loc (and their
 * cost still counts, so a component whose sessions produced no measurable lines
 * honestly reports `klocPerDollar = null` rather than a fabricated number).
 */
async function loadSessionLocCost(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  sessionIds: string[]
): Promise<Map<string, SessionLocCost>> {
  const byId = new Map<string, SessionLocCost>();
  if (sessionIds.length === 0) {
    return byId;
  }
  const rows = await db.sessionDetail.findMany({
    where: {
      // SessionDetail has no organizationId column — org scope lives on the
      // parent Artifact (mirrors the usage-fold guards elsewhere in this file).
      artifact: { organizationId },
      artifactId: { in: sessionIds },
    },
    select: {
      artifactId: true,
      linesAdded: true,
      linesRemoved: true,
      estimatedCost: true,
    },
  });
  for (const row of rows) {
    const loc = (row.linesAdded ?? 0) + (row.linesRemoved ?? 0);
    // `estimatedCost` is a Prisma Decimal; Number() is safe for the USD-scale
    // magnitudes here and keeps the DTO a plain number.
    const cost = Number(row.estimatedCost ?? 0);
    byId.set(row.artifactId, { loc, cost });
  }
  return byId;
}

/**
 * KLOC/$ for one component = (thousands of lines produced by the sessions that
 * used it) / (their summed cost). Sessions are deduped by id (a component can
 * carry multiple usage rows per session — e.g. per-branch buckets — but each
 * session's LOC + cost must count exactly once). Returns null when the summed
 * cost is 0 or the sessions produced no measurable lines (never a fabricated
 * or divide-by-zero number).
 */
function computeKlocPerDollar(
  sessionIds: Iterable<string>,
  locCostBySession: Map<string, SessionLocCost>
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

/**
 * Fetch the LOC + cost for every session referenced across the merged component
 * set (union of each entry's `sessionIds`), in one bounded query. Returns the
 * per-session lookup consumed by {@link computeKlocPerDollar}.
 */
function loadLocCostForMerged(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  mergedMap: Map<string, MergedComponent>
): Promise<Map<string, SessionLocCost>> {
  const allSessionIds = new Set<string>();
  for (const merged of mergedMap.values()) {
    for (const sessionId of merged.sessionIds) {
      allSessionIds.add(sessionId);
    }
  }
  return loadSessionLocCost(db, organizationId, [...allSessionIds]);
}

function sortAndPaginate(
  entries: MergedComponent[],
  sortBy: string | undefined,
  sortDir: string | undefined,
  limit: number,
  offset: number
): { page: MergedComponent[]; total: number } {
  const direction = sortDir === AgentComponentSortDir.Desc ? -1 : 1;
  const sortColumn =
    (sortBy as AgentComponentSortKey | undefined) ??
    AgentComponentSortKey.Invocations;

  entries.sort((a, b) => {
    let cmp = 0;
    switch (sortColumn) {
      case AgentComponentSortKey.Name:
        cmp = (a.name ?? a.key).localeCompare(b.name ?? b.key);
        break;
      case AgentComponentSortKey.Type:
        cmp = a.kind.localeCompare(b.kind);
        break;
      case AgentComponentSortKey.Invocations:
        cmp = (a.totalInvocations ?? 0) - (b.totalInvocations ?? 0);
        break;
      case AgentComponentSortKey.Sessions:
        cmp = a.sessionIds.size - b.sessionIds.size;
        break;
      case AgentComponentSortKey.Owner:
        cmp = (a.ownerDisplayNames[0] ?? "").localeCompare(
          b.ownerDisplayNames[0] ?? ""
        );
        break;
      case AgentComponentSortKey.Harness:
        cmp = (a.harness ?? "").localeCompare(b.harness ?? "");
        break;
      default:
        cmp = (a.totalInvocations ?? 0) - (b.totalInvocations ?? 0);
    }
    if (cmp !== 0) {
      return cmp * direction;
    }
    // Stable secondary sort on the canonical row id so rows with equal primary
    // sort keys keep a deterministic order across requests — otherwise offset
    // paging can skip or repeat a row at a page boundary. Applied in a fixed
    // ascending direction (not multiplied by `direction`) so the tiebreaker is
    // identical regardless of the primary sort direction.
    return a.id.localeCompare(b.id);
  });

  const total = entries.length;
  const page = entries.slice(offset, offset + limit);
  return { page, total };
}

// ---------------------------------------------------------------------------
// getDetailForOrg helpers
// ---------------------------------------------------------------------------

type DetailInventoryRow = {
  id: string;
  computeTargetId: string;
  componentKind: string;
  componentKey: string | null;
  externalComponentId: string;
  harness: string | null;
  name: string | null;
  sourceUrl: string | null;
  installPath: string | null;
  packId: string | null;
  scope: string | null;
  projectPath: string | null;
  description: string | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  computeTarget: {
    id: string;
    userId: string;
    user: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string;
    } | null;
  };
  sessionUsages: Array<{
    agentSessionId: string;
    invocationCount: number;
    // FEA-2990: per-event branch attribution. '' is the "no per-event branch"
    // sentinel — those buckets fall back to session-level SessionBranch.
    gitBranch: string;
    session: {
      artifactId: string;
      artifact: {
        organizationId: string;
      } | null;
    };
  }>;
};

/**
 * FEA-2923 (soul review): plugin-detail per-session invocation map, built from
 * CHILD usage rolled up by `pack_id` — the plugin has no direct usage rows of
 * its own. Candidate packs = every `packId` on the plugin's inventory rows plus
 * the identity key (a plugin's own pack_id usually equals its componentKey),
 * mirroring `pluginPackCandidates` / the desktop `PLUGIN_USAGE_SESSIONS_SQL`.
 * Returns a session_id → summed-invocations map so the plugin detail's totals,
 * `usageSessions`, and `sessionsTab` are derived from the same source as the
 * list view's rollup (and as the desktop).
 */
async function buildPluginChildInvCountBySession(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  inventoryRows: DetailInventoryRow[],
  identityKey: string
): Promise<Map<string, number>> {
  const candidatePacks = new Set<string>();
  for (const row of inventoryRows) {
    if (row.packId) {
      candidatePacks.add(row.packId);
    }
  }
  if (identityKey) {
    candidatePacks.add(identityKey);
  }
  const bySession = new Map<string, number>();
  if (candidatePacks.size === 0) {
    return bySession;
  }
  const childUsage = await db.agentComponentSessionUsage.findMany({
    where: {
      componentKind: { in: ["skill", "command", "subagent", "mcp"] },
      agentComponent: {
        packId: { in: [...candidatePacks] },
      },
      session: {
        artifact: {
          organizationId,
        },
      },
    },
    select: {
      agentSessionId: true,
      invocationCount: true,
    },
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });
  for (const usage of childUsage) {
    const prev = bySession.get(usage.agentSessionId) ?? 0;
    bySession.set(usage.agentSessionId, prev + usage.invocationCount);
  }
  return bySession;
}

function buildProvenance(
  inventoryRows: DetailInventoryRow[]
): AgentComponentDetail["provenance"] {
  return inventoryRows.map((row) => ({
    computeTargetId: row.computeTargetId,
    installPath: row.installPath ?? undefined,
    scope: row.scope ?? undefined,
    projectPath: row.projectPath ?? undefined,
  }));
}

function aggregateDetailUsage(
  inventoryRows: DetailInventoryRow[],
  organizationId: string
): {
  totalInvocations: number;
  sessionIdSet: Set<string>;
  ownerDisplayNames: string[];
} {
  let totalInvocations = 0;
  const sessionIdSet = new Set<string>();
  const ownerIds = new Set<string>();
  const ownerDisplayNames: string[] = [];

  for (const row of inventoryRows) {
    const user = row.computeTarget.user;
    if (user && !ownerIds.has(user.id)) {
      ownerIds.add(user.id);
      const displayName =
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        user.email;
      ownerDisplayNames.push(displayName);
    }

    for (const usage of row.sessionUsages) {
      if (usage.session.artifact?.organizationId !== organizationId) {
        continue;
      }
      totalInvocations += usage.invocationCount;
      sessionIdSet.add(usage.agentSessionId);
    }
  }

  return { totalInvocations, sessionIdSet, ownerDisplayNames };
}

function buildInvCountBySession(
  inventoryRows: DetailInventoryRow[],
  organizationId: string
): Map<string, number> {
  const invCountBySession = new Map<string, number>();
  for (const row of inventoryRows) {
    for (const usage of row.sessionUsages) {
      if (usage.session.artifact?.organizationId !== organizationId) {
        continue;
      }
      const prev = invCountBySession.get(usage.agentSessionId) ?? 0;
      invCountBySession.set(usage.agentSessionId, prev + usage.invocationCount);
    }
  }
  return invCountBySession;
}

/**
 * FEA-2990: '' is the "no per-event branch" sentinel used by
 * {@link buildPerBranchInvBySession} / {@link buildUsageSessions} to mark a
 * usage bucket that carried no per-event git_branch (Codex, legacy pre-column
 * events, non-tool kinds). Those buckets fall back to session-level
 * `SessionBranch` attribution at read time.
 */
const NO_BRANCH_SENTINEL = "";

/**
 * FEA-2990: fold usage rows into per-(session, branch) invocation counts. A
 * session that switched branches mid-run yields multiple non-'' buckets;
 * branch-less usage collapses into the '' bucket. {@link buildUsageSessions}
 * resolves '' to the session-level branch and emits the finer split otherwise.
 */
function buildPerBranchInvBySession(
  inventoryRows: DetailInventoryRow[],
  organizationId: string
): Map<string, Map<string, number>> {
  const perBranch = new Map<string, Map<string, number>>();
  for (const row of inventoryRows) {
    for (const usage of row.sessionUsages) {
      if (usage.session.artifact?.organizationId !== organizationId) {
        continue;
      }
      addPerBranchInvocation(
        perBranch,
        usage.agentSessionId,
        usage.gitBranch,
        usage.invocationCount
      );
    }
  }
  return perBranch;
}

/** Accumulate one usage row's invocations into the per-(session, branch) map. */
function addPerBranchInvocation(
  perBranch: Map<string, Map<string, number>>,
  sessionId: string,
  gitBranch: string | null | undefined,
  invocationCount: number
): void {
  const branch = gitBranch ?? NO_BRANCH_SENTINEL;
  let byBranch = perBranch.get(sessionId);
  if (!byBranch) {
    byBranch = new Map<string, number>();
    perBranch.set(sessionId, byBranch);
  }
  byBranch.set(branch, (byBranch.get(branch) ?? 0) + invocationCount);
}

type DetailInvocationCounts = {
  invCountBySession: Map<string, number>;
  totalInvocations: number;
  sessionIdSet: Set<string>;
};

/**
 * Resolve the per-session invocation map + effective totals for a component
 * detail. Plugins roll up child usage by pack_id (they have no direct usage
 * rows — matching `applyPluginChildUsageRollup` in the list view + the desktop
 * reader); every other kind folds its FK-linked + orphan usage. Extracted from
 * `getDetailForOrg` to keep that method within the complexity budget.
 */
async function resolveDetailInvocationCounts(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  params: {
    kind: string;
    key: string;
    organizationId: string;
    typedRows: DetailInventoryRow[];
    orphanUsages: readonly DetailOrphanUsageRow[];
    linkedTotalInvocations: number;
    linkedSessionIdSet: Set<string>;
  }
): Promise<DetailInvocationCounts> {
  if (params.kind === "plugin") {
    const invCountBySession = await buildPluginChildInvCountBySession(
      db,
      params.organizationId,
      params.typedRows,
      params.key
    );
    let totalInvocations = 0;
    for (const count of invCountBySession.values()) {
      totalInvocations += count;
    }
    return {
      invCountBySession,
      totalInvocations,
      sessionIdSet: new Set(invCountBySession.keys()),
    };
  }

  const invCountBySession = buildInvCountBySession(
    params.typedRows,
    params.organizationId
  );
  for (const usage of params.orphanUsages) {
    const prev = invCountBySession.get(usage.agentSessionId) ?? 0;
    invCountBySession.set(usage.agentSessionId, prev + usage.invocationCount);
  }
  return {
    invCountBySession,
    totalInvocations: params.linkedTotalInvocations,
    sessionIdSet: params.linkedSessionIdSet,
  };
}

type BranchLinkRow = {
  sourceId: string;
  metadata: unknown;
  target: {
    branch: {
      branchName: string;
    } | null;
  } | null;
};

function buildBranchNameBySession(
  branchLinks: BranchLinkRow[]
): Map<string, string> {
  const branchNameBySession = new Map<string, string>();
  for (const link of branchLinks) {
    const meta = link.metadata as Record<string, unknown> | null;
    if (!meta) {
      continue;
    }

    const linkKind = meta.linkKind as string | undefined;
    const linkKinds = meta.linkKinds as string[] | undefined;
    const isSessionBranch =
      linkKind === SessionArtifactLinkKind.SessionBranch ||
      (Array.isArray(linkKinds) &&
        linkKinds.includes(SessionArtifactLinkKind.SessionBranch));

    if (!isSessionBranch) {
      continue;
    }
    if (branchNameBySession.has(link.sourceId)) {
      continue; // first link wins
    }

    const branchName =
      (meta.branchName as string | undefined) ??
      link.target?.branch?.branchName ??
      null;

    if (branchName) {
      branchNameBySession.set(link.sourceId, branchName);
    }
  }
  return branchNameBySession;
}

/**
 * FEA-2990: build usageSessions from per-(session, branch) usage. For each
 * session, every non-'' branch bucket becomes its own entry attributed to the
 * precise per-event branch; the '' bucket (branch-less usage) falls back to the
 * session-level `SessionBranch` branch. A multi-branch session therefore emits
 * one entry per branch it actually ran on, while legacy/Codex sessions (only a
 * '' bucket) keep exactly one session-level entry as before.
 */
function buildUsageSessions(
  perBranchInvBySession: Map<string, Map<string, number>>,
  branchNameBySession: Map<string, string>
): AgentComponentDetail["usageSessions"] {
  const usageSessions: AgentComponentDetail["usageSessions"] = [];
  for (const [sessionId, byBranch] of perBranchInvBySession.entries()) {
    const fallbackBranch = branchNameBySession.get(sessionId) ?? null;
    // Resolve each bucket to its final branchName FIRST, then fold by the
    // resolved name so a session never emits two rows for the same branch: the
    // '' bucket resolves to the session-level fallback, which can collide with a
    // real per-event bucket of that same branch — summing here prevents the
    // double-count. Key by a sentinel for the null fallback so branch-less usage
    // with no SessionBranch link still merges into a single row.
    const NULL_BRANCH_KEY = "\u0000null";
    const invByResolvedBranch = new Map<
      string,
      { branchName: string | null; invocationCount: number }
    >();
    for (const [branch, invCount] of byBranch.entries()) {
      // '' → session-level fallback (legacy/Codex); a real per-event branch
      // wins over it, giving invocation-granularity attribution.
      const resolved = branch === NO_BRANCH_SENTINEL ? fallbackBranch : branch;
      const key = resolved ?? NULL_BRANCH_KEY;
      const existing = invByResolvedBranch.get(key);
      if (existing) {
        existing.invocationCount += invCount;
      } else {
        invByResolvedBranch.set(key, {
          branchName: resolved,
          invocationCount: invCount,
        });
      }
    }
    for (const {
      branchName,
      invocationCount,
    } of invByResolvedBranch.values()) {
      usageSessions.push({ sessionId, branchName, invocationCount });
    }
  }
  // Sort by invocation count descending for consistent ordering, tie-broken by
  // sessionId then branchName so multi-branch rows have a stable order.
  usageSessions.sort(
    (a, b) =>
      b.invocationCount - a.invocationCount ||
      a.sessionId.localeCompare(b.sessionId) ||
      (a.branchName ?? "").localeCompare(b.branchName ?? "")
  );
  return usageSessions;
}

type BranchArtifactLinkRow = {
  target: {
    id: string;
    slug: string | null;
    branch: {
      artifactId: string;
      branchName: string;
      repositoryFullName: string | null;
      baseBranch: string | null;
      lastActivityAt: Date | null;
      firstPushedAt: Date | null;
    } | null;
  } | null;
};

function buildBranchesTab(
  branchArtifactLinks: BranchArtifactLinkRow[]
): import("@repo/api/src/types/branch").BranchRow[] {
  const branchesTab: import("@repo/api/src/types/branch").BranchRow[] = [];
  const seenBranchIds = new Set<string>();

  for (const link of branchArtifactLinks) {
    const branch = link.target?.branch;
    const artifactId = link.target?.id;
    if (!(branch && artifactId) || seenBranchIds.has(artifactId)) {
      continue;
    }
    seenBranchIds.add(artifactId);

    branchesTab.push({
      id: link.target?.slug ?? artifactId,
      branchName: branch.branchName,
      baseBranch: branch.baseBranch,
      repoFullName: branch.repositoryFullName,
      owner: null,
      status: "open" as const,
      prNumber: null,
      prTitle: null,
      prState: null,
      prUrl: null,
      multiPrWarning: false,
      checksStatus: null,
      checksPassed: null,
      checksTotal: null,
      reviewDecision: null,
      ahead: null,
      behind: null,
      additions: null,
      deletions: null,
      filesChanged: null,
      estimatedCostUsd: null,
      lastActivityAt: (
        branch.lastActivityAt ??
        branch.firstPushedAt ??
        new Date()
      ).toISOString(),
      sessionIds: [],
    });
  }

  return branchesTab;
}

function reduceMinDate(
  rows: DetailInventoryRow[],
  field: "firstSeenAt" | "lastSeenAt"
): Date | null {
  return rows.reduce<Date | null>((min, r) => {
    const d = r[field];
    if (!d) {
      return min;
    }
    if (!min || d < min) {
      return d;
    }
    return min;
  }, null);
}

function reduceMaxDate(
  rows: DetailInventoryRow[],
  field: "firstSeenAt" | "lastSeenAt"
): Date | null {
  return rows.reduce<Date | null>((max, r) => {
    const d = r[field];
    if (!d) {
      return max;
    }
    if (!max || d > max) {
      return d;
    }
    return max;
  }, null);
}

/**
 * A single orphaned (null-FK) usage row for one org-level identity, carrying the
 * per-session invocation count needed to build `usageSessions`.
 */
type DetailOrphanUsageRow = {
  agentSessionId: string;
  invocationCount: number;
  /** Harness recorded on the usage row; null when the collector left it unset. */
  harness: string | null;
  // FEA-2990: per-event branch attribution. '' is the "no per-event branch"
  // sentinel — those buckets fall back to session-level SessionBranch. Carried
  // here so the per-(session, branch) fold in `getDetailForOrg` can split orphan
  // usage by branch too, not just the aggregate fold.
  gitBranch: string;
};

/**
 * Fetch the org-scoped orphaned (`agentComponentId IS NULL`) usage rows for a
 * single `(kind, key)` identity. Shared by both the inventory-present detail
 * path and the orphan-only synthetic-detail path (#2613): a used-only component
 * has usage rows but no inventory row, so the detail must be built from these.
 * Matched case-insensitively on `componentKey` to mirror the list-view fold via
 * `encodeComponentSlug`.
 */
function fetchDetailOrphanUsage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string
): Promise<DetailOrphanUsageRow[]> {
  return db.agentComponentSessionUsage.findMany({
    where: {
      agentComponentId: null,
      componentKind: kind,
      componentKey: { equals: key, mode: "insensitive" },
      session: {
        artifact: {
          organizationId,
        },
      },
    },
    select: {
      agentSessionId: true,
      invocationCount: true,
      harness: true,
      // FEA-2990: per-event branch attribution for precise splitting.
      gitBranch: true,
    },
    // Make the retained slice deterministic when a busy org exceeds the cap:
    // keep the most recently active sessions (mirrors the inventory read's
    // `lastSeenAt desc` ordering) with `id` as a stable tiebreak, so the detail
    // view's totals, harness derivation, and `usageSessions` don't flicker with
    // whatever unordered subset Postgres would otherwise return.
    orderBy: [{ lastInvokedAt: "desc" }, { id: "asc" }],
    // Bound the fan-out to match the other org-scoped orphan/child usage reads
    // (`loadChildUsageByPackId`, `buildPluginChildInvCountBySession`, and the
    // list-view orphan query): a popular orphan skill/command has one usage row
    // per session, so a busy org would otherwise materialize unboundedly with
    // session volume. Downstream branch attribution is already capped by
    // `MAX_DETAIL_SESSION_IN_IDS`.
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });
}

/**
 * Derive the harness for an orphan-only synthetic detail from the actual usage
 * rows rather than hardcoding `"claude"`. Uses the first non-null harness seen,
 * upgrades to `"both"` when rows disagree, and falls back to `"claude"` only
 * when every row left the harness unset.
 */
function deriveOrphanHarness(
  rows: readonly DetailOrphanUsageRow[]
): AgentComponentDetail["harness"] {
  let seen: string | null = null;
  for (const row of rows) {
    if (!row.harness) {
      continue;
    }
    if (seen === null) {
      seen = row.harness;
    } else if (seen !== row.harness) {
      return "both";
    }
  }
  return (seen ?? "claude") as AgentComponentDetail["harness"];
}

/**
 * Fetch the two branch-attribution `artifactLink` result sets for a bounded set
 * of session artifact ids and reduce them to the per-session branch-name map and
 * the deduped `branchesTab`. Extracted so both detail paths share one
 * implementation and each stays under the cognitive-complexity bar.
 */
async function fetchBranchAttribution(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  sessionArtifactIds: string[]
): Promise<{
  branchNameBySession: Map<string, string>;
  branchesTab: import("@repo/api/src/types/branch").BranchRow[];
}> {
  const branchLinks = await db.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: { in: sessionArtifactIds },
      linkType: LinkType.RelatesTo,
    },
    select: {
      sourceId: true,
      metadata: true,
      target: {
        select: {
          branch: {
            select: {
              branchName: true,
            },
          },
        },
      },
    },
  });

  const branchArtifactLinks = await db.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: { in: sessionArtifactIds },
      linkType: LinkType.RelatesTo,
      target: { type: "BRANCH" },
    },
    select: {
      target: {
        select: {
          id: true,
          slug: true,
          branch: {
            select: {
              artifactId: true,
              branchName: true,
              repositoryFullName: true,
              baseBranch: true,
              lastActivityAt: true,
              firstPushedAt: true,
            },
          },
        },
      },
    },
  });

  return {
    branchNameBySession: buildBranchNameBySession(branchLinks),
    branchesTab: buildBranchesTab(
      branchArtifactLinks as BranchArtifactLinkRow[]
    ),
  };
}

/**
 * Fetch the org-scoped `sessionsTab` (full `AgentSessionListItem` summaries) for
 * the sessions that invoked this component, reusing the agent-sessions read
 * service so the projection is never duplicated. The `Sessions` detail tab
 * renders exactly this field (`agent-detail.tsx`), so it must be populated from
 * the same session-id set already aggregated for `usageSessions` (FEA-2923).
 */
function fetchSessionsTab(
  organizationId: string,
  sessionArtifactIds: string[]
): Promise<AgentComponentDetail["sessionsTab"]> {
  return agentSessionsService.listByArtifactIds(
    organizationId,
    sessionArtifactIds
  );
}

/**
 * The three per-session detail tab payloads: the sessions-with-usage rows,
 * the linked branches summary, and the full session list-item summaries the
 * `Sessions` tab renders. Shared return shape for both the inventory-present
 * and orphan-only (#2613) detail paths.
 */
type DetailSessionTabs = {
  usageSessions: AgentComponentDetail["usageSessions"];
  branchesTab: import("@repo/api/src/types/branch").BranchRow[];
  sessionsTab: AgentComponentDetail["sessionsTab"];
};

/**
 * Widen a plain per-session invocation map into the per-(session, branch) shape
 * `buildUsageSessions` consumes, placing every session's whole count in the
 * {@link NO_BRANCH_SENTINEL} bucket. That bucket resolves to the session-level
 * `SessionBranch` fallback at read time, so the result is identical to the
 * pre-FEA-2990 session-level attribution. Used for paths with no per-event
 * git_branch signal (plugins roll up child usage with no branch dimension; the
 * orphan-only synthetic detail).
 */
function widenToSingleBranchBucket(
  invCountBySession: Map<string, number>
): Map<string, Map<string, number>> {
  const perBranch = new Map<string, Map<string, number>>();
  for (const [sessionId, invCount] of invCountBySession.entries()) {
    perBranch.set(sessionId, new Map([[NO_BRANCH_SENTINEL, invCount]]));
  }
  return perBranch;
}

/**
 * Resolve `usageSessions`, `branchesTab`, and `sessionsTab` for a component
 * detail. The session-id fan-out into the branch-attribution `IN (...)` queries
 * (see `MAX_DETAIL_SESSION_IN_IDS`) and the `sessionsTab` read (via the
 * agent-sessions read service, so the list projection is never duplicated) are
 * both driven off `invCountBySession` — the authoritative per-session set that
 * already folds plugin rollup + orphan usage. Returns empty tabs when no
 * sessions invoked the component.
 *
 * FEA-2990: `usageSessions` is built from `perBranchInvBySession` when the caller
 * has per-event git_branch data, splitting a multi-branch session by the branch
 * each invocation ran on; the `''` bucket falls back to the session-level branch.
 * When no branch dimension is available (plugins, orphan-only detail) the caller
 * omits it and we widen `invCountBySession` into a single `''` bucket per
 * session, reproducing the pre-feature session-level attribution exactly.
 */
async function resolveDetailSessionTabs(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  invCountBySession: Map<string, number>,
  perBranchInvBySession?: Map<string, Map<string, number>>
): Promise<DetailSessionTabs> {
  const sessionArtifactIds = [...invCountBySession.keys()].slice(
    0,
    MAX_DETAIL_SESSION_IN_IDS
  );
  if (sessionArtifactIds.length === 0) {
    return { usageSessions: [], branchesTab: [], sessionsTab: [] };
  }

  const [{ branchNameBySession, branchesTab }, sessionsTab] = await Promise.all(
    [
      fetchBranchAttribution(db, organizationId, sessionArtifactIds),
      fetchSessionsTab(organizationId, sessionArtifactIds),
    ]
  );

  const perBranch =
    perBranchInvBySession ?? widenToSingleBranchBucket(invCountBySession);

  return {
    usageSessions: buildUsageSessions(perBranch, branchNameBySession),
    branchesTab,
    sessionsTab,
  };
}

/**
 * Build a synthetic detail for a component that has usage but no inventory row
 * (#2613): a "used-only" component (e.g. usage synced before the inventory lane
 * linked it, or a built-in with no inventory row). Returning null here 404s a
 * component that legitimately shows up in the list via the orphan-usage fold, so
 * we assemble the detail directly from the orphan usage rows instead. Returns
 * null only when there is genuinely no usage either — a true not-found.
 */
async function buildOrphanOnlyDetail(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string
): Promise<AgentComponentDetail | null> {
  const orphanUsages = await fetchDetailOrphanUsage(
    db,
    organizationId,
    kind,
    key
  );
  if (orphanUsages.length === 0) {
    return null;
  }

  const invCountBySession = new Map<string, number>();
  let totalInvocations = 0;
  for (const usage of orphanUsages) {
    totalInvocations += usage.invocationCount;
    const prev = invCountBySession.get(usage.agentSessionId) ?? 0;
    invCountBySession.set(usage.agentSessionId, prev + usage.invocationCount);
  }

  const { usageSessions, branchesTab, sessionsTab } =
    await resolveDetailSessionTabs(db, organizationId, invCountBySession);

  // KLOC/$ from local-git session LOC + cost (FEA-2923 follow-up); deduped by
  // session id. Orphan-only components have no inventory row but do carry
  // sessions, so their KLOC is still honest when those sessions produced lines.
  const locCostBySession = await loadSessionLocCost(db, organizationId, [
    ...invCountBySession.keys(),
  ]);

  const now = new Date().toISOString();
  return {
    id: encodeComponentSlug(kind, key, null),
    name: key,
    kind: kind as AgentComponentKind,
    sourceType: "repo" as const,
    source: key,
    harness: deriveOrphanHarness(orphanUsages),
    invocations: totalInvocations,
    sessions: invCountBySession.size,
    klocPerDollar: computeKlocPerDollar(
      invCountBySession.keys(),
      locCostBySession
    ),
    trend: [],
    owner: null,
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: now,
    lastSeenAt: now,
    properties: {
      path: key,
      format: "md",
    },
    prompt: null,
    sessionsTab,
    branchesTab,
    provenance: [],
    usageSessions,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const agentComponentsService = {
  /**
   * Per-pack org-wide analytics rollup for the desktop-team overlay: usage +
   * sessions + KLOC/$ over the pack's child components, plus owner/device
   * adoption. Joined to the desktop's local pack by the shared `packId`. Returns
   * null when the org has neither usage nor inventory for the pack.
   */
  getPackAnalytics(
    organizationId: string,
    packId: string
  ): Promise<PackAnalyticsResponse | null> {
    return withDb(async (db) => {
      const byPack = await loadChildUsageByPackId(db, [packId], organizationId);
      const bucket = byPack.get(packId);

      const inventory = await db.agentComponent.findMany({
        where: { organizationId, packId },
        select: {
          computeTargetId: true,
          computeTarget: {
            select: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
        },
        // Deterministic order to match every other bounded query in this file.
        orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
      });

      if (!bucket && inventory.length === 0) {
        return null;
      }

      const sessionIds = bucket ? [...bucket.sessionIds] : [];
      const locCost = await loadSessionLocCost(db, organizationId, sessionIds);
      const klocPerDollar = bucket
        ? computeKlocPerDollar(bucket.sessionIds, locCost)
        : null;

      const ownerIds = new Set<string>();
      const owners: string[] = [];
      const deviceIds = new Set<string>();
      for (const row of inventory) {
        deviceIds.add(row.computeTargetId);
        const user = row.computeTarget?.user;
        if (user && !ownerIds.has(user.id)) {
          ownerIds.add(user.id);
          owners.push(resolveOwnerDisplayName(user));
        }
      }

      return {
        packId,
        invocations: bucket?.invocations ?? 0,
        sessions: bucket?.sessionIds.size ?? 0,
        klocPerDollar,
        owners,
        deviceCount: deviceIds.size,
      };
    });
  },

  /**
   * List org-level deduplicated agent components with aggregated org-wide usage.
   *
   * - Queries all `AgentComponent` rows for the org (via computeTarget.organizationId)
   * - Dedupes across compute targets by (componentKind, normalized componentKey/name)
   * - LEFT JOINs `AgentComponentSessionUsage` through `SessionDetail.organizationId`
   *   for org-scoped usage aggregation
   *
   * Usage (invocations/sessions) is sourced solely from
   * `AgentComponentSessionUsage`. hook/config-kind components have a thin/no
   * invocation signal and are intentionally NOT materialized into that table, so
   * they honestly report `invocations=0`/`sessions=0` here (empty usage is real
   * data, per the reconciled SSOT — the component still appears via the
   * inventory lane). There is deliberately no `AgentSessionEvent` on-read
   * derivation: events carry no reliable component-identity key to attribute a
   * hook/config invocation to, so any such derivation would be a fabricated
   * count. If the product later materializes hook/config usage, it must be
   * written into `AgentComponentSessionUsage` like every other kind.
   */
  listForOrg(
    organizationId: string,
    query: AgentComponentListQuery
  ): Promise<AgentComponentListResponse> {
    const {
      kinds,
      search,
      owner,
      harness,
      limit,
      offset,
      sortBy,
      sortDir,
      startDate,
      endDate,
    } = query;

    // FEA-3160 / FEA-3178: when a time window is requested, every USAGE lane is
    // scoped to `lastInvokedAt >= windowStart` (and `<= windowEnd` when the
    // upper bound is supplied) and components with zero in-window usage are
    // dropped. `startDate`/`endDate` are validated upstream as parseable date
    // strings (full ISO datetime OR bare `YYYY-MM-DD`, matching the sibling
    // agent-sessions endpoint); `new Date` handles both. Parse them once. Both
    // absent ⇒ all-time inventory view, byte-identical to before. `endDate` is
    // paired with `startDate` to fetch the PRECEDING equivalent window for the
    // period-over-period delta on the summary cards.
    const window: UsageWindow = {
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    };

    return withDb(async (db) => {
      // 1. Fetch all inventory rows for this org (across all compute targets)
      const inventoryRows = await db.agentComponent.findMany({
        where: {
          organizationId,
          ...(kinds && kinds.length > 0
            ? { componentKind: { in: kinds } }
            : {}),
          ...(harness ? { harness } : {}),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: "insensitive" } },
                  { componentKey: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          organizationId: true,
          computeTargetId: true,
          componentKind: true,
          externalComponentId: true,
          harness: true,
          name: true,
          componentKey: true,
          sourceUrl: true,
          installPath: true,
          packId: true,
          scope: true,
          projectPath: true,
          firstSeenAt: true,
          lastSeenAt: true,
          computeTarget: {
            select: {
              id: true,
              userId: true,
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
          sessionUsages: {
            select: {
              agentSessionId: true,
              invocationCount: true,
              lastInvokedAt: true,
              session: {
                select: {
                  artifactId: true,
                  userId: true,
                  artifact: {
                    select: {
                      organizationId: true,
                    },
                  },
                },
              },
            },
            where: {
              session: {
                artifact: {
                  organizationId,
                },
              },
              // FEA-3160 / FEA-3178: window usage by invocation time so
              // invocationCount / session counts include only in-window usage.
              // Both bounds (start/end) apply; absent window ⇒ no predicate ⇒
              // all-time (unchanged).
              ...usageWindowWhere(window),
            },
          },
        },
        // Deterministic order so the MAX_ORG_INVENTORY_ROWS cap drops a stable
        // tail rather than an arbitrary one across requests.
        orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
        take: MAX_ORG_INVENTORY_ROWS,
      });

      // 2. Dedupe by org-level identity: (componentKind, normalized key/name)
      const mergedMap = mergeComponentRows(
        inventoryRows as InventoryRow[],
        organizationId
      );

      // 2b. Fold in orphaned usage (agentComponentId IS NULL) so invocation and
      // session totals don't undercount when usage synced before its inventory
      // row (or before the component-sync lane linked the FK). Scoped to this
      // org's sessions and matched to merged entries by (kind, key).
      const orphanUsages = await db.agentComponentSessionUsage.findMany({
        where: {
          agentComponentId: null,
          ...(kinds && kinds.length > 0
            ? { componentKind: { in: kinds } }
            : {}),
          session: {
            artifact: {
              organizationId,
            },
          },
          // FEA-3160 / FEA-3178: scope orphan usage to the time window so
          // synthetic (usage-only) entries only surface when they were used
          // in-window. Both bounds (start/end) apply.
          ...usageWindowWhere(window),
        },
        select: {
          agentSessionId: true,
          componentKind: true,
          componentKey: true,
          // harness/timestamps seed synthetic entries for components that only
          // appear as session usage (no inventory row). Gap B fast fix. The
          // usage table has no display `name`, so synthetic entries fall back
          // to `componentKey` for the label (via the merged `key`).
          harness: true,
          invocationCount: true,
          firstInvokedAt: true,
          lastInvokedAt: true,
        },
        take: MAX_ORG_ORPHAN_USAGE_ROWS,
      });
      foldOrphanUsageIntoMerged(mergedMap, orphanUsages);

      // 2c. Roll up child usage into plugin-kind entries by pack_id. Plugins are
      // never invoked directly (no own usage rows), so their invocations/sessions
      // are the SUM of their child components' usage — matching the desktop
      // reader so both surfaces report the same number. (soul review HIGH)
      await applyPluginChildUsageRollup(db, mergedMap, organizationId, window);

      // 2c-window. FEA-3160 / FEA-3178: when a time window is requested (either
      // bound present), drop components with zero in-window usage (see
      // `dropZeroWindowUsage`). No bound ⇒ keep the all-time inventory view
      // (including zero-usage kinds like hook/config), byte-identical to before.
      if (window.start || window.end) {
        dropZeroWindowUsage(mergedMap);
      }

      // 2d. Load per-session local-git LOC + cost for every session referenced
      // by the merged set, so the DTO can carry a real KLOC/$ efficiency metric
      // (FEA-2923 follow-up). Sourced from `SessionDetail` (lines_added +
      // lines_removed, estimated_cost) — the desktop's local-git enrichment,
      // available BEFORE any GitHub connection (KLOC is never gated on GitHub).
      const locCostBySession = await loadLocCostForMerged(
        db,
        organizationId,
        mergedMap
      );

      // 3. Apply owner filter (post-dedup)
      let entries = [...mergedMap.values()];
      if (owner) {
        entries = entries.filter((e) =>
          e.ownerDisplayNames.some((n) =>
            n.toLowerCase().includes(owner.toLowerCase())
          )
        );
      }

      // 4. Sort and paginate
      const { page, total } = sortAndPaginate(
        entries,
        sortBy,
        sortDir,
        limit,
        offset
      );

      // 5. Map to response shape
      const now = new Date().toISOString();
      const items: AgentComponent[] = page.map((e) => ({
        id: e.id,
        name: e.name ?? e.key,
        kind: e.kind as AgentComponentKind,
        sourceType: "repo" as const,
        source: e.sourceUrl ?? e.key,
        harness: (e.harness ?? "claude") as AgentComponent["harness"],
        invocations: e.totalInvocations,
        sessions: e.sessionIds.size,
        klocPerDollar: computeKlocPerDollar(e.sessionIds, locCostBySession),
        trend: [],
        owner: e.ownerDisplayNames[0] ?? null,
        collaborators: e.ownerDisplayNames.slice(1),
        computeTargetIds: e.computeTargetIds,
        firstSeenAt: e.firstSeenAt?.toISOString() ?? now,
        lastSeenAt: e.lastSeenAt?.toISOString() ?? now,
        // Real last-invocation time (max usage lastInvokedAt); omitted when the
        // component has no usage rows. Consumers key "recently active" off this,
        // never `lastSeenAt` (FEA-3179).
        ...(e.lastInvokedAt
          ? { lastInvokedAt: e.lastInvokedAt.toISOString() }
          : {}),
      }));

      return {
        items,
        total,
        hasMore: offset + limit < total,
      };
    });
  },

  /**
   * Fetch full detail for one component by its org-level identity slug.
   * Slug format: `${componentKind}::${normalizedKey}` (URL-encoded on the wire).
   *
   * Returns null when no inventory rows match.
   */
  getDetailForOrg(
    organizationId: string,
    slug: string
  ): Promise<AgentComponentDetail | null> {
    const identity = decodeComponentSlug(slug);
    if (!identity) {
      return Promise.resolve(null);
    }
    const { kind, key } = identity;

    return withDb(async (db) => {
      // 1. Fetch all inventory rows for this org-level identity
      const inventoryRows = await db.agentComponent.findMany({
        where: {
          organizationId,
          componentKind: kind,
          OR: [
            { componentKey: key },
            // Also match by name (lowercased) when componentKey is absent
            { componentKey: null, name: { equals: key, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          computeTargetId: true,
          componentKind: true,
          componentKey: true,
          externalComponentId: true,
          harness: true,
          name: true,
          sourceUrl: true,
          installPath: true,
          packId: true,
          scope: true,
          projectPath: true,
          description: true,
          firstSeenAt: true,
          lastSeenAt: true,
          computeTarget: {
            select: {
              id: true,
              userId: true,
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
          sessionUsages: {
            select: {
              agentSessionId: true,
              invocationCount: true,
              // FEA-2990: per-event branch attribution for precise splitting.
              gitBranch: true,
              session: {
                select: {
                  artifactId: true,
                  artifact: {
                    select: {
                      organizationId: true,
                    },
                  },
                },
              },
            },
            where: {
              session: {
                artifact: {
                  organizationId,
                },
              },
            },
          },
        },
      });

      if (inventoryRows.length === 0) {
        // #2613: a "used-only" component (usage rows but no inventory row) must
        // still resolve — it appears in the list via the orphan-usage fold, so
        // 404ing its detail is a phantom. Build the detail from orphan usage.
        return buildOrphanOnlyDetail(db, organizationId, kind, key);
      }

      const typedRows = inventoryRows as DetailInventoryRow[];

      // Use the first row as the canonical representative
      const canonical = typedRows[0];

      // 2. Build per-device provenance
      const provenance = buildProvenance(typedRows);

      // 2b. Fetch orphaned usage (agentComponentId IS NULL) for this identity so
      // detail totals stay consistent with the list view when usage synced
      // before its inventory row was linked. Matched by (kind, componentKey);
      // the list uses the same fold. Deduped against FK-linked rows by the
      // AgentComponentSessionUsage unique(agentSessionId, kind, key) constraint.
      // Matched by (kind, componentKey) case-insensitively to mirror the
      // list-view fold via encodeComponentSlug; `fetchDetailOrphanUsage` also
      // selects `gitBranch` (FEA-2990) so orphan usage can be split per branch.
      const orphanUsages = await fetchDetailOrphanUsage(
        db,
        organizationId,
        kind,
        key
      );

      // 3. Aggregate org-wide usage across all inventory rows
      const {
        totalInvocations: linkedInvocations,
        sessionIdSet,
        ownerDisplayNames,
      } = aggregateDetailUsage(typedRows, organizationId);

      // Fold orphan usage into the detail aggregates.
      let orphanInvocations = 0;
      for (const usage of orphanUsages) {
        orphanInvocations += usage.invocationCount;
        sessionIdSet.add(usage.agentSessionId);
      }
      const totalInvocations = linkedInvocations + orphanInvocations;

      // 4. Build the per-session invocation-count map + effective totals. For
      // plugins this rolls up child usage by pack_id (matching the list view +
      // desktop); for every other kind it folds FK-linked + orphan usage. The
      // count map drives usageSessions and the session-id fan-out (bounded in
      // resolveDetailSessionTabs).
      const {
        invCountBySession,
        totalInvocations: effectiveTotalInvocations,
        sessionIdSet: effectiveSessionIdSet,
      } = await resolveDetailInvocationCounts(db, {
        kind,
        key,
        organizationId,
        typedRows,
        orphanUsages,
        linkedTotalInvocations: totalInvocations,
        linkedSessionIdSet: sessionIdSet,
      });

      // 5. Resolve usageSessions + branchesTab + sessionsTab.
      //
      // FEA-2990: for non-plugin kinds, build the per-(session, branch) map so
      // usageSessions can split a multi-branch session by the branch each
      // invocation ran on. Orphan usage carries `gitBranch` too, so fold it into
      // the same map — when `gitBranch` is '' (Codex/legacy) the bucket falls
      // back to the session-level SessionBranch inside `buildUsageSessions`,
      // reproducing the pre-feature session-level attribution.
      //
      // Plugins have no per-event branch dimension (their invocations are a
      // child-usage rollup by pack_id, not rows in `typedRows.sessionUsages`), so
      // we pass no per-branch map and `resolveDetailSessionTabs` widens the
      // plugin's rollup into single-branch buckets that resolve session-level.
      // Either way the session-id fan-out + `sessionsTab` are driven off the
      // authoritative `invCountBySession` map, preserving main's behavior.
      let perBranchInvBySession: Map<string, Map<string, number>> | undefined;
      if (kind !== "plugin") {
        perBranchInvBySession = buildPerBranchInvBySession(
          typedRows,
          organizationId
        );
        for (const usage of orphanUsages) {
          addPerBranchInvocation(
            perBranchInvBySession,
            usage.agentSessionId,
            usage.gitBranch,
            usage.invocationCount
          );
        }
      }

      const { usageSessions, branchesTab, sessionsTab } =
        await resolveDetailSessionTabs(
          db,
          organizationId,
          invCountBySession,
          perBranchInvBySession
        );

      // KLOC/$ from the same local-git session LOC + cost the list view uses
      // (FEA-2923 follow-up). Deduped by session id via the effective set.
      const locCostBySession = await loadSessionLocCost(db, organizationId, [
        ...effectiveSessionIdSet,
      ]);
      const klocPerDollar = computeKlocPerDollar(
        effectiveSessionIdSet,
        locCostBySession
      );

      const firstSeenAt =
        reduceMinDate(typedRows, "firstSeenAt") ?? canonical.firstSeenAt;
      const lastSeenAt =
        reduceMaxDate(typedRows, "lastSeenAt") ?? canonical.lastSeenAt;

      const now = new Date().toISOString();
      const componentKind = canonical.componentKind as AgentComponentKind;
      const componentKey = (canonical.componentKey ?? canonical.name ?? "")
        .toLowerCase()
        .trim();

      const detail: AgentComponentDetail = {
        id: canonical.id,
        name: canonical.name ?? componentKey,
        kind: componentKind,
        sourceType: "repo" as const,
        source: canonical.sourceUrl ?? componentKey,
        harness: (canonical.harness ??
          "claude") as AgentComponentDetail["harness"],
        invocations: effectiveTotalInvocations,
        sessions: effectiveSessionIdSet.size,
        klocPerDollar,
        trend: [],
        owner: ownerDisplayNames[0] ?? null,
        collaborators: ownerDisplayNames.slice(1),
        computeTargetIds: inventoryRows.map((r) => r.computeTargetId),
        firstSeenAt: firstSeenAt?.toISOString() ?? now,
        lastSeenAt: lastSeenAt?.toISOString() ?? now,
        properties: {
          path: canonical.installPath ?? componentKey,
          format: "md",
        },
        prompt: null,
        sessionsTab,
        branchesTab,
        provenance,
        usageSessions,
      };

      return detail;
    });
  },
};
