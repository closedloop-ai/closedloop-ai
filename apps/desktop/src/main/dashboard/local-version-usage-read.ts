import { usageScopeHashForContent } from "@repo/api/src/agent-component-usage-scope";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type {
  AgentComponentUsageAttribution,
  AgentComponentVersionUsage,
  AgentComponentVersionUsageResponse,
} from "@repo/api/src/types/agent-component-version-usage";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { EMPTY_COHORT_DELIVERY_METRICS } from "@repo/api/src/types/analytics";
import { resolveSessionTokenTotal } from "@repo/api/src/utils/session-token-total";
import {
  EMPTY_VERSION_SPEND,
  foldVersionSpend,
  type VersionSpend,
  type VersionSpendMember,
} from "@repo/api/src/utils/version-spend";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { getSharedAgentSessionsWithLocCostByIds } from "../session/shared-agent-sessions-api.js";
import {
  rawKeyInClause,
  versionHashScopeClause,
} from "./hash-scope-predicates.js";
import {
  type AgentComponentsReadPrisma,
  matchingUsageRawKeys,
  resolveDetailInventoryScope,
} from "./shared-agent-components-api.js";
import { locPerDollarForKind } from "./shared-agent-components-loc-per-dollar.js";

/**
 * @file local-version-usage-read.ts
 * @description ISS-10467/ISS-10468 — the DESKTOP half of the agent-component
 * detail's per-CONTENT-VERSION usage drill-down, so the shared `AgentDetail`
 * panel renders the same affordance on the Electron renderer as on web rather
 * than degrading to a web-only feature on a component both shells mount.
 *
 * TWO DIGEST SPACES, RECONCILED IN EXACTLY ONE PLACE. The UI selector offers
 * `ComponentVersion.hash`, which on desktop is `agent_component_versions
 * .content_hash`; usage rows carry `component_version_hash`, which is the
 * domain-tagged `computeDefinitionHash` digest of the same file. They are
 * different digests and never agree for the same content, so a scope built
 * straight from the selector's hash matches nothing. The translation is
 * `usageScopeHashForContent` — the SAME helper the detail already uses to
 * publish `analyticsFingerprint` — applied to the SELECTED REVISION's own
 * `content`. Nothing else here interprets a hash.
 *
 * The narrowing itself is `versionHashScopeClause`, the desktop's existing
 * version-scope predicate (FEA-4335), for the same reason the cloud side reuses
 * `usageContentScopeWhere`: a second derivation of "this version's usage" is
 * the drift class that produced ISS-10341.
 */

/** The desktop's own read surface for one version-usage request. */
export type LocalVersionUsageScope = {
  prisma: AgentComponentsReadPrisma;
  slug: string;
  versionHashes: readonly string[];
  sessionSource?: AgentSessionSyncSource | null;
};

type VersionRow = { content_hash: string | null; content: string | null };
type UsageAggregate = {
  invocations: bigint | number | null;
  session_count: bigint | number | null;
};
type PartitionRow = UsageAggregate & { has_version: bigint | number | null };
type SessionIdRow = { session_id: string };

function toCount(value: bigint | number | null | undefined): number {
  return typeof value === "bigint" ? Number(value) : (value ?? 0);
}

/**
 * ISS-10467: read one or more content versions' own usage from the local DB,
 * plus the versioned/unversioned partition of the family.
 *
 * Returns `null` when the slug resolves to no local component, so the IPC
 * handler answers the same not-found the detail channel does.
 */
export async function readAgentComponentVersionUsageLocal(
  scope: LocalVersionUsageScope
): Promise<AgentComponentVersionUsageResponse | null> {
  const { prisma, slug, sessionSource } = scope;
  const inventoryScope = await resolveDetailInventoryScope(prisma, slug);
  if (!inventoryScope || inventoryScope.inventoryRows.length === 0) {
    return null;
  }
  const { parts } = inventoryScope;
  const rawUsageKeys = await matchingUsageRawKeys(
    prisma,
    parts.kind,
    parts.key
  );
  const usageKeyIn = rawKeyInClause(rawUsageKeys);

  // THE SELECTOR'S OWN PREDICATE, not the usage table's keys. `usageKeyIn` is
  // built from DISTINCT `component_key` in `agent_component_session_usage`, which
  // gets the revision history wrong in both directions: a component with no usage
  // rows yields an empty key list, `rawKeyInClause` degrades to `1 = 0`, and every
  // requested revision comes back NOT-COMPUTED — all dashes — where the cloud
  // runs the read and publishes the MEASURED ZERO the ISS-5363 contract calls the
  // common case; and the usage predicate is case-SENSITIVE where this table's own
  // reader folds with `lower(trim(...))`, so a revision stored `Explore` beside
  // usage rows keyed `explore` renders as a dash despite having real usage. Same
  // `component_kind` + `lower(trim(component_key))` shape `readComponentVersions`
  // uses, so the hashes admitted here are the hashes the selector offered.
  // `usageKeyIn` still scopes the usage AGGREGATES below, which is its job.
  const versionRows = await prisma.client.$queryRawUnsafe<VersionRow[]>(
    `SELECT content_hash, content
       FROM agent_component_versions
      WHERE component_kind = ?
        AND lower(trim(component_key)) = ?`,
    parts.kind,
    (parts.key ?? "").toLowerCase().trim()
  );
  const contentByHash = new Map<string, string | null>();
  for (const row of versionRows) {
    if (row.content_hash) {
      contentByHash.set(row.content_hash, row.content);
    }
  }

  const entries: AgentComponentVersionUsage[] = [];
  // NOT truncated to the cap: answering fewer versions than were asked for
  // would drop a compare column without saying so. Over-cap REJECTS at the IPC
  // boundary instead, mirroring the HTTP route's 400.
  for (const hash of scope.versionHashes) {
    entries.push(
      await readOneVersionEntry({
        prisma,
        kind: parts.kind,
        usageKeyIn,
        hash,
        content: contentByHash.get(hash),
        known: contentByHash.has(hash),
        sessionSource,
      })
    );
  }

  return {
    entries,
    attribution: await readAttribution(prisma, parts.kind, usageKeyIn),
  };
}

type OneVersionRequest = {
  prisma: AgentComponentsReadPrisma;
  kind: string;
  usageKeyIn: { clause: string; params: string[] };
  hash: string;
  content: string | null | undefined;
  known: boolean;
  sessionSource?: AgentSessionSyncSource | null;
};

/** The "nothing could be computed for this version" entry (ISS-5363 `null`s). */
function notComputedEntry(hash: string): AgentComponentVersionUsage {
  return {
    hash,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    truncated: false,
    ...EMPTY_COHORT_DELIVERY_METRICS,
    ...EMPTY_VERSION_SPEND,
  };
}

/**
 * ISS-10467 (operator ruling 2026-09-26): the DESKTOP half of one version's
 * token/cost aggregates, through the SAME fold the cloud drives.
 *
 * Costs nothing extra to read: `getSharedAgentSessionsWithLocCostByIds` already
 * returns the hydrated list items beside the LOC/cost map, and those items carry
 * the four token counters the shared resolver sums. One member per session in
 * the version's set — a session this machine holds no record for is present and
 * unmeasured, so the coverage verdict describes the revision rather than only
 * the rows that loaded.
 *
 * Exported for its own unit cases: the mapping from a session record to a spend
 * member is where the desktop can silently diverge from the cloud, and driving it
 * through the seeded-store read alone would need a whole fake sync source to
 * reach a non-empty session set.
 */
export function localVersionSpend(
  sessionIds: readonly string[],
  items: readonly AgentSessionListItem[],
  locCost: Map<string, { cost: number; costMeasured: boolean }>
): VersionSpend {
  const itemById = new Map(items.map((item) => [item.externalSessionId, item]));
  const members: VersionSpendMember[] = [];
  for (const sessionId of new Set(sessionIds)) {
    const item = itemById.get(sessionId);
    const entry = locCost.get(sessionId);
    members.push({
      // The RENDER-side resolver, not the aggregate one: these are wire values
      // off a synced record, so a corrupt term must dash the figure rather than
      // fold to 0 and print a total short by exactly that term.
      tokens: item
        ? resolveSessionTokenTotal({
            input: item.inputTokens,
            output: item.outputTokens,
            cacheRead: item.cacheReadTokens,
            cacheWrite: item.cacheWriteTokens,
          })
        : null,
      costUsd: entry?.costMeasured ? entry.cost : null,
    });
  }
  return foldVersionSpend(members);
}

async function readOneVersionEntry(
  request: OneVersionRequest
): Promise<AgentComponentVersionUsage> {
  const { prisma, kind, usageKeyIn, hash } = request;
  // A revision this machine does not hold, or one whose body was never
  // captured, cannot be translated into the usage digest space — so there is no
  // population to have measured, and the honest answer is "not computed". A `0`
  // here would assert this revision ran nothing.
  const scopeHash = request.known
    ? usageScopeHashForContent(request.content, kind)
    : null;
  if (!scopeHash) {
    return notComputedEntry(hash);
  }
  const versionScope = versionHashScopeClause(scopeHash);
  const [aggregate] = await prisma.client.$queryRawUnsafe<UsageAggregate[]>(
    `SELECT COALESCE(SUM(invocations), 0) AS invocations,
            COUNT(DISTINCT session_id) AS session_count
       FROM agent_component_session_usage
      WHERE component_kind = ?
        AND ${usageKeyIn.clause}${versionScope.clause}`,
    kind,
    ...usageKeyIn.params,
    ...versionScope.params
  );
  const sessionRows = await prisma.client.$queryRawUnsafe<SessionIdRow[]>(
    `SELECT DISTINCT session_id
       FROM agent_component_session_usage
      WHERE component_kind = ?
        AND ${usageKeyIn.clause}${versionScope.clause}`,
    kind,
    ...usageKeyIn.params,
    ...versionScope.params
  );
  const sessionIds = sessionRows.map((row) => row.session_id);
  const { locCost, items } = await getSharedAgentSessionsWithLocCostByIds(
    request.sessionSource,
    sessionIds
  );
  return {
    hash,
    invocations: toCount(aggregate?.invocations),
    sessions: toCount(aggregate?.session_count),
    locPerDollar: locPerDollarForKind(kind, sessionIds, locCost),
    // The local read is uncapped over this machine's own rows, so nothing here
    // is a sample of a wider population.
    truncated: false,
    // The desktop has NO org baseline to compare a cohort against, so every
    // comparison-based figure is genuinely not computable here — the same
    // canonical empty the desktop detail itself emits, never a fabricated 0.
    ...EMPTY_COHORT_DELIVERY_METRICS,
    ...localVersionSpend(sessionIds, items, locCost),
  };
}

/**
 * The versioned/unversioned partition of the family, as ONE grouped read.
 *
 * `has_version` is the only predicate here, and it is deliberately NOT the
 * version-scope predicate: it asks whether a row names any version at all, not
 * whether it belongs to a given one. Desktop usage rows carry no
 * `definition_version_id` column, so the coarse hash is the whole question.
 */
async function readAttribution(
  prisma: AgentComponentsReadPrisma,
  kind: string,
  usageKeyIn: { clause: string; params: string[] }
): Promise<AgentComponentUsageAttribution> {
  // A plugin has NO direct usage rows on either surface — its headline is a
  // pack-id rollup over child components, which carry no revision of the plugin
  // — so this grouped read finds nothing and `toCount` would turn every absent
  // group into a MEASURED zero, under a headline in the thousands. The cloud
  // refuses the same fold for the same reason; answering it differently here
  // would put two producers of one contract at odds for one input.
  if (kind === AgentComponentKind.Plugin) {
    return {
      unversioned: { invocations: null, sessions: null },
      versioned: { invocations: null, sessions: null },
      truncated: false,
    };
  }
  const rows = await prisma.client.$queryRawUnsafe<PartitionRow[]>(
    `SELECT CASE WHEN component_version_hash IS NULL THEN 0 ELSE 1 END AS has_version,
            COALESCE(SUM(invocations), 0) AS invocations,
            COUNT(DISTINCT session_id) AS session_count
       FROM agent_component_session_usage
      WHERE component_kind = ?
        AND ${usageKeyIn.clause}
      GROUP BY has_version`,
    kind,
    ...usageKeyIn.params
  );
  const slice = (wanted: number) => {
    const row = rows.find((r) => toCount(r.has_version) === wanted);
    return {
      invocations: toCount(row?.invocations),
      sessions: toCount(row?.session_count),
    };
  };
  return {
    unversioned: slice(0),
    versioned: slice(1),
    truncated: false,
  };
}
