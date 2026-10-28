import "server-only";

import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import type { Prisma, withDb } from "@repo/database";
import {
  type UsageContentScope,
  usageContentScopeWhere,
} from "./content-hash-identity";
import {
  DetailUsageAggregateFailedEvent,
  reportDetailUsageAggregateFailure,
} from "./detail-usage-failure-telemetry";
import {
  MAX_ORG_ORPHAN_USAGE_ROWS,
  usageWithoutLiveInventoryWhere,
} from "./plugin-child-usage";

// ---------------------------------------------------------------------------
// FEA-4335: the org-scoped detail usage reads that back `buildOrphanOnlyDetail`
// and the inventory-present detail path in `service.ts` — extracted into this
// sibling so `service.ts` shrinks as it accretes
// the content-hash-routing fix. These are pure Prisma reads with no service
// coupling; they resolve the two populations a used-only detail must fold — the
// usage no live inventory row owns, and the moved-inventory usage a live one
// still owns — as a partition, so the two never return the same row. See
// `content-hash-identity.ts` for the shared `UsageContentScope`.
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
  // FEA-4098 (whitlockk): the F1 `DefinitionVersion` this usage ran against, so the
  // orphan-only detail can resolve the authors lineage (its list-view row
  // already shows authors via this link) instead of hardcoding an empty set.
  // Null until the F1 backfill lands, or for a hash-less legacy row.
  definitionVersionId: string | null;
  // ISS-10467: the coarse hash-at-invocation. ADDITIVE, and read for exactly one
  // question the per-version drill-down has to answer — does this row name ANY
  // version — so the family usage that belongs to no revision can be counted and
  // disclosed instead of silently dropped. It is NOT a version-scope predicate:
  // narrowing to a version is `usageContentScopeWhere` and only ever that.
  componentVersionHash: string | null;
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
      // FEA-4098 (whitlockk): the F1 version link so the orphan-only detail can
      // resolve authors from the lineage (see `buildOrphanOnlyDetail`).
      definitionVersionId: true,
      // ISS-10467: the coarse hash-at-invocation, for the drill-down's
      // "does this row name any version at all" partition.
      componentVersionHash: true,
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
    // (`loadChildUsageByPackId`, `loadDetailChildUsageRows`, and the
    // list-view orphan query): a popular orphan skill/command has one usage row
    // per session, so a busy org would otherwise materialize unboundedly with
    // session volume. Downstream branch attribution is already capped by the
    // detail session cap.
    take: MAX_ORG_ORPHAN_USAGE_ROWS,
  });
}

/**
 * FEA-4335 (whitlockk): recover FK-LINKED usage a used-only detail must still fold.
 * The list synthesizes a hash-A route from FK-linked historical usage
 * (`foldFkUsageIntoMerged`) even when the live inventory has since moved A→B, so
 * an A-fingerprint detail can land in the used-only path with NO inventory row
 * for A. `fetchDetailOrphanUsage` reads only rows no live inventory row owns, so
 * that usage — still attached to the (now-B, still-installed) inventory row via
 * `agentComponentId` — would be missed and the family's own list link would 404.
 *
 * Read those rows purely by (org, kind, identity) — NOT by an inventory-id list,
 * since the id moved — and shape them like the orphan rows so
 * `buildOrphanOnlyDetail` folds both.
 *
 * ISS-10469: the identity is {@link usedOnlyUsageIdentityWhere}'s, the SAME one
 * the no-live-owner arm carries, so this arm widened from one content version to
 * the whole family without ever admitting a row that arm also admits. A null
 * identity keeps this arm out of the read entirely: with no identity of its own
 * it would be the org-wide live-FK population for the kind, and a predicate whose
 * job is to narrow fails closed.
 */
export function fetchDetailLiveInventoryUsage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  identityWhere: Prisma.AgentComponentSessionUsageWhereInput | null
): Promise<DetailOrphanUsageRow[]> {
  if (!identityWhere) {
    return Promise.resolve([]);
  }
  return db.agentComponentSessionUsage.findMany({
    where: detailLiveInventoryUsageWhere(organizationId, kind, identityWhere),
    select: {
      agentSessionId: true,
      invocationCount: true,
      harness: true,
      gitBranch: true,
      definitionVersionId: true,
      // ISS-10467: the coarse hash-at-invocation, for the drill-down's
      // "does this row name any version at all" partition.
      componentVersionHash: true,
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
  // ISS-6756: names that FOLD to nothing are dropped, not just the empty string
  // and not just the empty list. `resolveContentHashIdentity` builds `keys` with
  // `(componentKey ?? "").toLowerCase().trim()`, so a version row carrying no
  // key at all contributes `""` to an otherwise-populated alias set — and `""`
  // in the folded `IN` matches every row still on the column's
  // `ADD COLUMN … DEFAULT ''` value. A `length > 0` gate at the caller cannot
  // see that; dropping them here is what makes the gate mean what it says.
  const named = keys.length > 0 ? [...keys] : [key];
  return named.filter((name) => normalizeComponentKey(name).length > 0);
}

/**
 * ISS-6756: the folded, de-duplicated identity set — every name that folds to
 * something, exactly once. The ONE place the drop-empties rule lives, so the
 * detail lanes, the token trend and the search readmission arm cannot each
 * decide it differently.
 */
export function foldedIdentityKeys(names: readonly string[]): string[] {
  return [
    ...new Set(
      names
        .map((name) => normalizeComponentKey(name))
        .filter((folded) => folded.length > 0)
    ),
  ];
}

/**
 * ISS-6756: the indexable spelling of "this usage row says it is one of these
 * names", shared by every identity-scoped usage lane so they cannot drift apart.
 *
 * The lanes used to ask for `componentKey: { equals: k, mode: "insensitive" }`,
 * which Prisma compiles to `component_key ILIKE $n`. No btree can serve an
 * `ILIKE` — not even a `LOWER(component_key)` expression index, which is exactly
 * the distinction migration 20260815120000 (ISS-6452) turns on, where the
 * predicates were raw `LOWER(col) IN (…)`. These lanes bind neither
 * `agentComponentId` nor `agentSessionId` first, and the table carries no
 * `organization_id` column (org arrives through the `session.artifact` join), so
 * the ILIKE left them scanning the same-kind partition of EVERY tenant and
 * discarding the rest with a post-scan filter.
 *
 * `componentKeyNormalized` is the persisted fold the table's BEFORE
 * INSERT/UPDATE trigger maintains (migration 20260820120000), so an `IN` over
 * the folded names is an equality the
 * `(component_kind, component_key_normalized)` index serves. Both sides go
 * through the SAME cross-surface codec — `normalizeComponentKey`, which the
 * trigger mirrors.
 *
 * THE ROW SET MOVES, IN BOTH DIRECTIONS. This is not a pure re-spelling, and the
 * two deltas point opposite ways:
 *
 *   • WIDER: the fold trims and `ILIKE` did not, so a stored key with
 *     surrounding whitespace matched nothing before and matches its trimmed
 *     identity now. That is the desktop's long-standing behaviour
 *     (`shared-agent-components-api.ts` folds stored keys through this same
 *     function), so this brings the cloud to parity.
 *   • NARROWER: Prisma binds the key as the ILIKE PATTERN, unescaped (verified
 *     against the engine: `component_key ILIKE $1`, `$1 = 'mcp__x__y'`), so `_`
 *     and `%` in a key were WILDCARDS. Component keys carry `_` constantly —
 *     `mcp__closedloop__ping`, `web_search` — so `mcp__closedloop__ping` also
 *     matched `mcpXXclosedloopYYping`, i.e. a DIFFERENT component's rows. An
 *     equality does not. Counts for keys containing `_` or `%` can therefore
 *     DROP, and that is the repair: the list has always grouped these
 *     identities exactly, so the over-match was detail/trend inflating against
 *     it.
 *
 * PRECONDITION: `nameKeys` must contain at least one name that FOLDS to
 * something. An empty fold set emits `{ in: [] }`, which selects NOTHING rather
 * than "no identity filter", so every caller gates on `detailUsageNameKeys`
 * being non-empty first. Names that fold away are dropped rather than passed
 * through: `{ in: [""] }` would match every row still carrying the column's
 * `ADD COLUMN … DEFAULT ''` value — the widest possible predicate wearing the
 * shape of the narrowest — and failing CLOSED (selecting nothing) is the safe
 * direction for a predicate whose job is to narrow.
 *
 * NOT every predicate on this table folds this way. `usageSearchWhere`'s facet
 * (`org-population-reads.ts`) stays on the raw column: its main arm is a
 * substring `contains`, a different question from identity, and its
 * name-matched arm is re-checked in JS by `filterUsageGroupsToDetailIdentity`.
 * That lane therefore still trims differently from this one — a known residual,
 * not an oversight.
 */
export function usageNameIdentityWhere(
  nameKeys: readonly string[]
): Prisma.AgentComponentSessionUsageWhereInput {
  return { componentKeyNormalized: { in: foldedIdentityKeys(nameKeys) } };
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
  // whitlockk (ISS-5363 review), applied to this lane too: `usageContentScopeWhere`
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
    identityWhere.push(usageNameIdentityWhere(nameKeys));
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
 * The identity predicate for the LIVE-INVENTORY (FK-linked) used-only usage lane.
 * Same extraction rationale as {@link detailOrphanUsageWhere}.
 *
 * `agentComponent: { uninstalledAt: null }` is this arm's HALF of the partition
 * (ISS-6180) — see {@link usedOnlyUsageIdentityWhere} for the whole invariant.
 * `identityWhere` is nested under `AND` rather than spread: it can itself be an
 * `OR` (the content-scope shape), and spreading one beside a sibling `OR` silently
 * replaces it — the ISS-5363 collision `detailOrphanUsageWhere` already carries a
 * note about.
 */
export function detailLiveInventoryUsageWhere(
  organizationId: string,
  kind: string,
  identityWhere: Prisma.AgentComponentSessionUsageWhereInput
): Prisma.AgentComponentSessionUsageWhereInput {
  return {
    agentComponent: { uninstalledAt: null },
    componentKind: kind,
    AND: [identityWhere],
    session: {
      artifact: {
        organizationId,
      },
    },
  };
}

/**
 * ISS-10469: the ONE identity BOTH used-only detail usage lanes carry, and the
 * one place that decides it.
 *
 * "Was this route addressed by a content hash" and "narrow this population by
 * content version" are different questions. Conflating them is what left the
 * used-only detail version-scoped after ISS-10341 made every other aggregate on
 * the page family-scoped: a fingerprint that resolved version rows resolved their
 * NAMES with them, and those names ARE the family, so there the fingerprint is
 * only the address. It is the identity solely when it resolved no name at all —
 * the orphan-only content-hash route, where there is no family to be narrower
 * than.
 *
 * DISJOINTNESS INVARIANT — the contract every caller must honor (ISS-6180). The
 * two used-only lanes carry THIS SAME predicate and differ on exactly one term:
 * `usageWithoutLiveInventoryWhere()` versus `agentComponent: { uninstalledAt:
 * null }`. Those are exact complements over a usage row — it either has a live
 * inventory owner or it does not, decided in SQL by the FK and its target's
 * tombstone, never in JS — so no row satisfies both arms and their union can
 * never double-count. Before ISS-10469 the arms carried DIFFERENT identities
 * (names-and-content versus content-alone), and the complement was the only thing
 * holding them apart; giving the FK-linked arm an identity of its own is what
 * lets it widen to the whole family without ever overlapping the other.
 */
export function usedOnlyUsageIdentityWhere(
  key: string,
  keys: readonly string[],
  contentScope: UsageContentScope | null
): UsedOnlyUsageIdentity {
  const nameKeys = detailUsageNameKeys(key, keys);
  if (nameKeys.length > 0) {
    return {
      where: usageNameIdentityWhere(nameKeys),
      orphanContentScope: null,
    };
  }
  return {
    where: usageContentScopeWhere(contentScope) ?? null,
    orphanContentScope: contentScope,
  };
}

/** The resolved used-only identity — see {@link usedOnlyUsageIdentityWhere}. */
export type UsedOnlyUsageIdentity = {
  /**
   * The predicate both arms carry, or null when the route resolved neither a
   * name nor a fingerprint. Null keeps the FK-linked arm out of the read.
   */
  where: Prisma.AgentComponentSessionUsageWhereInput | null;
  /**
   * What the no-live-owner arm passes {@link detailOrphanUsageWhere} as its
   * content narrow — null whenever a name resolved, so the arms cannot end up
   * asking different questions.
   */
  orphanContentScope: UsageContentScope | null;
};

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
  const lanes = detailUsageLaneWheres(
    organizationId,
    kind,
    key,
    keys,
    contentScope
  );
  // whitlockk (ISS-5577 review): `AgentComponentSessionUsage.firstInvokedAt` carries
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
    // same alerting lane `warnOnOversizePopulation` uses for the adjacent
    // pathological-population signal in `org-population-reads.ts` — bound per
    // org because any org member can refresh into this failure.
    reportDetailUsageAggregateFailure(
      DetailUsageAggregateFailedEvent.SeenBounds,
      organizationId,
      {
        // ISS-10469: what the lanes ACTUALLY narrowed by, not what the caller
        // passed — a fingerprint route that resolved names drops the content
        // narrow, and an on-call reader needs to know which shape timed out.
        contentScoped:
          usedOnlyUsageIdentityWhere(key, keys, contentScope)
            .orphanContentScope != null,
        error: error instanceof Error ? error.message : String(error),
        kind,
        laneCount: lanes.length,
      }
    );
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
 * FEA-4335 (whitlockk): fold BOTH the orphan lane (usage no LIVE inventory row owns)
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
  const identity = usedOnlyUsageIdentityWhere(key, keys, contentScope);
  const [orphanLane, liveInventoryUsages] = await Promise.all([
    fetchDetailOrphanUsageLane(
      db,
      organizationId,
      kind,
      key,
      keys,
      identity.orphanContentScope
    ),
    fetchDetailLiveInventoryUsage(db, organizationId, kind, identity.where),
  ]);
  return {
    rows: [...orphanLane.rows, ...liveInventoryUsages],
    truncated:
      orphanLane.truncated ||
      liveInventoryUsages.length >= MAX_ORG_ORPHAN_USAGE_ROWS,
  };
}

/**
 * ISS-9852: the ORPHAN lane alone, with its own `take` bound reported — the
 * inventory-present detail reads only this lane (its FK-linked usage arrives
 * through the inventory-id lanes), so it needs the truncation signal without
 * the content-scope lane {@link fetchDetailOrphanUsageLanes} adds.
 */
export async function fetchDetailOrphanUsageLane(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  kind: string,
  key: string,
  keys: string[] = [],
  contentScope: UsageContentScope | null = null
): Promise<DetailOrphanUsageLanes> {
  const rows = await fetchDetailOrphanUsage(
    db,
    organizationId,
    kind,
    key,
    keys,
    contentScope
  );
  return { rows, truncated: rows.length >= MAX_ORG_ORPHAN_USAGE_ROWS };
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

/**
 * ISS-9852: the predicates of BOTH orphan-only detail usage lanes, in the order
 * the row reads issue them. The seen-bounds aggregate and the totals aggregate
 * (`detail-usage-totals.ts`) both read over `{ OR: lanes }`, so this is the one
 * place that decides which populations a rowless read over "this identity"
 * covers. The FK-linked lane is included only when
 * {@link usedOnlyUsageIdentityWhere} resolved an identity, mirroring
 * `fetchDetailLiveInventoryUsage`'s fail-closed guard: an arm carrying no
 * identity of its own would be the org-wide live-FK population for the kind.
 *
 * ISS-10469: the two lanes here are the same partition the row reads issue, so
 * a rowless aggregate over `{ OR: lanes }` sums each row exactly once — the
 * arms' identity predicates are identical and only their FK-liveness terms
 * differ, which are complements.
 */
export function detailUsageLaneWheres(
  organizationId: string,
  kind: string,
  key: string,
  keys: readonly string[],
  contentScope: UsageContentScope | null
): Prisma.AgentComponentSessionUsageWhereInput[] {
  const identity = usedOnlyUsageIdentityWhere(key, keys, contentScope);
  const lanes: Prisma.AgentComponentSessionUsageWhereInput[] = [
    detailOrphanUsageWhere(
      organizationId,
      kind,
      key,
      keys,
      identity.orphanContentScope
    ),
  ];
  if (identity.where) {
    lanes.push(
      detailLiveInventoryUsageWhere(organizationId, kind, identity.where)
    );
  }
  return lanes;
}
