import type { AgentComponentDetailReadOptions } from "./detail-read-options";
import "server-only";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  type ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import { buildComponentProperties } from "@repo/api/src/types/agent-component-properties";
import { reduceResolvedState } from "@repo/api/src/types/component-resolution";
import { unionComponentSourceProvenance } from "@repo/api/src/types/component-source";
import { emitLocPerDollarWithLegacy } from "@repo/api/src/utils/loc-per-dollar";
import { withDb } from "@repo/database";
import { isBranchPushEvidenceExclusionEnabled } from "@/lib/branch-push-evidence-exclusion-feature";
import type { FeatureFlagIdentity } from "@/lib/feature-flag-identity";
import { computeCohortPerformance } from "../cohort-performance";
import {
  namesForUserIds,
  resolveDetailAuthors,
  resolveOwnerFallbackByUserId,
} from "../component-authors";
import {
  decodeDetailRouteKey,
  resolveDetailIdentityScope,
} from "../content-hash-identity";
import {
  detailUsageNameKeys,
  usageNameIdentityWhere,
} from "../detail-usage-reads";
import { resolveComponentHarness } from "../harness-attribution";
import {
  resolveDetailHonestSource,
  resolveDetailSourceProjection,
} from "../identity";
import { installerUserIdsOf } from "../installer-roster";
import {
  loadSessionLocCost,
  locPerDollarForKind,
  locPerDollarUncoveredOperand,
} from "../loc-per-dollar";
import {
  foldOrphanUsageIntoTotals,
  resolveDetailInvocationCounts,
} from "./detail-invocation-counts";
import { buildOrphanOnlyDetail } from "./detail-read-orphan";
import {
  addPerBranchInvocation,
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
 * in `detail-session-tabs.ts`, the Invocations/Sessions counts in
 * `detail-invocation-counts.ts` (split out under ISS-9852), and the invocation
 * page in `invocation-read.ts`.
 * The service object delegates its `getDetailForOrg` method here.
 */

// ---------------------------------------------------------------------------
// Detail bounds
// ---------------------------------------------------------------------------

/**
 * How many `DefinitionVersion` rows the detail's authors-lineage read walks for
 * the ONE component it answers for.
 *
 * ISS-6891 removed the org population caps this used to be described as sharing.
 * It is unaffected by that removal — it bounds a single identity's version
 * history, not a facet-scoped population, so it cannot make a narrower filter
 * reveal a component a broader one hides. It keeps the shared
 * {@link AGENT_COMPONENT_INVENTORY_CAP} value so the number stays declared once.
 */
const MAX_DETAIL_AUTHOR_VERSIONS = AGENT_COMPONENT_INVENTORY_CAP;

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
  // ISS-5029 (whitlockk, #4391): WHICH cap that device hit. Only `family_cap` bounds
  // how many revisions the device holds, so only it can be reconciled into a
  // proof that the cloud is short; null / anything unrecognized reads as no
  // proof.
  variantsTruncatedReason: string | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  // FEA-4098 (Slice 3): the compute-target `user` is not carried — the detail's
  // authors people-set comes from the `DefinitionVersionEditor` lineage
  // (`resolveDetailCollaborators`), not the inventory row's owner. ISS-6768's
  // installer roster reads `userId` and resolves names org-scoped, so it needs
  // no nested `user` join either.
  computeTarget: {
    id: string;
    userId: string;
  };
};

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
  // ISS-6756: `usageNameIdentityWhere`'s precondition, honoured by this caller
  // too. An empty key would emit `component_key_normalized IN ('')`, which
  // matches every row still carrying the `ADD COLUMN … DEFAULT ''` value — a
  // predicate that attributes ANOTHER component's revision rather than
  // returning nothing, which is what the `ILIKE ''` it replaces did. The
  // orphan-only content-hash route is the case with no name at all; there is no
  // identity to attribute a revision by, so the lane reports none.
  const nameKeys = detailUsageNameKeys(key, []);
  if (usageSessionIds.length === 0 || nameKeys.length === 0) {
    return usageSessions.map((u) => ({ ...u, versionHash: null }));
  }
  const usageWhere = {
    componentKind: kind,
    // ISS-6756: the SAME folded-identity predicate the lanes that PRODUCED
    // `usageSessions` now use. Those lanes moved off `componentKey ILIKE`, whose
    // fold differs from the persisted one in two directions — it does not trim,
    // and it treats `_`/`%` in the key as wildcards — so leaving this lane on
    // the old spelling would make it select a different population from the
    // session list it annotates: a session admitted by the new fold would find
    // no row here and render a null `versionHash`, and an `mcp__x__y`-style key
    // could match some OTHER component's row and attribute ITS hash.
    //
    // Deliberately still the primary `key` only, not `scope.keys`: this lane has
    // never matched the alias set, and widening it is a separate question from
    // the spelling. Bound by `agentSessionId` below, so no index depends on it.
    ...usageNameIdentityWhere(nameKeys),
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
  // ISS-5464 / ISS-9855: this is NOT bounded by the session-tab page size.
  // `usageSessionIds` comes from `buildUsageSessions` over the FULL per-session
  // map, not the paged `sessionArtifactIds`. That asymmetry is DELIBERATE:
  // `usageSessions` is the existence set the Evidence tab's link coverage reads
  // (`agent-detail.tsx`, `getInvocationSessionHref`), so capping it would
  // return every Evidence link on a heavy component to null — the 78%->0%
  // regression the `sessionsTab` bound already caused once. Pinned by
  // `detail-sessions-tab-wiring.test.ts`. The real bound is the component's
  // session count, one row per (session, branch).
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

/** ISS-8148: fail-closed flag resolve — no identity means the gate stays off. */
function resolvePushEvidenceGate(
  flagIdentity: FeatureFlagIdentity | undefined
): Promise<boolean> {
  return flagIdentity
    ? isBranchPushEvidenceExclusionEnabled(flagIdentity)
    : Promise.resolve(false);
}

export function getDetailForOrg(
  organizationId: string,
  slug: string,
  // ISS-8148: requester identity for the read-side flag. Optional and
  // fail-closed — a caller without one (internal/test) keeps the
  // pre-ISS-8148 populations, the same posture as an unavailable flag.
  flagIdentity?: FeatureFlagIdentity,
  readOptions?: AgentComponentDetailReadOptions
): Promise<AgentComponentDetail | null> {
  // FEA-4335: the detail key is content-hash-based (`${kind}::${fingerprint}`)
  // for new links, or the legacy name-level `${kind}::${key}` for old links /
  // hash-less rows. Decode both shapes: a content-hash key resolves the exact
  // content-distinct component (fixing the `skill::deploy` name collision); a
  // name key resolves the whole name-level identity exactly as before
  // (skew/legacy-safe).
  //
  // ISS-10815 adds a THIRD accepted spelling: the NAME-QUALIFIED
  // `${kind}::${name}@${fingerprint}`, which the catalog list publishes as the
  // `id` of a usage-only row. It used to 404 — the one published spelling of a
  // component's identity that this endpoint, which the list links to, would not
  // resolve. Nothing links with it today, so this is purely additive; see
  // `decodeDetailRouteKey` for where it comes from and why the order is safe.
  const identity = decodeDetailRouteKey(slug);
  if (!identity) {
    return Promise.resolve(null);
  }
  const { kind, fingerprint } = identity;

  return withDb(async (db) => {
    // ISS-8148 read-side gate, resolved once per detail read (same flag and
    // fail-closed posture as the insights delivery section): an unavailable
    // flag or an identity-less caller keeps the pre-ISS-8148 populations.
    const requirePushEvidence = await resolvePushEvidenceGate(flagIdentity);
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
      // ISS-10341: the ONE caller that still passes a content scope, and not as
      // a narrowing — this identity resolved no name at all (`key` is `""`,
      // `keys` is empty), so the fingerprint IS its whole identity and the empty
      // name key alone would match nothing. There is no family here to be
      // narrower than.
      return buildOrphanOnlyDetail(
        db,
        organizationId,
        kind,
        key,
        slug,
        scope.keys,
        scope.usageContentScope,
        requirePushEvidence,
        readOptions
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
    // ISS-6180 (davetho re-review on #5039): named, because the usage snapshot
    // RE-DERIVES this family's live ids from the SAME predicate on its own
    // transaction client. A `where` is stable data; the row set it selects is
    // not, and it is the row set that partitions the usage lanes.
    const liveInventoryWhere = {
      organizationId,
      componentKind: kind,
      // FEA-4086 / FEA-4335 (davetho): scope to CURRENTLY-installed rows.
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
      // `lastSeenAt` is nullable and PostgreSQL sorts nulls FIRST on a
      // descending sort, so without `nulls: "last"` a legacy row that never
      // recorded one would lead the roster ahead of genuinely recent installs.
      orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    });

    if (inventoryRows.length === 0) {
      // #2613: a "used-only" component (usage rows but no inventory row) must
      // still resolve — it appears in the list via the orphan-usage fold, so
      // 404ing its detail is a phantom. Build the detail from orphan usage.
      // FEA-4335: for a content-hash route where the inventory moved A→B but no
      // B inventory row exists yet, carry the full name set + content scope so
      // the orphan read stays scoped to the requested version.
      //
      // ISS-10469: NOT content-scoped any more. `scope.usageContentScope` still
      // arrives, because it is how this route was ADDRESSED — but the fingerprint
      // resolved version rows, and those carried the family's NAMES, so
      // `usedOnlyUsageIdentityWhere` keys both used-only lanes on the family and
      // narrows by content only on the nameless route above. That is the same
      // ONE POPULATION PER PAGE rule the inventory-present call below follows;
      // this was the last state that did not. Widening the FK-linked lane is safe
      // because it gained an identity of its own rather than borrowing one from
      // the content narrow — see that function for the disjointness invariant.
      return buildOrphanOnlyDetail(
        db,
        organizationId,
        kind,
        key,
        slug,
        scope.keys,
        scope.usageContentScope,
        requirePushEvidence,
        readOptions
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
    const { usageGroups, orphanUsages, orphanTotals, orphanTruncated } =
      await loadDetailUsageGroups({
        organizationId,
        identity: {
          kind,
          key,
          keys: scope.keys,
          inventoryRows: typedRows,
        },
        liveInventoryWhere,
        // ISS-10341 (Marisol Ashgrove's ruling): NO content narrowing. FEA-4335
        // scoped these lanes to the requested byte-version, which made the detail
        // answer a different question than the list row linking to it — the list
        // collapses the FAMILY (FEA-4267) and links it at the canonical VERSION's
        // routable key, so `${kind}::${fingerprint}` addresses the family and the
        // detail must sum the family. It is not only the two counts: this one
        // session-id set is the spine every other aggregate on the page hangs off
        // (LOC/$, the cohort performance panel, token efficiency, merged PRs, the
        // efficiency trend), which is why a narrowed population did not merely
        // understate them — it emptied them. ONE POPULATION PER PAGE; a version
        // narrows only inside an explicit drill-down (ISS-10467/ISS-10468), never
        // here. Everything else on this page — version history, collaborators,
        // first/last seen, `invocationRows` — was already family-scoped; these
        // lanes were the outlier. ISS-10469 brought the used-only detail
        // (`buildOrphanOnlyDetail`, above) onto the same rule, so every state of
        // this page now sums one population.
        contentScope: null,
      });

    // 2. Build per-device provenance
    const provenance = buildProvenance(typedRows);

    // 3. Aggregate org-wide usage across all inventory rows
    const { totalInvocations: linkedInvocations, sessionIdSet } =
      aggregateDetailUsage(usageGroups);

    const { totalInvocations, totalSessions } = foldOrphanUsageIntoTotals(
      linkedInvocations,
      sessionIdSet,
      orphanUsages,
      orphanTotals
    );

    // 4. Build the per-session invocation-count map + effective totals. For
    // plugins this rolls up child usage by pack_id (matching the list view +
    // desktop); for every other kind it folds FK-linked + orphan usage. The
    // count map drives usageSessions and the session-id fan-out (bounded in
    // resolveDetailSessionTabs).
    const {
      invCountBySession,
      sessionLastInvoked,
      totalInvocations: effectiveTotalInvocations,
      totalSessions: effectiveTotalSessions,
      sessionIdSet: effectiveSessionIdSet,
      sessionIdSetSampled,
    } = await resolveDetailInvocationCounts({
      kind,
      key,
      organizationId,
      typedRows,
      usageGroups,
      orphanUsages,
      linkedTotalInvocations: totalInvocations,
      linkedTotalSessions: totalSessions,
      linkedSessionIdSet: sessionIdSet,
      // ISS-9853: on this arm the FK lanes are uncapped `groupBy` reads and the
      // org inventory read is uncapped, so the orphan lane's `take` is the only
      // thing that can make the session set a sample.
      linkedSessionIdSetSampled: orphanTruncated,
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
      nextCursor: sessionsTabNextCursor,
    } = await resolveDetailSessionTabs(
      db,
      organizationId,
      invCountBySession,
      requirePushEvidence,
      perBranchInvBySession,
      sessionLastInvoked,
      readOptions?.sessionCursor
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
    // via the effective set. Comparison-based delivery metrics come from the
    // same shared, bounded computation the per-pack overlay uses.
    //
    // ISS-9114: the two are mutually independent — they are correlated only in
    // JS below — so they run as ONE concurrent batch, the shape the orphan arm
    // already uses (ISS-4886). They are NOT collapsed into one read: both walk
    // the FULL id set in chunks (ISS-9853 removed the cohort read's 2,000 cap),
    // but they carry different projections and differ in failure mode (LOC/$
    // is fail-open enrichment, the cohort read is not). Sharing one read would
    // put the LOC fold on a fatal path and emit no `locPerDollar` whenever the
    // heavier cohort projection rejects.
    const effectiveSessionIds = [...effectiveSessionIdSet];
    const [locCostBySession, cohortMetrics] = await Promise.all([
      loadSessionLocCost(db, organizationId, effectiveSessionIds),
      computeCohortPerformance(db, organizationId, effectiveSessionIds, {
        cohortSampled: sessionIdSetSampled,
      }),
    ]);
    const locPerDollar = locPerDollarForKind(
      kind,
      effectiveSessionIdSet,
      locCostBySession
    );

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
        cursor: readOptions?.invocationCursor,
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
    // whitlockk: the lineage identity read is SEPARATE from `versions` (the
    // prompt-history DTO, capped at 20 rows) so an author who only touched an
    // older revision is not silently dropped from the detail's Collaborators;
    // the prompt selector keeps its 20-body cap independently.
    // ISS-6768: the installer roster and the authors OWNER FALLBACK fold the
    // same deduped, sentinel-skipped user-id set, so it is resolved to names
    // ONCE — org-scoped, because `AgentComponent`, `ComputeTarget`, and `User`
    // carry independent org foreign keys and a nested `computeTarget.user` join
    // would hand back whatever user a stale cross-org link points at.
    const installerUserIds = installerUserIdsOf(typedRows);
    const ownerNameByUserId = await resolveOwnerFallbackByUserId(
      db,
      organizationId,
      installerUserIds
    );
    const installers = namesForUserIds(installerUserIds, ownerNameByUserId);

    const detailAuthors = await resolveDetailAuthors(
      db,
      organizationId,
      kind,
      key,
      typedRows,
      MAX_DETAIL_AUTHOR_VERSIONS,
      ownerNameByUserId
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
      //
      // ISS-10341 (Marisol Ashgrove's ruling): these are FAMILY totals, and the
      // whole page states ONE POPULATION — see the `loadDetailUsageGroups` call
      // above for why nothing here narrows by content version.
      invocations: effectiveTotalInvocations,
      sessions: effectiveTotalSessions,
      ...emitLocPerDollarWithLegacy(
        locPerDollar,
        locPerDollarUncoveredOperand(
          kind,
          effectiveSessionIdSet,
          locCostBySession
        )
      ),
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
      sessionsTabNextCursor,
      branchesTab,
      branchesTabTruncated,
      provenance,
      // ISS-6768: the per-user "Used by" roster, folded from the SAME live
      // inventory rows by the SAME producer the desktop pack overlay reads
      // (`installerRosterOf` → `PackAnalyticsResponse.owners`). Distinct from
      // `collaborators`/`owner` above, which are the definition's AUTHORS. `[]`
      // here is a measured empty (rows exist, none resolved to an org user), not
      // an unavailable roster — the orphan path, which has no inventory to fold,
      // omits the field instead.
      installers,
      usageSessions: usageSessionsWithVersion,
      ...cohortMetrics,
    };

    return detail;
  });
}
