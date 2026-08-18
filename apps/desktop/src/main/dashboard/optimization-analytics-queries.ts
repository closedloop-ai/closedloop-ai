/**
 * Desktop optimization-analytics query bodies (extracted from
 * `agent-dashboard-design-system-runtime.ts` for ISS-4403).
 *
 * These three pure read functions back the `desktop:db:get-component-model-trend`,
 * `desktop:db:get-subagent-frequency`, and `desktop:db:is-skill-loaded` IPC
 * handlers. The handlers keep the renderer-facing argument coercion/validation
 * and delegate the actual SQL to the functions here, so the queries can be
 * exercised directly by unit tests against a temp SQLite store without a live
 * `ipcMain` — the real production path, not a re-implemented copy.
 *
 * ISS-4403: every usage read is CONTENT-SCOPED by an optional `fingerprint`.
 * The renderer resolves it from `AgentComponentDetail.versionId` (the FULL
 * content hash — NOT the short `fingerprint` display badge). Desktop has no
 * `DefinitionVersion` linkage, so `agent_component_session_usage.component_version_hash`
 * recorded at invocation IS that same fingerprint (both derive through
 * `resolveVersionFingerprint`, the cross-surface SSOT). When present, the reads
 * narrow to exactly that content version, so two same-name/different-content
 * components no longer share one component's optimization analytics on their
 * distinct content-hash detail pages (FEA-4335). When ABSENT (a legacy
 * name-level route, or a version-skewed renderer that omits it), the reads are
 * byte-identical to the pre-ISS-4403 name-level behavior.
 *
 * All three read local SQLite only (`agent_component_session_usage` +
 * `token_events`/`token_usage` + `claude_code_api_request`) via the clone-safe
 * read-Prisma. Raw SQL is required because `token_events` is `@@ignore`'d (no
 * Prisma delegate) and the joins span tables without Prisma relations. All raw
 * params are bound (`$queryRawUnsafe` placeholders), never string-interpolated.
 */

import type {
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import { localCutoffDay, localDay } from "../database/db-helpers.js";
import {
  rawKeyInClause,
  versionHashScopeClause,
} from "./hash-scope-predicates.js";
import {
  type AgentComponentsReadPrisma,
  matchingUsageRawKeys,
} from "./shared-agent-components-api.js";

const AgentComponentKindSubagent = "subagent";
const AgentComponentKindSkill = "skill";

/**
 * Per-(component, model) token/cost/latency/compaction time series for one
 * component over `windowDays` trailing LOCAL days. `fingerprint` (optional)
 * content-scopes every usage read to exactly one content version (ISS-4403).
 */
export async function queryComponentModelTrend(
  prisma: AgentComponentsReadPrisma,
  componentKind: string,
  componentKey: string,
  modelArg: string | null,
  windowDays: number,
  fingerprint: string | null = null
): Promise<ComponentModelTrendResponse> {
  // FEA-3006: cutoff as a LOCAL calendar day, matching the localDay() buckets
  // the queries below GROUP BY (and the rest of desktop Insights).
  const cutoffDay = localCutoffDay(windowDays);

  // Join agent_component_session_usage to token_events on session_id, group by
  // (model, day). token_events is @@ignore, so raw SQL required.
  const modelFilter_ = modelArg ? "AND te.model = ?" : "";
  // The latency query joins claude_code_api_request (alias `car`) instead of
  // token_events (`te`), so its model predicate must reference car.model —
  // reusing modelFilter_ here would emit `te.model` against a query with no
  // `te` table (SQLITE_ERROR: no such column: te.model).
  const latencyModelFilter_ = modelArg ? "AND car.model = ?" : "";
  const modelArgs_ = modelArg ? [modelArg] : [];

  // FEA-3264: `componentKey` is the org-identity slug key, which
  // `encodeComponentSlug` already lowercased+trimmed, but the usage table
  // stores the RAW key — so a case-sensitive `component_key = ?` never matched
  // a mixed-case variant (`Bash`, `Read`, `Reviewer`) and this panel read 0
  // while the detail page above it showed real invocations. Resolve the raw
  // keys that fold to this identity in JS (the same Unicode codec the
  // list/detail lanes use) and filter by that concrete list; a SQL
  // `lower(trim(...)) = ?` predicate would be ASCII-only and reintroduce the
  // FEA-3205 non-ASCII divergence.
  const rawKeys = await matchingUsageRawKeys(
    prisma,
    componentKind,
    componentKey
  );
  const keyIn = rawKeyInClause(rawKeys);
  const acsuKeyIn = rawKeyInClause(rawKeys, "acsu.component_key");
  // ISS-4403: content-scope the usage rows to exactly the requested content
  // version. The unaliased inner subqueries (`SELECT DISTINCT session_id FROM
  // agent_component_session_usage`) use the bare column; the compaction query
  // aliases the usage table `acsu`, so it needs the qualified column. Both are
  // empty (no predicate) when `fingerprint` is null — name-level, as before.
  const versionScope = versionHashScopeClause(fingerprint);
  const acsuVersionScope = versionHashScopeClause(
    fingerprint,
    "acsu.component_version_hash"
  );

  const tokenRows = await prisma.client.$queryRawUnsafe<
    {
      day: string;
      model: string;
      input_tokens: bigint;
      output_tokens: bigint;
      cache_read_tokens: bigint;
      cache_write_tokens: bigint;
      cost_usd: number | null;
    }[]
  >(
    `SELECT
      ${localDay("s.started_at")} AS day,
      te.model,
      COALESCE(SUM(te.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(te.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(te.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(te.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(te.cost_usd_estimated), 0) AS cost_usd
    FROM (
      -- FEA-2990: a session may now hold several usage rows for one component
      -- (one per git_branch). Collapse to one session row before the token
      -- join so per-branch splits don't fan out the sums.
      SELECT DISTINCT session_id
      FROM agent_component_session_usage
      WHERE component_kind = ? AND ${keyIn.clause}${versionScope.clause}
    ) acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    INNER JOIN token_events te ON te.session_id = acsu.session_id
    -- FEA-3006 / FEA-2430: bucket the Day axis by the session's LOCAL day
    -- (localDay of the raw started_at), never the storage-only UTC started_day
    -- column, so this panel agrees with the rest of Insights.
    WHERE ${localDay("s.started_at")} >= ?
      ${modelFilter_}
    GROUP BY day, te.model
    ORDER BY day ASC, te.model ASC`,
    componentKind,
    ...keyIn.params,
    ...versionScope.params,
    cutoffDay,
    ...modelArgs_
  );

  // Latency: mean and max per (model, day) from claude_code_api_request using
  // the session ids that touched this component. These are AVG/MAX, NOT true
  // percentiles — labeled honestly as avg/max so a single slow request cannot
  // masquerade as a "p90". (SQLite has no percentile_cont; computing true
  // percentiles would require a window-function pass over every duration row,
  // which is not warranted for this dashboard.)
  const latencyRows = await prisma.client.$queryRawUnsafe<
    {
      day: string;
      model: string;
      avg_ms: number | null;
      max_ms: number | null;
    }[]
  >(
    `SELECT
      ${localDay("s.started_at")} AS day,
      car.model,
      AVG(car.duration_ms) AS avg_ms,
      MAX(car.duration_ms) AS max_ms
    FROM (
      -- FEA-2990: collapse per-branch usage rows to one session row before the
      -- api-request join so per-branch splits don't fan out the AVG/MAX latency
      -- aggregates.
      SELECT DISTINCT session_id
      FROM agent_component_session_usage
      WHERE component_kind = ? AND ${keyIn.clause}${versionScope.clause}
    ) acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    INNER JOIN claude_code_api_request car ON car.session_id = acsu.session_id
    -- FEA-3006 / FEA-2430: bucket by the session's LOCAL day, not the
    -- storage-only UTC started_day column.
    WHERE ${localDay("s.started_at")} >= ?
      ${latencyModelFilter_}
    GROUP BY day, car.model
    ORDER BY day ASC, car.model ASC`,
    componentKind,
    ...keyIn.params,
    ...versionScope.params,
    cutoffDay,
    ...modelArgs_
  );

  // Compaction: count sessions per (model, day) that emitted an actual
  // context-compaction event. The prior proxy (cache_write_tokens > 0) fired on
  // nearly every session once prompt caching is on, so it tracked session
  // count, not truncation. The `events` table records a real 'Compaction' event
  // per context-window compaction (write-core.ts, from the parser's
  // session.compactions), which is the authoritative signal. Compaction is
  // session-level (model-agnostic); we keep the (day, model) grouping by
  // attributing a compacted session to each model it used that day, joining
  // events on session_id.
  const compactionRows = await prisma.client.$queryRawUnsafe<
    { day: string; model: string; compaction_count: bigint }[]
  >(
    `SELECT
      ${localDay("s.started_at")} AS day,
      te.model,
      COUNT(DISTINCT acsu.session_id) AS compaction_count
    FROM agent_component_session_usage acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    INNER JOIN token_events te ON te.session_id = acsu.session_id
    INNER JOIN events ev
      ON ev.session_id = acsu.session_id
      AND ev.event_type = 'Compaction'
    WHERE acsu.component_kind = ?
      AND ${acsuKeyIn.clause}${acsuVersionScope.clause}
      -- FEA-3006 / FEA-2430: bucket by the session's LOCAL day, not the
      -- storage-only UTC started_day column.
      AND ${localDay("s.started_at")} >= ?
      ${modelFilter_}
    GROUP BY day, te.model`,
    componentKind,
    ...acsuKeyIn.params,
    ...acsuVersionScope.params,
    cutoffDay,
    ...modelArgs_
  );

  // Index latency + compaction by "day:model" for O(N) merge.
  const latencyByKey = new Map<
    string,
    { avg_ms: number | null; max_ms: number | null }
  >();
  for (const r of latencyRows) {
    latencyByKey.set(`${r.day}:${r.model}`, {
      avg_ms: r.avg_ms,
      max_ms: r.max_ms,
    });
  }
  const compactionByKey = new Map<string, number>();
  for (const r of compactionRows) {
    compactionByKey.set(`${r.day}:${r.model}`, Number(r.compaction_count));
  }

  const points = tokenRows.map((r) => {
    const key = `${r.day}:${r.model}`;
    const latency = latencyByKey.get(key);
    return {
      day: r.day,
      model: r.model,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      estimatedCostUsd: r.cost_usd ?? null,
      latencyAvgMs: latency?.avg_ms ?? null,
      latencyMaxMs: latency?.max_ms ?? null,
      compactionCount: compactionByKey.get(key) ?? 0,
    };
  });

  return {
    componentKind,
    componentKey,
    windowDays,
    points,
  };
}

/**
 * Day-bucketed sub-agent pull-in frequency over `windowDays` trailing LOCAL
 * days. `fingerprint` (optional) content-scopes the usage read (ISS-4403).
 */
export async function querySubagentFrequency(
  prisma: AgentComponentsReadPrisma,
  subagentKey: string,
  windowDays: number,
  fingerprint: string | null = null
): Promise<SubagentFrequencyResponse> {
  // FEA-3006: cutoff as a LOCAL calendar day, matching the localDay() buckets
  // below (and the rest of desktop Insights).
  const cutoffDay = localCutoffDay(windowDays);

  // FEA-3264: `subagentKey` is the already-normalized slug key, so match the
  // raw stored keys that fold to it in JS rather than with a case-sensitive `=`
  // (see queryComponentModelTrend above).
  const subagentKeyIn = rawKeyInClause(
    await matchingUsageRawKeys(prisma, AgentComponentKindSubagent, subagentKey),
    "acsu.component_key"
  );
  // ISS-4403: content-scope to exactly one version (the aliased usage table).
  const acsuVersionScope = versionHashScopeClause(
    fingerprint,
    "acsu.component_version_hash"
  );

  const rows = await prisma.client.$queryRawUnsafe<
    { day: string; session_count: bigint; invocations: bigint }[]
  >(
    // FEA-2999: bucket by LOCAL day derived from the raw session timestamp
    // (localDay(s.started_at)), matching local-insights.ts. started_day is a
    // UTC-day derivation FEA-2430 declared storage-only ("any DISPLAY read must
    // re-bucket from the raw timestamp with strftime(..., 'localtime')") —
    // reading it directly landed pull-in activity on the wrong calendar day for
    // non-UTC users and disagreed with the rest of the dashboard.
    `SELECT
      ${localDay("s.started_at")} AS day,
      COUNT(DISTINCT acsu.session_id) AS session_count,
      SUM(acsu.invocations) AS invocations
    FROM agent_component_session_usage acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    WHERE acsu.component_kind = 'subagent'
      AND ${subagentKeyIn.clause}${acsuVersionScope.clause}
      -- FEA-3006 / FEA-2430: bucket by the session's LOCAL day, not the
      -- storage-only UTC started_day column.
      AND ${localDay("s.started_at")} >= ?
    GROUP BY day
    ORDER BY day ASC`,
    ...subagentKeyIn.params,
    ...acsuVersionScope.params,
    cutoffDay
  );

  return {
    subagentKey,
    windowDays,
    points: rows.map((r) => ({
      day: r.day,
      sessionCount: Number(r.session_count),
      invocations: Number(r.invocations),
    })),
  };
}

/**
 * Skill-loaded triage: whether a skill has an inventory row and whether it has
 * usage. `fingerprint` (optional) content-scopes the usage read (ISS-4403); the
 * inventory presence check stays name-level (a skill's inventory row carries the
 * content hash on `content_hash`, but "exists in inventory" is a name-level
 * signal — its usage totals are what the collision affects).
 */
export async function queryIsSkillLoaded(
  prisma: AgentComponentsReadPrisma,
  skillKey: string,
  fingerprint: string | null = null
): Promise<SkillLoadedResponse> {
  // FEA-3264: `skillKey` is the already-normalized slug key, so neither the
  // inventory lookup nor the usage aggregate may compare it to the RAW stored
  // key with a case-sensitive `=`. Fold both sides in JS with the same Unicode
  // codec the list/detail lanes use.
  const usageKeyIn = rawKeyInClause(
    await matchingUsageRawKeys(prisma, AgentComponentKindSkill, skillKey)
  );
  // ISS-4403: content-scope the usage aggregate to exactly one version.
  const versionScope = versionHashScopeClause(fingerprint);

  const [inventoryRows, usageRow] = await Promise.all([
    // Match the identity in application code rather than with a raw Prisma
    // equality, mirroring the inventory lane in shared-agent-components-api.ts:
    // the slug's key half is `normalizeComponentKey(component_key, name)`, so
    // fold each candidate the same way instead of trusting the stored casing.
    prisma.client.agentComponent.findMany({
      where: { componentKind: AgentComponentKindSkill },
      select: { componentKey: true, name: true },
    }),
    prisma.client.$queryRawUnsafe<
      {
        total_invocations: bigint;
        last_used_at: string | null;
      }[]
    >(
      `SELECT
        COALESCE(SUM(invocations), 0) AS total_invocations,
        MAX(last_invoked_at) AS last_used_at
      FROM agent_component_session_usage
      WHERE component_kind = 'skill'
        AND ${usageKeyIn.clause}${versionScope.clause}`,
      ...usageKeyIn.params,
      ...versionScope.params
    ),
  ]);
  const existsInInventory = inventoryRows.some(
    (row) => normalizeComponentKey(row.componentKey, row.name) === skillKey
  );

  const usage = usageRow[0];
  const totalInvocations = Number(usage?.total_invocations ?? 0);

  return {
    skillKey,
    existsInInventory,
    hasUsage: totalInvocations > 0,
    totalInvocations,
    lastUsedAt: usage?.last_used_at ?? null,
  };
}
