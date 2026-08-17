import "server-only";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  type ComponentResolvedState,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { decodeComponentHashKey } from "@repo/api/src/types/agent-component-analytics";
import { buildComponentProperties } from "@repo/api/src/types/agent-component-properties";
import { reduceResolvedState } from "@repo/api/src/types/component-resolution";
import { unionComponentSourceProvenance } from "@repo/api/src/types/component-source";
import { emitLocPerDollarWithLegacy } from "@repo/api/src/utils/loc-per-dollar";
import { withDb } from "@repo/database";
import { computeCohortPerformance } from "../cohort-performance";
import { resolveDetailAuthors } from "../component-authors";
import { resolveDetailIdentityScope } from "../content-hash-identity";
import type { DetailOrphanUsageRow } from "../detail-usage-reads";
import { resolveComponentHarness } from "../harness-attribution";
import {
  resolveDetailHonestSource,
  resolveDetailSourceProjection,
  type UsageGroupRow,
} from "../identity";
import { loadSessionLocCost, locPerDollarForKind } from "../loc-per-dollar";

import {
  buildChildIdentityPackLookup,
  loadDetailChildIdentityLookup,
  MAX_ORG_ORPHAN_USAGE_ROWS,
  usageWithoutTombstonedInventoryWhere,
} from "../plugin-child-usage";
import { buildOrphanOnlyDetail } from "./detail-read-orphan";
import {
  addPerBranchInvocation,
  buildInvCountBySession,
  buildPerBranchInvBySession,
  resolveDetailSessionTabs,
} from "./detail-session-tabs";
import {
  accumulateDetailHarnesses,
  aggregateDetailUsage,
  loadDetailUsageGroups,
} from "./detail-usage-identity";
import {
  emitVersionsTruncated,
  loadComponentVersionHistory,
  resolveVersionScopeKeys,
} from "./detail-version-history";
import { loadAgentComponentInvocationReadPage } from "./invocation-read";
import { ownerCompat } from "./owner-compat";

/**
 * @file detail-read.ts
 * @description The agent-components detail-read path extracted from `service.ts`
 * (ISS-4404): `getDetailForOrg` (the inventory-present detail) and its
 * aggregation helpers. The used-only synthetic detail lives in
 * `detail-read-orphan.ts` (split out under ISS-5577), the per-session tab lane
 * in `detail-session-tabs.ts`, and the invocation page in `invocation-read.ts`.
 * The service object delegates its `getDetailForOrg` method here.
 */

// ---------------------------------------------------------------------------
// Detail bounds
// ---------------------------------------------------------------------------

/**
 * Shared with the list read's inventory cap so the detail's authors-lineage read
 * bounds the same working set (see `MAX_ORG_INVENTORY_ROWS` in the list read).
 */
const MAX_ORG_INVENTORY_ROWS = AGENT_COMPONENT_INVENTORY_CAP;

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
  metadata: unknown;
  content: string | null;
  contentHash: string | null;
  // F1 (FEA-3290, Slice 6 · AC-5/AC-7/AC-020) honest resolution state; the DB
  // column defaults to `unresolved` so a legacy/pre-derivation row is never
  // silently promoted to "resolved".
  resolvedState: ComponentResolvedState;
  // ISS-5029: this device's packer reported dropping retained revisions of the
  // identity at its per-family cap / variant byte budget. NOT NULL in the DB
  // (default false), so a row that predates the column reads as "no evidence of
  // truncation" — today's behaviour — rather than unknown.
  variantsTruncated: boolean;
  // ISS-5029 (wongk, #4391): WHICH cap that device hit. Only `family_cap` bounds
  // how many revisions the device holds, so only it can be reconciled into a
  // proof that the cloud is short; null / anything unrecognized reads as no
  // proof.
  variantsTruncatedReason: string | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  // FEA-4098 (Slice 3): the compute-target `user` is no longer carried — the
  // detail's authors people-set comes from the `DefinitionVersionEditor` lineage
  // (`resolveDetailCollaborators`), not the inventory row's owner.
  computeTarget: {
    id: string;
    userId: string;
  };
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
    // wongk (ISS-5363 review): a REAL zero, not an unknown. A plugin's usage is
    // by definition the sum over its candidate packs' children; with no
    // candidate pack that sum is empty. The LIST reaches the identical answer
    // through the identical short-circuit (`loadPluginChildUsage` returns an
    // empty map for an empty pack set, and `sumPluginChildUsage` then REPLACES
    // the plugin's aggregates with 0), as does the desktop reader. Dashing here
    // would manufacture the very cross-surface disagreement this change removes.
    return bySession;
  }
  // FEA-4337: attribute child usage by the child INVENTORY identity
  // (`kind::key`), not the usage row's nullable `agentComponentId` FK, so a
  // plugin's orphan-FK child usage still counts on its detail page — identical
  // to the list rollup (`loadChildUsageByPackId`) and the desktop reader.
  const { packIdsByIdentity, identityPrefilter } =
    await loadDetailChildIdentityLookup(
      db,
      [...candidatePacks],
      organizationId
    );
  if (identityPrefilter.length === 0) {
    // wongk (ISS-5363 review): also a REAL zero. The child-inventory lookup RAN
    // and returned nothing, and `loadChildUsageByPackId` — the LIST's rollup —
    // carries the SAME `identityPrefilter.length === 0` short-circuit over the
    // SAME `loadChildInventoryJoin`, so the list turns this into a plain `0`
    // too. Reporting an unknown here would put a `—` on the detail beside the
    // list's `0` for identical inputs.
    return bySession;
  }
  const belongsToPlugin = buildChildIdentityPackLookup(packIdsByIdentity);
  const childUsage = await db.agentComponentSessionUsage.findMany({
    where: {
      componentKind: { in: [...PLUGIN_CHILD_KINDS] },
      // Prefilter to THIS plugin's child identities BEFORE the cap so unrelated
      // org child activity can't fill MAX_ORG_ORPHAN_USAGE_ROWS and starve the
      // requested plugin's detail to zero (wongk review). Case-insensitive
      // `contains` of each normalized key admits every case/whitespace variant
      // the `belongsToPlugin` re-match below keeps (FEA-3239).
      OR: identityPrefilter,
      // ISS-6180 (shafty023 review): the SAME tombstoned-FK exclusion the list's
      // `loadChildUsageByPackId` applies. `belongsToPlugin` is identity-only, so
      // without it a tombstoned child sharing a live sibling's `(kind, key)`
      // counts here while the usage-only lane also reports it — and the detail
      // would drift HIGH against a list that had been fixed alone.
      AND: [usageWithoutTombstonedInventoryWhere()],
      session: {
        artifact: {
          organizationId,
        },
      },
    },
    select: {
      agentSessionId: true,
      componentKind: true,
      componentKey: true,
      invocationCount: true,
    },
    // Deterministic tail so the cap drops a stable, most-recent-kept subset
    // rather than an arbitrary one that varies request-to-request (wongk review).
    orderBy: [
      { lastInvokedAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });
  for (const usage of childUsage) {
    // A child under one of the candidate packs; count its invocations toward the
    // session once (the detail's per-session map is a plain sum, not per-pack).
    if (!belongsToPlugin(usage.componentKind, usage.componentKey)) {
      continue;
    }
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

/**
 * F1 (FEA-3290, Slice 6 · AC-5/AC-7/AC-020): fold the per-device `resolvedState`
 * values of one org-level identity into a single honest state for the detail.
 *
 * An org identity spans one inventory row per compute target; each row carries
 * its own resolution. Precedence (highest first) surfaces the most trustworthy
 * knowledge the org actually has, and — CRITICALLY — NEVER collapses
 * `inaccessible` (permission-denied, last-known-good preserved) into `missing`
 * (deleted/absent). So a private body one device could read is `inaccessible`,
 * not "gone", even if another device's row is `missing`:
 *   resolved > inaccessible > unresolved > missing
 * `resolved` wins whenever ANY device honestly backs the definition; `missing`
 * only wins when every device agrees the definition is gone. Empty input (no
 * rows) is the DB default `unresolved` — a name-only identity, never "resolved".
 *
 * The precedence + fold live in the shared `component-resolution` module so this
 * cloud consumer and the desktop dashboard (`apps/desktop`) share ONE
 * implementation; here we only project rows onto their `resolvedState`.
 */
function reduceInventoryResolvedState(
  inventoryRows: DetailInventoryRow[]
): ComponentResolvedState {
  return reduceResolvedState(inventoryRows.map((row) => row.resolvedState));
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
    usageGroups: UsageGroupRow[];
    orphanUsages: readonly DetailOrphanUsageRow[];
    linkedTotalInvocations: number;
    linkedSessionIdSet: Set<string>;
  }
): Promise<DetailInvocationCounts> {
  if (params.kind === AgentComponentKind.Plugin) {
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

  const invCountBySession = buildInvCountBySession(params.usageGroups);
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
/**
 * FEA-2923: attribute each usage session to the definition revision that ran
 * (hash-at-invocation). One bounded grouped read; MAX() picks the single
 * per-(component, session) hash. `versionHash` is null when the content had not
 * been collected for that session. Session ids are already org-scoped, so no
 * extra org filter is needed. Extracted from `getDetailForOrg` to keep that
 * closure under the cognitive-complexity budget.
 */
async function attachUsageSessionVersions(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string,
  usageSessions: AgentComponentDetail["usageSessions"]
): Promise<AgentComponentDetail["usageSessions"]> {
  const usageSessionIds = usageSessions.map((u) => u.sessionId);
  if (usageSessionIds.length === 0) {
    return usageSessions.map((u) => ({ ...u, versionHash: null }));
  }
  const usageWhere = {
    componentKind: kind,
    componentKey: { equals: key, mode: "insensitive" as const },
    agentSessionId: { in: usageSessionIds },
    // AC-019: usage isolates via SessionDetail → Artifact.organizationId; scope
    // the read so a session id from another org can never be attributed here.
    session: { artifact: { organizationId } },
  };

  // [P1] correctness: `versionHash` and `definitionHash` MUST be attributed from
  // ONE consistent usage row. A session that switched branches mid-run persists
  // one row per (component, branch) (natural key includes `gitBranch`), each
  // carrying its own `componentVersionHash` + `definitionVersionId`. Two
  // independent `groupBy` `_max()` reads would pick the winner *per column
  // independently* — `_max(componentVersionHash)` from one branch's row and
  // `_max(definitionVersionId)` from another's — so a session could surface a
  // `definitionHash` from a DIFFERENT revision than its `versionHash`. Instead
  // read the rows and reduce to a single deterministic winning row per session
  // (most-recently-invoked, `id` tiebreak — mirrors this file's "keep the most
  // recently active" ordering), then derive BOTH attributes from that one row so
  // they can never come from different branches/revisions.
  //
  // ISS-5464 (review): this is NOT bounded by `MAX_DETAIL_SESSION_IN_IDS`, as an
  // earlier comment here claimed. `usageSessionIds` comes from
  // `buildUsageSessions` over the FULL per-session map, not the sliced
  // `sessionArtifactIds`. That asymmetry is DELIBERATE: `usageSessions` is the
  // existence set the Evidence tab's link coverage reads (`agent-detail.tsx`,
  // `getInvocationSessionHref`), so capping it would return every Evidence link
  // on a heavy component to null — the 78%->0% regression the `sessionsTab`
  // bound already caused once. Pinned by `detail-sessions-tab-wiring.test.ts`.
  // The real bound is the component's session count, one row per (session, branch).
  const usageRows = await db.agentComponentSessionUsage.findMany({
    where: usageWhere,
    select: {
      agentSessionId: true,
      componentVersionHash: true,
      definitionVersionId: true,
      lastInvokedAt: true,
      id: true,
    },
    // Deterministic winner: newest-active first, `id` as a stable tiebreak.
    // `nulls: "last"` keeps never-invoked rows from sorting to the top and
    // winning over a row that actually recorded an invocation.
    orderBy: [
      { lastInvokedAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
  });
  // First row seen per session (by the deterministic order above) is the winner;
  // both `componentVersionHash` and `definitionVersionId` are read from it.
  const winningRowBySession = new Map<
    string,
    { componentVersionHash: string | null; definitionVersionId: string | null }
  >();
  for (const r of usageRows) {
    if (!winningRowBySession.has(r.agentSessionId)) {
      winningRowBySession.set(r.agentSessionId, {
        componentVersionHash: r.componentVersionHash,
        definitionVersionId: r.definitionVersionId,
      });
    }
  }

  // F1 (FEA-3290, Slice 6): resolve the winning row's exact-fingerprint version
  // via its `definitionVersionId` link (backfilled in Slice 5). NULL during the
  // pre-backfill window → the session surfaces its legacy `versionHash` only,
  // and `definitionHash` stays null (never fabricated). Org-scoped read.
  const definitionVersionIds = Array.from(
    new Set(
      Array.from(winningRowBySession.values())
        .map((row) => row.definitionVersionId)
        .filter((id): id is string => id != null)
    )
  );
  const definitionHashById = new Map<string, string>();
  if (definitionVersionIds.length > 0) {
    const versions = await db.definitionVersion.findMany({
      // AC-019: the fingerprint body/identity is org-scoped — never resolve a
      // foreign org's DefinitionVersion even if an id somehow reached here.
      where: { organizationId, id: { in: definitionVersionIds } },
      select: { id: true, definitionHash: true },
    });
    for (const v of versions) {
      definitionHashById.set(v.id, v.definitionHash);
    }
  }

  return usageSessions.map((u) => {
    const winner = winningRowBySession.get(u.sessionId);
    const dvId = winner?.definitionVersionId ?? null;
    return {
      ...u,
      versionHash: winner?.componentVersionHash ?? null,
      // Both fields come from `winner` — the SAME row — so they can never
      // describe different revisions/branches.
      definitionHash: dvId ? (definitionHashById.get(dvId) ?? null) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// getDetailForOrg
// ---------------------------------------------------------------------------

export function getDetailForOrg(
  organizationId: string,
  slug: string
): Promise<AgentComponentDetail | null> {
  // FEA-4335: the detail key is content-hash-based (`${kind}::${fingerprint}`)
  // for new links, or the legacy name-level `${kind}::${key}` for old links /
  // hash-less rows. Decode both shapes: a content-hash key resolves the exact
  // content-distinct component (fixing the `skill::deploy` name collision); a
  // name key resolves the whole name-level identity exactly as before
  // (skew/legacy-safe).
  const identity = decodeComponentHashKey(slug);
  if (!identity) {
    return Promise.resolve(null);
  }
  const { kind, fingerprint } = identity;

  return withDb(async (db) => {
    // FEA-4335: resolve the (content-hash OR legacy-name) key into the
    // name-level `key` used by the aggregation below plus, for a content-hash
    // key, the coarse-hash inventory narrow. Extracted to keep this method
    // within the cognitive-complexity budget.
    const scope = await resolveDetailIdentityScope(
      db,
      organizationId,
      kind,
      fingerprint,
      identity.key
    );
    const { key } = scope;
    if (scope.orphanOnly) {
      // A content hash that matched no version row — resolve as orphan-only
      // usage if any exists (used-only components), else 404. No name fallback.
      // FEA-4335: pass the content scope so the orphan read selects rows by the
      // requested `componentVersionHash`/`definitionHash` (the empty name key
      // alone would match nothing).
      return buildOrphanOnlyDetail(
        db,
        organizationId,
        kind,
        key,
        slug,
        scope.keys,
        scope.usageContentScope
      );
    }

    // 1. Fetch all inventory rows for this component's identity. FEA-4335: the
    // identity predicate is `scope.inventoryWhere` — for a content-hash key
    // that is purely `contentHash IN (…)` (content IS the identity, so
    // byte-identical rows under any name aggregate and same-named-different-
    // bytes rows split); for a legacy name key it is the case-insensitive
    // `componentKey`/`name` match (FEA-3750, so an event-minted mixed-case key
    // like `Explore` still resolves — mirroring the list fold and the
    // version-attribution read below so all three agree).
    // ISS-6180 (shafty023 re-review on #5039): named, because the usage snapshot
    // RE-DERIVES this family's live ids from the SAME predicate on its own
    // transaction client. A `where` is stable data; the row set it selects is
    // not, and it is the row set that partitions the usage lanes.
    const liveInventoryWhere = {
      organizationId,
      componentKind: kind,
      // FEA-4086 / FEA-4335 (shafty023): scope to CURRENTLY-installed rows.
      // Scanners tombstone by stamping `uninstalledAt` (they don't delete),
      // and both the list read (see above) and the Desktop reader exclude
      // these — so without this an active content-hash link could fold in
      // same-hash uninstalled rows, and a stale deep link could resolve a
      // component absent from the live list. A hash route whose only rows are
      // tombstoned now correctly falls through to the orphan/used-only path.
      uninstalledAt: null,
      ...scope.inventoryWhere,
    };
    const inventoryRows = await db.agentComponent.findMany({
      where: liveInventoryWhere,
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
        metadata: true,
        content: true,
        contentHash: true,
        resolvedState: true,
        // ISS-5029: whether this DEVICE's packer dropped retained revisions of
        // the identity, so the detail can say its version history is partial —
        // and which cap bound, since only a per-family cap makes that provable.
        variantsTruncated: true,
        variantsTruncatedReason: true,
        firstSeenAt: true,
        lastSeenAt: true,
        // FEA-4098 (Slice 3): the nested `user` select is dropped — the
        // detail's authors people-set comes from the `DefinitionVersionEditor`
        // lineage, not the inventory compute-target user.
        computeTarget: {
          select: {
            id: true,
            userId: true,
          },
        },
      },
      // FEA-3982 (review): deterministic order so `typedRows[0]` (the canonical
      // representative below) is stable across requests rather than whatever
      // order Postgres happens to return. Newest-observed first with `id` as a
      // unique tiebreak (mirrors the list inventory read's ordering).
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    });

    if (inventoryRows.length === 0) {
      // #2613: a "used-only" component (usage rows but no inventory row) must
      // still resolve — it appears in the list via the orphan-usage fold, so
      // 404ing its detail is a phantom. Build the detail from orphan usage.
      // FEA-4335: for a content-hash route where the inventory moved A→B but no
      // B inventory row exists yet, carry the full name set + content scope so
      // the orphan read stays scoped to the requested version.
      return buildOrphanOnlyDetail(
        db,
        organizationId,
        kind,
        key,
        slug,
        scope.keys,
        scope.usageContentScope
      );
    }

    const typedRows = inventoryRows as DetailInventoryRow[];

    // The deterministic `orderBy` above makes the first row a STABLE canonical
    // representative (newest-observed, `id` tiebreak) — not array-position luck.
    const canonical = typedRows[0];

    // FEA-3467: aggregate this identity's direct usage in SQL instead of
    // eagerly loading each inventory row's nested `sessionUsages` collection
    // (the data-scale one — one row per session×component×branch — which the
    // detail read did not cap at all, so a single hot component materialized
    // its entire org usage history into the heap just to JS-reduce per-session/
    // per-branch invocation counts). Grouping by (component, session, branch)
    // keeps the per-event branch dimension `usageSessions` needs (FEA-2990)
    // while collapsing the collection to one lean row per bucket. The detail
    // read has no time window, so none is passed.
    // ISS-4660 item 1 + ISS-5363: ALL THREE usage lanes — both FK lanes and the
    // orphan (no-live-inventory-owner) lane — plus the live-inventory bound they
    // partition on (ISS-6180) — read under ONE `RepeatableRead` snapshot, with
    // the FK union filtered to this family's identity once so every consumer
    // below (the totals fold, the harness fold, the per-session and per-branch
    // maps) shares one set. See `service/detail-usage-identity.ts` for why each
    // lane exists and why they must share a snapshot.
    const { usageGroups, orphanUsages } = await loadDetailUsageGroups({
      organizationId,
      identity: {
        kind,
        key,
        keys: scope.keys,
        inventoryRows: typedRows,
      },
      liveInventoryWhere,
      contentScope: scope.usageContentScope,
    });

    // 2. Build per-device provenance
    const provenance = buildProvenance(typedRows);

    // 3. Aggregate org-wide usage across all inventory rows
    const { totalInvocations: linkedInvocations, sessionIdSet } =
      aggregateDetailUsage(usageGroups);

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
      usageGroups,
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
    // child-usage rollup by pack_id, not the grouped direct-usage rows), so
    // we pass no per-branch map and `resolveDetailSessionTabs` widens the
    // plugin's rollup into single-branch buckets that resolve session-level.
    // Either way the session-id fan-out + `sessionsTab` are driven off the
    // authoritative `invCountBySession` map, preserving main's behavior.
    let perBranchInvBySession: Map<string, Map<string, number>> | undefined;
    if (kind !== AgentComponentKind.Plugin) {
      perBranchInvBySession = buildPerBranchInvBySession(usageGroups);
      for (const usage of orphanUsages) {
        addPerBranchInvocation(
          perBranchInvBySession,
          usage.agentSessionId,
          usage.gitBranch,
          usage.invocationCount
        );
      }
    }

    const {
      usageSessions,
      branchesTab,
      branchesTabTruncated,
      sessionsTab,
      sessionsTabTruncated,
    } = await resolveDetailSessionTabs(
      db,
      organizationId,
      invCountBySession,
      perBranchInvBySession
    );

    // FEA-2923: attribute each usage session to the definition revision that
    // ran (hash-at-invocation). Extracted to `attachUsageSessionVersions`.
    const usageSessionsWithVersion = await attachUsageSessionVersions(
      db,
      organizationId,
      kind,
      key,
      usageSessions
    );

    // LOC/$ from the same local-git session LOC + cost the list view uses
    // (FEA-2923 follow-up; ISS-4667 unit reconciliation). Deduped by session id
    // via the effective set.
    const locCostBySession = await loadSessionLocCost(db, organizationId, [
      ...effectiveSessionIdSet,
    ]);
    const locPerDollar = locPerDollarForKind(
      kind,
      effectiveSessionIdSet,
      locCostBySession
    );

    // Comparison-based delivery metrics over this component's session cohort
    // (same shared, bounded computation the per-pack overlay uses).
    const cohortMetrics = await computeCohortPerformance(db, organizationId, [
      ...effectiveSessionIdSet,
    ]);

    const firstSeenAt =
      reduceMinDate(typedRows, "firstSeenAt") ?? canonical.firstSeenAt;
    const lastSeenAt =
      reduceMaxDate(typedRows, "lastSeenAt") ?? canonical.lastSeenAt;

    const componentKind = canonical.componentKind as AgentComponentKind;
    const componentKey = (canonical.componentKey ?? canonical.name ?? "")
      .toLowerCase()
      .trim();

    // Content-hash version history (FEA-2923), newest-first. Bounded read, over
    // the identity's COMPLETE name set — see `resolveVersionScopeKeys` (#4391).
    const versionKeys = resolveVersionScopeKeys(scope.keys, key);
    const [versionHistory, invocationRows] = await Promise.all([
      loadComponentVersionHistory(
        db,
        organizationId,
        kind,
        versionKeys,
        canonical.contentHash,
        // ISS-6232: the identity's provenance folded across EVERY inventory row
        // (canonical first), so a component whose pack is recorded on a
        // non-canonical device still reports its pack as the revision source
        // instead of falling through to the `organic` terminal.
        unionComponentSourceProvenance(typedRows, [componentKey])
      ),
      loadAgentComponentInvocationReadPage(db, {
        organizationId,
        kind,
        key,
        inventoryIds: typedRows.map((row) => row.id),
      }),
    ]);

    // FEA-3758: attribute harness from the sessions this component actually
    // ran in (usage rows), falling back to the inventory-row harness only when
    // no usage carried one. Matches the list view so a component used only in
    // Codex sessions shows `codex`, not the inventory row's defaulted `claude`.
    const detailHarness = resolveComponentHarness(
      accumulateDetailHarnesses(usageGroups, orphanUsages),
      canonical.harness
    );

    // FEA-4098 (Slice 3) + FEA-4247: the authors people-set for the detail —
    // the union of the `DefinitionVersionEditor` lineage across every linked
    // revision of this name-level component (discoverer-first per version,
    // deduped by stable user id) when present, else the read-time owner
    // FALLBACK (the observing compute-target users, deduped in the inventory
    // read's `lastSeenAt DESC, id ASC` order). Restores Owner for legacy/
    // unlinked rows without a backfill; lineage always wins. Extracted to
    // `resolveDetailAuthors`.
    //
    // wongk: the lineage identity read is SEPARATE from `versions` (the
    // prompt-history DTO, capped at 20 rows) so an author who only touched an
    // older revision is not silently dropped from the detail's Collaborators;
    // the prompt selector keeps its 20-body cap independently.
    const detailAuthors = await resolveDetailAuthors(
      db,
      organizationId,
      kind,
      key,
      typedRows,
      MAX_ORG_INVENTORY_ROWS
    );

    // FEA-4374: `sourceType` (gates web Install) + `source` (the pack id its
    // `normalizePackId` resolves from) from ONE unioned pack id (in identity.ts).
    const sourceProjection = resolveDetailSourceProjection(
      typedRows,
      componentKey
    );
    // ISS-5009: the honest projection, over the SAME rows (in identity.ts).
    const honestSource = resolveDetailHonestSource(typedRows, componentKey);

    const detail: AgentComponentDetail = {
      id: canonical.id,
      slug,
      name: canonical.name ?? componentKey,
      kind: componentKind,
      sourceType: sourceProjection.sourceType,
      source: sourceProjection.source,
      honestSource,
      harness: detailHarness,
      // ISS-5363: every lane that feeds these two numbers issues its read, so a
      // `0` here is a MEASURED zero and is emitted as `0`. The wire contract
      // still declares them nullable (`number | null`) for the producers that
      // genuinely cannot compute them — the desktop detail and a version-skewed
      // payload — and every consumer dashes rather than inventing a `0`.
      invocations: effectiveTotalInvocations,
      sessions: effectiveSessionIdSet.size,
      ...emitLocPerDollarWithLegacy(locPerDollar),
      trend: [],
      // FEA-4098 (Slice 3) + FEA-4247: authors (discoverer + editors) unioned
      // across this component's linked version revisions; when that lineage is
      // empty (a legacy/unlinked row), falls back to the observing compute-
      // target owner(s) so Owner is restored without a backfill. `owner` is the
      // additive skew-compat alias (leading author), omitted when empty.
      collaborators: detailAuthors,
      ...ownerCompat(detailAuthors),
      computeTargetIds: inventoryRows.map((r) => r.computeTargetId),
      // ISS-5577 (adjacent instance): `AgentComponent.firstSeenAt`/`lastSeenAt`
      // are both nullable, so this fallback is reachable — and it stamped the
      // request clock, telling the same lie as the orphan path one branch over.
      // Same honest-absent sentinel as there.
      firstSeenAt: firstSeenAt?.toISOString() ?? "",
      lastSeenAt: lastSeenAt?.toISOString() ?? "",
      properties: buildComponentProperties({
        kind: componentKind,
        path: canonical.installPath ?? canonical.projectPath ?? componentKey,
        metadata: canonical.metadata as Record<string, unknown> | null,
      }),
      prompt: canonical.content ?? null,
      versions: versionHistory.versions,
      // ISS-5029: the honest "this history is PARTIAL" marker — emitted only
      // when a cap actually bound. See `emitVersionsTruncated` for both halves.
      ...emitVersionsTruncated(versionHistory, typedRows, versionKeys),
      // F1 (FEA-3290 · AC-5/AC-7/AC-020): honest org-level resolution, folded
      // across every device row so `inaccessible` is never collapsed into
      // `missing`. Defaults to `unresolved` for legacy/pre-derivation rows.
      resolvedState: reduceInventoryResolvedState(typedRows),
      invocationRows,
      sessionsTab,
      sessionsTabTruncated,
      branchesTab,
      branchesTabTruncated,
      provenance,
      usageSessions: usageSessionsWithVersion,
      ...cohortMetrics,
    };

    return detail;
  });
}
