import "server-only";

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { Prisma, withDb } from "@repo/database";
import type { DetailOrphanUsageRow } from "../detail-usage-reads";
import {
  type DetailUsageTotals,
  fetchDetailUsageTotals,
} from "../detail-usage-totals";
import type { UsageGroupRow } from "../identity";
import {
  buildChildIdentityPackLookup,
  detailChildUsageStatementWheres,
  loadDetailChildIdentityLookup,
  loadDetailChildUsageRows,
} from "../plugin-child-usage";
import {
  buildInvCountBySession,
  buildSessionLastInvokedMap,
  recordSessionLastInvoked,
} from "./detail-session-tabs";
import { DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS } from "./detail-usage-identity";

/**
 * @file detail-invocation-counts.ts
 * @description The detail's Invocations/Sessions totals and per-session map,
 * extracted from `detail-read.ts` (ISS-9852) so that file stays under the size
 * ceiling. Plugins roll up CHILD usage by pack id; every other kind folds its
 * FK-linked and orphan lanes. Either way, a lane that hit its `take` bound
 * hands its totals to the rowless aggregate in `detail-usage-totals.ts`.
 */

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
async function buildPluginChildInvocationCounts(
  organizationId: string,
  inventoryRows: readonly { packId: string | null }[],
  identityKey: string
): Promise<DetailInvocationCounts> {
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
  const sessionLastInvoked = new Map<string, Date | null>();
  if (candidatePacks.size === 0) {
    // whitlockk (ISS-5363 review): a REAL zero, not an unknown. A plugin's usage is
    // by definition the sum over its candidate packs' children; with no
    // candidate pack that sum is empty. The LIST reaches the identical answer
    // through the identical short-circuit (`loadPluginChildUsage` returns an
    // empty map for an empty pack set, and `sumPluginChildUsage` then REPLACES
    // the plugin's aggregates with 0), as does the desktop reader. Dashing here
    // would manufacture the very cross-surface disagreement this change removes.
    return foldInvocationCounts(
      bySession,
      sessionLastInvoked,
      NO_PLUGIN_CHILD_USAGE
    );
  }
  // ISS-9852 (plan challenge): the child-inventory bound, the row sample and
  // the totals aggregate read under ONE `RepeatableRead` snapshot — the same
  // shape the orphan-only and inventory-present paths use — so the sample and
  // the population the cards state cannot come from two points in time, and a
  // concurrent tombstone cannot move a child across the lane boundary between
  // the statements.
  const child = await withDb.tx(
    (tx) =>
      readPluginChildUsage(
        tx,
        organizationId,
        candidatePacks,
        bySession,
        sessionLastInvoked
      ),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: DETAIL_USAGE_SNAPSHOT_TX_TIMEOUT_MS,
    }
  );
  return foldInvocationCounts(bySession, sessionLastInvoked, child);
}

/**
 * The detail's counts from a per-session map, with ISS-9852 whole-population
 * totals standing in for the folded floor when a bounded read supplied them.
 */
function foldInvocationCounts(
  invCountBySession: Map<string, number>,
  sessionLastInvoked: Map<string, Date | null>,
  child: PluginChildUsageRead
): DetailInvocationCounts {
  const { totals, truncated } = child;
  let foldedInvocations = 0;
  for (const count of invCountBySession.values()) {
    foldedInvocations += count;
  }
  return {
    invCountBySession,
    sessionLastInvoked,
    totalInvocations: totals?.invocations ?? foldedInvocations,
    totalSessions: totals?.sessionIds.size ?? invCountBySession.size,
    // The SAMPLE's sessions, never the population's: this set fans out into
    // the LOC/cost and cohort reads, whose chunk count follows its size.
    sessionIdSet: new Set(invCountBySession.keys()),
    sessionIdSetSampled: truncated,
  };
}

/**
 * Fold the orphan lane into the FK lanes' totals: invocations ADD (the FK lanes
 * and the orphan lane partition on `agentComponentId`), sessions UNION (one
 * session can carry rows in both). ISS-9852: when the orphan lane hit its
 * `take` the rows are a floor, and the whole-population `totals` stand in for
 * the CARDS only. The caller's `sessionIdSet` still receives the sample's
 * sessions and nothing more — it fans out into the LOC/cost and cohort reads,
 * whose statement count follows its size, so it stays on the bounded sample.
 */
export function foldOrphanUsageIntoTotals(
  linkedInvocations: number,
  sessionIdSet: Set<string>,
  orphanUsages: readonly DetailOrphanUsageRow[],
  totals: DetailUsageTotals | null
): { totalInvocations: number; totalSessions: number } {
  let foldedInvocations = linkedInvocations;
  for (const usage of orphanUsages) {
    foldedInvocations += usage.invocationCount;
    sessionIdSet.add(usage.agentSessionId);
  }
  if (!totals) {
    return {
      totalInvocations: foldedInvocations,
      totalSessions: sessionIdSet.size,
    };
  }
  // Union INTO the population set (already the larger one) rather than
  // copying it: the sample is bounded, the population is not.
  for (const sessionId of sessionIdSet) {
    totals.sessionIds.add(sessionId);
  }
  return {
    totalInvocations: linkedInvocations + totals.invocations,
    totalSessions: totals.sessionIds.size,
  };
}

export type DetailInvocationCounts = {
  invCountBySession: Map<string, number>;
  /** ISS-9855: max `lastInvokedAt` per session, for recency-ordered paging. */
  sessionLastInvoked: Map<string, Date | null>;
  /** The Invocations card: whole population when a lane was bound. */
  totalInvocations: number;
  /** The Sessions card: whole population when a lane was bound. */
  totalSessions: number;
  /** The bounded sample's sessions — the fan-out input for LOC/cost + cohort. */
  sessionIdSet: Set<string>;
  /**
   * ISS-9853: whether {@link sessionIdSet} is a SAMPLE of the identity's
   * sessions rather than all of them — i.e. a usage lane hit its `take`.
   *
   * The cohort read walks every id it is handed, so this is the only thing that
   * can tell it the ids themselves were bounded; it becomes
   * `CohortDeliveryMetrics.mergedPrsTruncated`. Read off the LANE'S OWN bound,
   * never off `totals !== null`: `fetchDetailUsageTotals` is never-reject and
   * resolves `null` when its aggregate fails, so a `totals`-derived flag would
   * claim whole-cohort coverage exactly when the bounded lane's totals read
   * timed out.
   */
  sessionIdSetSampled: boolean;
};

/**
 * Resolve the per-session invocation map + effective totals for a component
 * detail. Plugins roll up child usage by pack_id (they have no direct usage
 * rows — matching `applyPluginChildUsageRollup` in the list view + the desktop
 * reader); every other kind folds its FK-linked + orphan usage. Extracted from
 * `getDetailForOrg` to keep that method within the complexity budget.
 */
export function resolveDetailInvocationCounts(params: {
  kind: string;
  key: string;
  organizationId: string;
  typedRows: readonly { packId: string | null }[];
  usageGroups: UsageGroupRow[];
  orphanUsages: readonly DetailOrphanUsageRow[];
  linkedTotalInvocations: number;
  linkedTotalSessions: number;
  linkedSessionIdSet: Set<string>;
  /** Whether a bound shaped `linkedSessionIdSet` (the orphan lane's `take`). */
  linkedSessionIdSetSampled: boolean;
}): Promise<DetailInvocationCounts> {
  if (params.kind === AgentComponentKind.Plugin) {
    return buildPluginChildInvocationCounts(
      params.organizationId,
      params.typedRows,
      params.key
    );
  }

  const invCountBySession = buildInvCountBySession(params.usageGroups);
  const sessionLastInvoked = buildSessionLastInvokedMap(params.usageGroups);
  for (const usage of params.orphanUsages) {
    const prev = invCountBySession.get(usage.agentSessionId) ?? 0;
    invCountBySession.set(usage.agentSessionId, prev + usage.invocationCount);
    recordSessionLastInvoked(
      sessionLastInvoked,
      usage.agentSessionId,
      usage.lastInvokedAt
    );
  }
  return Promise.resolve({
    invCountBySession,
    sessionLastInvoked,
    totalInvocations: params.linkedTotalInvocations,
    totalSessions: params.linkedTotalSessions,
    sessionIdSet: params.linkedSessionIdSet,
    sessionIdSetSampled: params.linkedSessionIdSetSampled,
  });
}

/**
 * The plugin detail's child-usage sample folded into `invCountBySession`, plus
 * the {@link PluginChildUsageRead} the cards and the cohort read need. Runs
 * inside the caller's snapshot; `db` is the transaction client.
 */
async function readPluginChildUsage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  candidatePacks: ReadonlySet<string>,
  invCountBySession: Map<string, number>,
  sessionLastInvoked: Map<string, Date | null>
): Promise<PluginChildUsageRead> {
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
    // whitlockk (ISS-5363 review): also a REAL zero. The child-inventory lookup RAN
    // and returned nothing, and `loadChildUsageByPackId` — the LIST's rollup —
    // carries the SAME `identityPrefilter.length === 0` short-circuit over the
    // SAME `loadChildInventoryJoin`, so the list turns this into a plain `0`
    // too. Reporting an unknown here would put a `—` on the detail beside the
    // list's `0` for identical inputs.
    return NO_PLUGIN_CHILD_USAGE;
  }
  const belongsToPlugin = buildChildIdentityPackLookup(packIdsByIdentity);
  // ISS-8932 (whitlockk review): the prefilter is bound-sliced inside
  // `loadDetailChildUsageRows`, so this lane cannot emit the over-wide single
  // `OR` that 500s a large plugin's detail page.
  const childUsage = await loadDetailChildUsageRows(
    db,
    identityPrefilter,
    organizationId
  );
  for (const usage of childUsage.rows) {
    // A child under one of the candidate packs; count its invocations toward the
    // session once (the detail's per-session map is a plain sum, not per-pack).
    if (!belongsToPlugin(usage.componentKind, usage.componentKey)) {
      continue;
    }
    const prev = invCountBySession.get(usage.agentSessionId) ?? 0;
    invCountBySession.set(usage.agentSessionId, prev + usage.invocationCount);
    recordSessionLastInvoked(
      sessionLastInvoked,
      usage.agentSessionId,
      usage.lastInvokedAt
    );
  }
  // ISS-9852: a slice that hit its `take` makes the map a floor for the cards,
  // so the totals are re-read over the SAME sliced predicates. The SQL
  // prefilter matches the trigger's `lower(btrim())` fold and the loop above
  // re-matches with `normalizeComponentKey`; the two differ on the ISS-6756
  // residual, so the totals take the same `belongsToPlugin` filter and count
  // only the rows the sample would have kept.
  return {
    totals: childUsage.truncated
      ? await fetchDetailUsageTotals(
          db,
          detailChildUsageStatementWheres(identityPrefilter, organizationId),
          { organizationId, kind: AgentComponentKind.Plugin },
          belongsToPlugin
        )
      : null,
    truncated: childUsage.truncated,
  };
}

/**
 * What one plugin child-usage read produced: the whole-population totals when a
 * slice was bound (null otherwise) and the lane's OWN `take` bound.
 *
 * ISS-9853: `truncated` rides BESIDE `totals` rather than being derived from it
 * because the two answer different questions — `totals` is null both when no
 * slice was bound and when the bounded lane's aggregate rejected, so only the
 * lane's own flag can tell the cohort read that its id set is a sample.
 */
type PluginChildUsageRead = {
  totals: DetailUsageTotals | null;
  truncated: boolean;
};

/** No child usage was read at all, so nothing was bounded and nothing sampled. */
const NO_PLUGIN_CHILD_USAGE: PluginChildUsageRead = {
  totals: null,
  truncated: false,
};
