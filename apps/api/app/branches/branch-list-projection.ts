import type {
  BranchListResponse,
  BranchRow,
  BranchTagPermissions,
} from "@repo/api/src/types/branch";
import { BranchProjectionVersion } from "@repo/api/src/types/branch-projection";
import {
  collectDistinctSessionIds,
  evenSplitBranchCostByBranch,
} from "./branch-cost-attribution";
import {
  type BranchListEnrichmentDomain,
  BranchListEnrichmentRead,
  createBranchListEnrichmentDomain,
  runBranchListEnrichmentRead,
} from "./branch-list-enrichment";
import type { BranchListOperationQuery } from "./branch-list-query";
import { loadGlobalDivisorCandidates } from "./branch-read-service/canonical-metric-populations";
import { projectCanonicalCloudBranchRow } from "./branch-read-service/canonical-projection";
import {
  type BranchListIdentityData,
  resolveBranchListIdentityData,
} from "./branch-read-service/identity-attribution";
import type { BranchArtifactRow } from "./branch-read-service/persisted-row-read";
import {
  distinctSessionCostMap,
  type SessionUsage,
  sessionUsageDateWindow,
} from "./branch-read-service/session-usage-window";
import {
  getSessionBranchCounts,
  warnOnDivisorBelowInSetCount,
} from "./session-branch-divisor";

type BranchListProjectionClient = Parameters<
  typeof resolveBranchListIdentityData
>[0] &
  Parameters<typeof getSessionBranchCounts>[0];

export type ProjectedBranchList = {
  items: BranchRow[];
  sessionCostUsd?: BranchListResponse["sessionCostUsd"];
  lifetimeSessionCostUsd?: BranchListResponse["lifetimeSessionCostUsd"];
  sessionBranchCount?: BranchListResponse["sessionBranchCount"];
  usageByBranch: {
    windowed: Map<string, SessionUsage>;
    lifetime: Map<string, SessionUsage>;
  };
};

type BranchListSessionMetadata = Pick<
  ProjectedBranchList,
  "lifetimeSessionCostUsd" | "sessionBranchCount" | "sessionCostUsd"
>;

type ProjectBranchListRowsOptions = {
  includeAttributedCost?: boolean;
  /** Successful lifetime evidence from the canonical superset in this org/snapshot. */
  preloadedIdentityData?: BranchListIdentityData;
  /** Unavailable reads are never offered for reuse. */
  onIdentityData?: (data: BranchListIdentityData) => void;
  /**
   * The caller's failure domain for the optional reads. Defaulted so a caller
   * outside the `/branches` list read (the analytics cohort, the perf fixture)
   * still gets the best-effort behavior on its own fresh domain.
   */
  enrichment?: BranchListEnrichmentDomain;
};

/** Project canonical wire rows and page-scoped Session metadata in one pass. */
export async function projectBranchListRows(
  db: BranchListProjectionClient,
  organizationId: string,
  rows: readonly BranchArtifactRow[],
  query: Pick<
    BranchListOperationQuery,
    "endDate" | "evaluationNow" | "startDate"
  >,
  tagPermissions?: BranchTagPermissions,
  options: ProjectBranchListRowsOptions = {}
): Promise<ProjectedBranchList> {
  const enrichment = options.enrichment ?? createBranchListEnrichmentDomain();
  const identityData = await resolveBranchListIdentityDataBestEffort(
    db,
    organizationId,
    rows,
    sessionUsageDateWindow(query),
    enrichment,
    options.preloadedIdentityData
  );
  if (!enrichment.unavailable.has(BranchListEnrichmentRead.Identity)) {
    options.onIdentityData?.(identityData);
  }
  const { windowed, lifetime, identityByBranch } = identityData;
  const windowedCost = optionalRecord(distinctSessionCostMap(windowed));
  const lifetimeCost = optionalRecord(distinctSessionCostMap(lifetime));
  const sessionIds = collectDistinctSessionIds(lifetime);
  const branchCounts =
    sessionIds.length > 0 && options.includeAttributedCost !== false
      ? await getSessionBranchCountsBestEffort(
          db,
          organizationId,
          sessionIds,
          enrichment
        )
      : new Map<string, number>();
  warnOnDivisorBelowInSetCount(branchCounts, windowed, { organizationId });
  const evenSplitCost = evenSplitBranchCostByBranch(windowed, branchCounts);
  return {
    items: rows.map((row) =>
      projectCanonicalCloudBranchRow(
        row,
        organizationId,
        tagPermissions,
        windowed.get(row.id),
        identityByBranch.get(row.id),
        // `includeAttributedCost: false` means the server-page caller resolves
        // the share LATER, against the visible page only
        // (`attachBranchListPageCostMetadata`). Not-yet-computed is not the
        // same claim as "no attributable cost", so leave the field absent here
        // rather than stamping a `null` the page step would have no reason to
        // overwrite.
        options.includeAttributedCost === false
          ? undefined
          : attributedCostForRow(evenSplitCost, row.id, enrichment)
      )
    ),
    ...(windowedCost ? { sessionCostUsd: windowedCost } : {}),
    ...(lifetimeCost ? { lifetimeSessionCostUsd: lifetimeCost } : {}),
    ...(branchCounts.size > 0
      ? { sessionBranchCount: Object.fromEntries(branchCounts) }
      : {}),
    usageByBranch: { windowed, lifetime },
  };
}

/** Restrict Session maps to identities referenced by the returned page. */
export function sliceBranchListMetadata(
  projected: ProjectedBranchList,
  items: readonly BranchRow[]
): BranchListSessionMetadata {
  const sessionIds = new Set(items.flatMap((item) => item.sessionIds));
  return {
    ...optionalProjectedRecord("sessionCostUsd", projected, sessionIds),
    ...optionalProjectedRecord("lifetimeSessionCostUsd", projected, sessionIds),
    ...optionalProjectedRecord("sessionBranchCount", projected, sessionIds),
  };
}

function optionalRecord(
  values: Readonly<Record<string, number>>
): Readonly<Record<string, number>> | undefined {
  return Object.keys(values).length > 0 ? values : undefined;
}

function optionalProjectedRecord<
  Key extends
    | "sessionCostUsd"
    | "lifetimeSessionCostUsd"
    | "sessionBranchCount",
>(
  key: Key,
  projected: ProjectedBranchList,
  sessionIds: ReadonlySet<string>
): Pick<ProjectedBranchList, Key> | Record<never, never> {
  const source = projected[key];
  if (!source) {
    return {};
  }
  const selected = Object.fromEntries(
    [...sessionIds].flatMap((sessionId) => {
      const value = source[sessionId];
      return value === undefined ? [] : [[sessionId, value] as const];
    })
  );
  return Object.keys(selected).length > 0
    ? ({ [key]: selected } as Pick<ProjectedBranchList, Key>)
    : {};
}

/** Attach global even-split cost metadata only for the visible response page. */
export async function attachBranchListPageCostMetadata(
  db: BranchListProjectionClient,
  organizationId: string,
  projected: ProjectedBranchList,
  items: readonly BranchRow[],
  enrichment: BranchListEnrichmentDomain = createBranchListEnrichmentDomain()
): Promise<{
  items: BranchRow[];
  sessionBranchCount?: BranchListResponse["sessionBranchCount"];
}> {
  const pageBranchIds = new Set(items.map((item) => item.id));
  const pageWindowed = filterUsageByBranch(
    projected.usageByBranch.windowed,
    pageBranchIds
  );
  const pageLifetime = filterUsageByBranch(
    projected.usageByBranch.lifetime,
    pageBranchIds
  );
  const sessionIds = collectDistinctSessionIds(pageLifetime);
  const branchCounts =
    sessionIds.length > 0
      ? await getSessionBranchCountsBestEffort(
          db,
          organizationId,
          sessionIds,
          enrichment
        )
      : new Map<string, number>();
  warnOnDivisorBelowInSetCount(branchCounts, pageWindowed, { organizationId });
  const evenSplitCostByBranch = evenSplitBranchCostByBranch(
    pageWindowed,
    branchCounts
  );
  return {
    items: items.map((item) =>
      attachAttributedCost(
        item,
        attributedCostForRow(evenSplitCostByBranch, item.id, enrichment)
      )
    ),
    ...(branchCounts.size > 0
      ? { sessionBranchCount: Object.fromEntries(branchCounts) }
      : {}),
  };
}

function filterUsageByBranch(
  usageByBranch: ReadonlyMap<string, SessionUsage>,
  branchIds: ReadonlySet<string>
): Map<string, SessionUsage> {
  const filtered = new Map<string, SessionUsage>();
  for (const branchId of branchIds) {
    const usage = usageByBranch.get(branchId);
    if (usage) {
      filtered.set(branchId, usage);
    }
  }
  return filtered;
}

function attachAttributedCost(
  item: BranchRow,
  attributedCostUsd: number | null | undefined
): BranchRow {
  if (attributedCostUsd === undefined) {
    return item;
  }
  const projection =
    item.canonicalProjection?.version === BranchProjectionVersion.V1
      ? {
          ...item.canonicalProjection,
          list: {
            ...item.canonicalProjection.list,
            cost: {
              ...item.canonicalProjection.list.cost,
              attributedUsd: attributedCostUsd,
            },
          },
        }
      : item.canonicalProjection;
  return {
    ...item,
    attributedCostUsd,
    ...(projection ? { canonicalProjection: projection } : {}),
  };
}

/**
 * ISS-10297 (incident ISS-10295) — the Session-link scan behind windowed and
 * lifetime usage is OPTIONAL analytics on a REQUIRED path. When it fails,
 * return the branch rows with the analytics fields simply absent:
 * `projectCanonicalCloudBranchRow` already defaults usage to `emptyUsage()` and
 * identity to `undefined`. Matches the desktop page-data producer
 * (`apps/desktop/src/main/branch/shared-branches-api.ts`) and the directory
 * contract: never let a Value-per-$ column reject the branch list.
 *
 * The empty maps are UNKNOWN, not "no sessions" — `branch-list-enrichment.ts`
 * records the read on the domain's `unavailable` set so a caller cannot
 * mistake them for a measured empty result.
 */
export function resolveBranchListIdentityDataBestEffort(
  db: Parameters<typeof resolveBranchListIdentityData>[0],
  organizationId: string,
  rows: Parameters<typeof resolveBranchListIdentityData>[2],
  dateWindow: Parameters<typeof resolveBranchListIdentityData>[3],
  enrichment: BranchListEnrichmentDomain,
  preloaded?: BranchListIdentityData
): Promise<Awaited<ReturnType<typeof resolveBranchListIdentityData>>> {
  return runBranchListEnrichmentRead({
    read: BranchListEnrichmentRead.Identity,
    domain: enrichment,
    context: { organizationId, rowCount: rows.length },
    load: () =>
      resolveBranchListIdentityData(
        db,
        organizationId,
        rows,
        dateWindow,
        preloaded
      ),
    unavailable: () => ({
      windowed: new Map(),
      lifetime: new Map(),
      identityByBranch: new Map(),
    }),
  });
}

/**
 * The even-split DIVISOR read, in the same best-effort domain. An empty map
 * makes `evenSplitBranchCostByBranch` yield no share — see
 * {@link attributedCostForRow} for why that is published as an ABSENT field
 * rather than a `null` or a fabricated `$0`.
 */
function getSessionBranchCountsBestEffort(
  db: BranchListProjectionClient,
  organizationId: string,
  sessionIds: string[],
  enrichment: BranchListEnrichmentDomain,
  eligibleBranchIds?: readonly string[]
): Promise<Map<string, number>> {
  return runBranchListEnrichmentRead({
    read: BranchListEnrichmentRead.SessionBranchDivisor,
    domain: enrichment,
    context: { organizationId, sessionCount: sessionIds.length },
    load: () =>
      getSessionBranchCounts(db, organizationId, sessionIds, eligibleBranchIds),
    unavailable: () => new Map(),
  });
}

/**
 * The legacy (non-`pageMode=server`) arm's divisor PAIR, in the shared
 * best-effort domain (#7312 review, whitlockk: "cover the no-pageMode path too").
 *
 * Both reads are optional analytics — the bounded authority snapshot and the
 * divisor built from it — and either one rejecting used to take the whole list
 * with it. That arm is live exposure, not dead surface: `pageData` calls the
 * complete-list adapter directly, and `getBranchListWithServerFallback` falls
 * back to it precisely WHEN a server-page query is rejected.
 */
export async function resolveGlobalSessionBranchCountsBestEffort(params: {
  db: BranchListProjectionClient &
    Parameters<typeof loadGlobalDivisorCandidates>[0];
  organizationId: string;
  sessionIds: string[];
  globalQuery: Parameters<typeof loadGlobalDivisorCandidates>[2];
  memo: Parameters<typeof loadGlobalDivisorCandidates>[3];
  enrichment: BranchListEnrichmentDomain;
}): Promise<Map<string, number>> {
  if (params.sessionIds.length === 0) {
    return new Map();
  }
  const candidates = await runBranchListEnrichmentRead({
    read: BranchListEnrichmentRead.GlobalDivisorCandidates,
    domain: params.enrichment,
    context: {
      organizationId: params.organizationId,
      sessionCount: params.sessionIds.length,
    },
    load: () =>
      loadGlobalDivisorCandidates(
        params.db,
        params.organizationId,
        params.globalQuery,
        params.memo
      ),
    unavailable: () => null,
  });
  if (!candidates?.coverageComplete) {
    return new Map();
  }
  return getSessionBranchCountsBestEffort(
    params.db,
    params.organizationId,
    params.sessionIds,
    params.enrichment,
    candidates.ids
  );
}

/**
 * `null` on `attributedCostUsd` is a MEASURED answer — "this branch has no
 * attributable cost" — while the wire field is optional, so ABSENCE is how an
 * unavailable read is spelled (#7312 review: davetho and whitlockk;
 * `packages/app/branches/data-source/branch-server-page-response.ts:43`).
 *
 * Reusing `null` for both collapses the distinction, and every detail consumer
 * that reads `null` as unavailable (`packages/app/branches/lib/
 * branch-session-cost.ts:87`) would report a branch whose cost merely failed to
 * load as one that genuinely has none.
 *
 * ANY unavailable read poisons the share, not just the divisor: with no usage
 * there is no numerator either, so an empty `evenSplitCost` says nothing about
 * what the branch actually cost.
 */
export function attributedCostForRow(
  evenSplitCost: ReadonlyMap<string, number | null>,
  branchId: string,
  enrichment: BranchListEnrichmentDomain
): number | null | undefined {
  if (enrichment.unavailable.size > 0) {
    return undefined;
  }
  return evenSplitCost.get(branchId) ?? null;
}
