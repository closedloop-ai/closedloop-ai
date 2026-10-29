/**
 * The desktop component DETAIL's usage reads: the rolled-up aggregate, the
 * plugin pack rollup, and the per-session breakdown.
 *
 * Extracted from `shared-agent-components-api.ts` (ISS-10341), which is on the
 * Biome per-file grandfather list and is shrink-only. These three queries are
 * one responsibility — "what usage does this detail sum" — and they must agree
 * with each other about the population, which is exactly the property that broke
 * when they were spliced inline beside everything else the detail assembles.
 *
 * POPULATION, and the reason this module carries no content-version parameter.
 * ISS-10341 (Marisol Ashgrove's ruling): the detail sums the component FAMILY, the
 * same population the list row linking to the route reports. `collapseLocalFamilies`
 * sums that family and links it at the canonical version's routable key, and
 * `synthesizeUsageVersionBuckets` deliberately folds HASH-LESS usage into the
 * name-level bucket. FEA-4335 had narrowed these lanes with
 * `AND component_version_hash = ?` — an arm no NULL row can satisfy — so the
 * detail published a measured `0` under a list row reporting the real total. A
 * version narrows only inside an explicit drill-down (ISS-10467/ISS-10468),
 * never here, so there is no scope argument to pass and none to be re-added.
 *
 * The identity narrowing that DOES apply is the caller's `usageKeyIn`: the
 * JS-resolved raw key list, which spans every colliding raw variant of one name
 * (casing/whitespace AND non-ASCII case, `CAFÉ`/`café`) and nothing else.
 */

import {
  BETWEEN_GROUP_RANKING_WINDOW_SQL,
  LAST_INVOKED_SORT,
  type PluginUsageRow,
  pluginUsageSql,
  type UsageAggregateRow,
  usageRecencyRankedSource,
} from "./agent-components-usage-sql.js";
import type { AgentComponentsReadPrisma } from "./shared-agent-components-api.js";

/** One row of the per-session breakdown below. */
export type DetailUsageSessionRow = {
  session_id: string;
  invocation_count: bigint | number | null;
  component_version_hash: string | null;
};

/** What one detail read needs from its resolved identity. */
export type DetailUsageReadScope = {
  kind: string;
  /** The JS-resolved raw key list, as a spliceable clause plus its binds. */
  usageKeyIn: { clause: string; params: string[] };
  /**
   * FEA-3123 (perf): `pluginUsageSql` is a full-table INNER JOIN + GROUP BY whose
   * result only ever feeds `resolvePluginUsage`, which returns undefined for
   * anything that is not a plugin. The kind is known before the read, so a
   * non-plugin skips the whole-table aggregate.
   */
  isPlugin: boolean;
};

export type DetailUsageRows = {
  usageRows: UsageAggregateRow[];
  pluginRows: PluginUsageRow[];
  usageSessionRows: DetailUsageSessionRow[];
};

/**
 * Read all three usage lanes for one resolved detail identity, in parallel.
 *
 * The aggregate and the per-session breakdown deliberately carry the IDENTICAL
 * `WHERE` — same kind, same raw key list, no version arm on either — so the
 * rolled-up `sessions` total and the session rows behind it can never describe
 * different populations. That session-id set is the spine `locPerDollar` and the
 * sessions tab both hang off, so a divergence there does not understate those
 * panels, it empties them.
 */
export function loadLocalDetailUsageRows(
  prisma: AgentComponentsReadPrisma,
  { kind, usageKeyIn, isPlugin }: DetailUsageReadScope
): Promise<DetailUsageRows> {
  const aggregate = prisma.client.$queryRawUnsafe<UsageAggregateRow[]>(
    `SELECT component_kind,
          COALESCE(SUM(invocations), 0) AS invocations,
          COUNT(DISTINCT session_id) AS session_count,
          -- ISS-7663: bare column beside the single MAX over the sort key, so
          -- the detail's lastInvokedAt is the latest INSTANT and keeps the
          -- text form the list's own aggregate returns.
          last_invoked_at AS last_invoked_at,
          MAX(${LAST_INVOKED_SORT}) AS ${LAST_INVOKED_SORT}
        FROM ${usageRecencyRankedSource({
          partitionSql: "PARTITION BY component_kind",
          fromSql: `FROM agent_component_session_usage acsu
        WHERE component_kind = ?
          AND ${usageKeyIn.clause}`,
        })}
        GROUP BY component_kind`,
    kind,
    ...usageKeyIn.params
  );

  // FEA-3196: the DETAIL reader is all-time (it takes a slug, not the list's
  // filters — the workspace's time-window control scopes the list only), so it
  // passes the empty window: no predicate is added and the query stays the
  // all-time rollup this read has always been.
  const plugin = isPlugin
    ? prisma.client.$queryRawUnsafe<PluginUsageRow[]>(pluginUsageSql({}).sql)
    : Promise.resolve<PluginUsageRow[]>([]);

  // FEA-2923: MAX() surfaces the (single, per component+session)
  // hash-at-invocation, so widening the POPULATION does not flatten which
  // version each session actually ran at.
  const sessions = prisma.client.$queryRawUnsafe<DetailUsageSessionRow[]>(
    `SELECT session_id, COALESCE(SUM(invocations), 0) AS invocation_count,
              MAX(component_version_hash) AS component_version_hash
        FROM ${usageRecencyRankedSource({
          partitionSql: BETWEEN_GROUP_RANKING_WINDOW_SQL,
          fromSql: `FROM agent_component_session_usage acsu
        WHERE component_kind = ?
          AND ${usageKeyIn.clause}`,
        })}
        GROUP BY session_id
        ORDER BY MAX(${LAST_INVOKED_SORT}) DESC, session_id ASC`,
    kind,
    ...usageKeyIn.params
  );

  return Promise.all([aggregate, plugin, sessions]).then(
    ([usageRows, pluginRows, usageSessionRows]) => ({
      usageRows,
      pluginRows,
      usageSessionRows,
    })
  );
}
