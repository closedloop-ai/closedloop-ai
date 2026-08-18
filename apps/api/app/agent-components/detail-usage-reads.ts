import "server-only";

import type { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  type UsageContentScope,
  usageContentScopeWhere,
} from "./content-hash-identity";
import {
  MAX_ORG_ORPHAN_USAGE_ROWS,
  usageWithoutLiveInventoryWhere,
} from "./plugin-child-usage";

// ---------------------------------------------------------------------------
// FEA-4335: the org-scoped detail usage reads that back `buildOrphanOnlyDetail`
// and the inventory-present detail path in `service.ts` — extracted into this
// sibling so the (grandfathered, shrink-only) `service.ts` shrinks as it accretes
// the content-hash-routing fix. These are pure Prisma reads with no service
// coupling; they resolve the orphan (no live inventory row owns it) and
// moved-inventory (live-FK-linked) usage a content-hash detail must fold — a
// partition, so the two never return the same row. See `content-hash-identity.ts`
// for the shared `UsageContentScope`.
// ---------------------------------------------------------------------------

/**
 * One org-scoped detail usage row (orphan or moved-inventory FK-linked), shaped
 * for the detail fold in `getDetailForOrg` / `buildOrphanOnlyDetail`.
 */
export type DetailOrphanUsageRow = {
  agentSessionId: string;
  invocationCount: number;
  /** Harness recorded on the usage row; null when the collector left it unset. */
  harness: string | null;
  // FEA-2990: per-event branch attribution. '' is the "no per-event branch"
  // sentinel — those buckets fall back to session-level SessionBranch. Carried
  // here so the per-(session, branch) fold in `getDetailForOrg` can split orphan
  // usage by branch too, not just the aggregate fold.
  gitBranch: string;
  // FEA-4098 (wongk): the F1 `DefinitionVersion` this usage ran against, so the
  // orphan-only detail can resolve the authors lineage (its list-view row
  // already shows authors via this link) instead of hardcoding an empty set.
  // Null until the F1 backfill lands, or for a hash-less legacy row.
  definitionVersionId: string | null;
  // ISS-5577: the observation window this row itself witnessed, so an untruncated
  // lane can fold the identity's real `firstSeenAt`/`lastSeenAt` without a second
  // query. Both nullable — a collector may leave either unset.
  firstInvokedAt: Date | null;
  lastInvokedAt: Date | null;
};

/**
 * Fetch the org-scoped orphaned usage rows — the ones no LIVE inventory row owns
 * (`usageWithoutLiveInventoryWhere`: a null FK, or a FK to a tombstoned row) —
 * for a single `(kind, key)` identity. Shared by both the inventory-present detail
 * path and the orphan-only synthetic-detail path (#2613): a used-only component
 * has usage rows but no inventory row, so the detail must be built from these.
 * Matched case-insensitively on `componentKey` to mirror the list-view fold via
 * `encodeComponentSlug`.
 */
export function fetchDetailOrphanUsage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string,
  // FEA-4335: every name under which this content is installed. For a content-
  // hash route the same bytes can live under different `componentKey`s, so match
  // orphan usage against ALL of them (mirrors the detail linked read + token
  // trend), not just the primary. Empty for the orphan-only content-hash case
  // (no version row → no name to fall back on): then the name predicate is
  // dropped and `contentScope` alone selects the orphan rows carrying the hash.
  keys: string[] = [],
  // FEA-4335: for a content-hash route, narrow orphan usage to the requested
  // content version (shared `usageContentScopeWhere`); `null` for a legacy
  // name-level key (whole name-level identity, as before).
  contentScope: UsageContentScope | null = null
): Promise<DetailOrphanUsageRow[]> {
  return db.agentComponentSessionUsage.findMany({
    where: detailOrphanUsageWhere(
      organizationId,
      kind,
      key,
      keys,
      contentScope
    ),
    select: {
      agentSessionId: true,
      invocationCount: true,
      harness: true,
      // FEA-2990: per-event branch attribution for precise splitting.
      gitBranch: true,
      // FEA-4098 (wongk): the F1 version link so the orphan-only detail can
      // resolve authors from the lineage (see `buildOrphanOnlyDetail`).
      definitionVersionId: true,
      // ISS-5577: the per-row observation window the untruncated fold reads.
      firstInvokedAt: true,
      lastInvokedAt: true,
    },
    // Make the retained slice deterministic when a busy org exceeds the cap:
    // keep the most recently active sessions (mirrors the inventory read's
    // `lastSeenAt desc` ordering) with `id` as a stable tiebreak, so the detail
    // view's totals, harness derivation, and `usageSessions` don't flicker with
    // whatever unordered subset Postgres would otherwise return. `nulls: "last"`
    // is explicit because `lastInvokedAt` is nullable and Postgres defaults DESC
    // to NULLS FIRST, which would otherwise sort never-invoked rows to the top
    // and invert the cap's "keep the most recently active" intent.
    orderBy: [
      { lastInvokedAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
    // Bound the fan-out to match the other org-scoped orphan/child usage reads
    // (`loadChildUsageByPackId`, `buildPluginChildInvCountBySession`, and the
    // list-view orphan query): a popular orphan skill/command has one usage row
    // per session, so a busy org would otherwise materialize unboundedly with
    // session volume. Downstream branch attribution is already capped by the
    // detail session cap.
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });
}

/**
 * FEA-4335 (wongk): recover FK-LINKED usage for a content-hash route whose
 * current inventory row has moved on. The list synthesizes a hash-A route from
 * FK-linked historical usage (`foldFkUsageIntoMerged`) even when the live
 * inventory has since moved A→B, so an A-fingerprint detail can land in the
 * orphan-only path with NO inventory row for A. `fetchDetailOrphanUsage` reads
 * only rows no live inventory row owns, so that A usage — still attached to the
 * (now-B, still-installed) inventory row via `agentComponentId` but carrying
 * `componentVersionHash == A` — would be missed and the family's own list link
 * would 404.
 *
 * Read the FK-linked rows purely by (org, kind, {@link UsageContentScope}) — NOT
 * by an inventory-id list, since the id moved — and shape them like the orphan
 * rows so `buildOrphanOnlyDetail` folds both. Bounded and content-scoped; returns
 * `[]` when there is no content scope (a legacy name route has no fingerprint to
 * recover a moved row by, and already reads its whole name-level identity).
 */
export function fetchDetailLinkedUsageByContentScope(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  contentScope: UsageContentScope | null
): Promise<DetailOrphanUsageRow[]> {
  if (!contentScope) {
    return Promise.resolve([]);
  }
  return db.agentComponentSessionUsage.findMany({
    where: detailLinkedUsageByContentScopeWhere(
      organizationId,
      kind,
      contentScope
    ),
    select: {
      agentSessionId: true,
      invocationCount: true,
      harness: true,
      gitBranch: true,
      definitionVersionId: true,
      // ISS-5577: the per-row observation window the untruncated fold reads.
      firstInvokedAt: true,
      lastInvokedAt: true,
    },
    orderBy: [
      { lastInvokedAt: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ],
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });
}

/**
 * ISS-5363: the ONE name set every identity-scoped detail usage lane matches on
 * — the orphan lane here and `loadUsageGroupsLinkedElsewhere`'s FK lane.
 *
 * Both lanes ask "which usage rows say they are this family?", so they must ask
 * under the same names or they re-open the list⇄detail divergence from the
 * inside. Prefers the full alias set (every name the content is installed
 * under); falls back to the primary key on a plain name-level route. Empty only
 * for the orphan-only content-hash case, where there is no name at all and the
 * content scope alone selects the rows.
 */
export function detailUsageNameKeys(
  key: string,
  keys: readonly string[]
): string[] {
  if (keys.length > 0) {
    return [...keys];
  }
  return key ? [key] : [];
}

/**
 * The identity predicate for the ORPHAN (`agentComponentId IS NULL`) detail
 * usage lane. Extracted so the row read above and the seen-bounds aggregate
 * below cannot select different populations — a bounds value derived from a
 * narrower or wider predicate than the rows it claims to describe would be a
 * lie about the same identity.
 */
export function detailOrphanUsageWhere(
  organizationId: string,
  kind: string,
  key: string,
  keys: readonly string[],
  contentScope: UsageContentScope | null
): Prisma.AgentComponentSessionUsageWhereInput {
  const nameKeys = detailUsageNameKeys(key, keys);
  // wongk (ISS-5363 review), applied to this lane too: `usageContentScopeWhere`
  // returns its own `OR`, so spreading it beside the name `OR` REPLACED the name
  // predicate on every content-hash route. Combine both under `AND`.
  // Match every name that shares the content; a single-name legacy key resolves
  // to a one-element OR. Omitted entirely for the orphan-only content-hash case
  // (no name), where `contentScope` alone selects the rows.
  // ISS-6180: the same usage-only admission test the LIST's orphan lane applies.
  // Both this lane and the detail's two FK lanes are bounded by LIVE inventory
  // ids, so without it a tombstoned component's usage is in no detail lane at all
  // and the page reports a hard zero against a list row that now shows it.
  const identityWhere: Prisma.AgentComponentSessionUsageWhereInput[] = [
    usageWithoutLiveInventoryWhere(),
  ];
  if (nameKeys.length > 0) {
    identityWhere.push({
      OR: nameKeys.map((k) => ({
        componentKey: { equals: k, mode: "insensitive" as const },
      })),
    });
  }
  const contentWhere = usageContentScopeWhere(contentScope);
  if (contentWhere) {
    identityWhere.push(contentWhere);
  }
  return {
    componentKind: kind,
    AND: identityWhere,
    session: {
      artifact: {
        organizationId,
      },
    },
  };
}

/**
 * The identity predicate for the MOVED-INVENTORY (FK-linked, content-scoped)
 * detail usage lane. Same extraction rationale as
 * {@link detailOrphanUsageWhere}.
 */
export function detailLinkedUsageByContentScopeWhere(
  organizationId: string,
  kind: string,
  contentScope: UsageContentScope
): Prisma.AgentComponentSessionUsageWhereInput {
  return {
    // ISS-6180: a LIVE FK target only. `fetchDetailOrphanUsage` now claims the
    // tombstoned-FK rows, and `buildOrphanOnlyDetail` folds both lanes, so
    // leaving this one at "any non-null FK" would count those rows twice.
    agentComponent: { uninstalledAt: null },
    componentKind: kind,
    // Only rows carrying the requested content version (shared with the linked
    // and orphan reads), regardless of which inventory row now holds the FK.
    ...usageContentScopeWhere(contentScope),
    session: {
      artifact: {
        organizationId,
      },
    },
  };
}

/**
 * The observation window an orphan-only identity actually has evidence for:
 * `firstSeenAt` is the earliest `firstInvokedAt` and `lastSeenAt` the latest
 * `lastInvokedAt` across BOTH detail usage lanes. Either is null when no row in
 * the population recorded that timestamp (nullable columns, skew-safe).
 */
export type DetailUsageSeenBounds = {
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
};

/**
 * ISS-5577: read the real observation window for a used-only (orphan-only)
 * identity from its own usage rows. `buildOrphanOnlyDetail` previously stamped
 * `new Date()` into `firstSeenAt`/`lastSeenAt`, so every orphan-only component
 * claimed it was first seen the instant the request was served — a value the
 * code never computed, rendered as a confident fact. The desktop mirror
 * (`buildUnresolvedOnlyDetail`) already derives `MIN(first_invoked_at)` /
 * `MAX(last_invoked_at)`, so this brings the cloud read to the parity its own
 * comment already claimed.
 *
 * Deliberately an aggregate over the FULL population rather than a fold over
 * the fetched rows: those reads are capped at `MAX_ORG_ORPHAN_USAGE_ROWS` and
 * ordered `lastInvokedAt desc`, so a truncated slice drops precisely the OLDEST
 * rows — a `firstSeenAt` folded from it would be systematically too recent,
 * which is the same fabricated-but-plausible failure in a smaller costume.
 *
 * Never rejects: a failed aggregate resolves to null bounds (an honestly unknown
 * window the caller renders as `""`) after routing the failure to the monitored
 * server path, rather than failing the entire detail response.
 */
export async function fetchDetailUsageSeenBounds(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string,
  keys: readonly string[] = [],
  contentScope: UsageContentScope | null = null
): Promise<DetailUsageSeenBounds> {
  const lanes: Prisma.AgentComponentSessionUsageWhereInput[] = [
    detailOrphanUsageWhere(organizationId, kind, key, keys, contentScope),
  ];
  // Mirrors `fetchDetailLinkedUsageByContentScope`'s fail-closed guard: a legacy
  // name route has no fingerprint to recover a moved row by, so it must never
  // widen these bounds to the org-wide linked-usage population.
  if (contentScope) {
    lanes.push(
      detailLinkedUsageByContentScopeWhere(organizationId, kind, contentScope)
    );
  }
  // wongk (ISS-5577 review): `AgentComponentSessionUsage.firstInvokedAt` carries
  // no index, so this aggregate is the one statement here that can realistically
  // time out on a pathological org. Letting it reject turned a window the
  // response can honestly report as UNKNOWN into a 500 for the whole detail, so
  // it is contained at this boundary. Null bounds — never a fold over the
  // truncated slice, whose `_min` is systematically too recent and would answer
  // the question wrongly rather than declining to answer it.
  try {
    const bounds = await db.agentComponentSessionUsage.aggregate({
      where: { OR: lanes },
      _min: { firstInvokedAt: true },
      _max: { lastInvokedAt: true },
    });
    return {
      firstSeenAt: bounds._min.firstInvokedAt ?? null,
      lastSeenAt: bounds._max.lastInvokedAt ?? null,
    };
  } catch (error) {
    // Server-side, so the monitored path IS a structured error-level log — the
    // same alerting lane `warnOnRowCeiling` uses for the adjacent
    // pathological-population signal in `org-population-reads.ts`.
    log.error("agent_components_detail_seen_bounds_aggregate_failed", {
      contentScoped: contentScope != null,
      error: error instanceof Error ? error.message : String(error),
      kind,
      laneCount: lanes.length,
      organizationId,
    });
    return { firstSeenAt: null, lastSeenAt: null };
  }
}

/**
 * ISS-5577: both detail usage lanes plus whether either was BOUND BY ITS OWN
 * `take`. Truncation is reported here, by the module that issues the queries,
 * rather than re-derived by a caller comparing a result length against an
 * imported cap — the ISS-4797/4799 lesson recorded in
 * `service/detail-version-history.ts`, and the convention
 * `sessionsTabTruncated` / `emitVersionsTruncated` already follow. Keeping the
 * test beside the `take` it is paired with is what makes it sound: each lane is
 * a plain bounded `findMany` with no dedupe, GROUP BY, or UNION between the
 * `take` and the returned rows, so `length === take` exactly means "the bound
 * bit". A false positive (a lane that happens to hold exactly the cap) only
 * routes to the uncapped aggregate, which is exact — it costs a query, never
 * accuracy.
 */
export type DetailOrphanUsageLanes = {
  rows: DetailOrphanUsageRow[];
  truncated: boolean;
};

/**
 * Read both lanes for an orphan-only identity as one bounded unit.
 *
 * FEA-4335 (wongk): fold BOTH the orphan lane (usage no LIVE inventory row owns)
 * AND FK-linked usage that carries the requested content version but whose
 * inventory row has since moved (A→B). Orphan rows alone would 404 a family that
 * links to hash A from the FK-linked usage the list routed it from.
 */
export async function fetchDetailOrphanUsageLanes(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string,
  keys: string[] = [],
  contentScope: UsageContentScope | null = null
): Promise<DetailOrphanUsageLanes> {
  const [orphanLaneUsages, linkedByHashUsages] = await Promise.all([
    fetchDetailOrphanUsage(db, organizationId, kind, key, keys, contentScope),
    fetchDetailLinkedUsageByContentScope(
      db,
      organizationId,
      kind,
      contentScope
    ),
  ]);
  return {
    rows: [...orphanLaneUsages, ...linkedByHashUsages],
    truncated:
      orphanLaneUsages.length >= MAX_ORG_ORPHAN_USAGE_ROWS ||
      linkedByHashUsages.length >= MAX_ORG_ORPHAN_USAGE_ROWS,
  };
}

/**
 * ISS-5577: the same observation window, folded from rows already in hand. Valid
 * ONLY when {@link fetchDetailOrphanUsageLanes} reported `truncated: false` —
 * the lane reads are ordered `lastInvokedAt desc`, so a capped slice drops the
 * oldest rows and its `_min` would be systematically too recent. This is the
 * untruncated fast path that keeps {@link fetchDetailUsageSeenBounds} off every
 * ordinary request.
 *
 * Skips nulls the way Postgres `min()`/`max()` do, so a null survives only when
 * every row left that column unset.
 */
export function foldUsageSeenBounds(
  rows: readonly DetailOrphanUsageRow[]
): DetailUsageSeenBounds {
  let firstSeenAt: Date | null = null;
  let lastSeenAt: Date | null = null;
  for (const row of rows) {
    if (
      row.firstInvokedAt &&
      (!firstSeenAt || row.firstInvokedAt < firstSeenAt)
    ) {
      firstSeenAt = row.firstInvokedAt;
    }
    if (row.lastInvokedAt && (!lastSeenAt || row.lastInvokedAt > lastSeenAt)) {
      lastSeenAt = row.lastInvokedAt;
    }
  }
  return { firstSeenAt, lastSeenAt };
}
