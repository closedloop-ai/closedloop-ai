import "server-only";

import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
import type { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { resolveDefinitionHashes } from "./definition-hash-resolution";
import type { OrphanUsageRow } from "./identity";
import {
  type UsageWindow,
  usageWindowWhere,
  usageWithoutLiveInventoryWhere,
} from "./plugin-child-usage";
import type { AgentComponentListQuery } from "./validators";

// ---------------------------------------------------------------------------
// ISS-4797 / ISS-4799: the two FACET-SCOPED reads that feed the org component
// population — the inventory scan and the ORPHAN (null-FK) usage scan.
//
// Both used to be `findMany`s with a hard row `take` applied AFTER the request's
// `?kinds=` / `?search=` predicate. That ordering makes a STRICTER filter return
// MORE data: the unfiltered read spends its row budget across every kind and
// drops its older tail, while a `?kinds=subagent` read starts from a far smaller
// set and never truncates at all. The reported symptoms were exactly that —
// per-kind totals summing to 2,174 against an All total of 2,138 (51 subagent
// slugs visible only in the filtered view, all older than All's truncation
// floor), and one `tool` component reporting 1 invocation in the All list, 15 in
// the kind-filtered list, and 61 on its (identity-scoped, untruncated) detail
// page. A count derived from a facet-truncated population is not a count.
//
// The repair is to move the cap OFF raw rows and ONTO distinct component
// IDENTITY — which is what the cap was always documented to bound ("comfortably
// exceeds any realistic distinct-component count"). Each read now resolves its
// identity spine first (a SQL `groupBy` over `(componentKind, componentKey)`,
// ordered by recency and capped), then reads every row belonging to the retained
// identities. Because a facet can only ever REMOVE identities, the identity set
// a filtered read sees is a subset of the unfiltered read's, so:
//
//  - per-kind totals sum exactly to the All total;
//  - a filtered count can never exceed that kind's count within All (the
//    monotonicity invariant);
//  - a component's usage in the list equals its usage on the detail page, whose
//    reads are scoped to the ONE requested identity (and so are unaffected by
//    the facet the list was asked for). Those reads carry their own row ceiling
//    of `MAX_ORG_ORPHAN_USAGE_ROWS` — see `detail-usage-reads.ts` — so the parity
//    claim is "both sides read the same identity-scoped population", NOT that
//    either side is unbounded.
//
// Those three properties hold unconditionally for any org within the identity
// cap. Above it the spine still truncates — but on whole components, ordered by
// recency, rather than on an arbitrary row tail that shifts with the filter.
//
// MEMORY: moving the correctness bound onto identities does NOT leave the row
// reads unbounded. Each still carries `MAX_ORG_POPULATION_ROWS`, a ceiling set
// as far above the identity cap as Postgres's bind-parameter limit allows (6x
// it), and hitting it is an ANOMALY rather than the routine truncation the old
// raw-row cap performed — so it is logged, not swallowed. See
// `MAX_ORG_POPULATION_ROWS` for why that limit, not the memory allowance,
// decides the number.
// ---------------------------------------------------------------------------

/**
 * Cap on the number of DISTINCT components an org population read materializes.
 *
 * Replaces the former raw-row caps as the correctness-bearing bound. The shared
 * {@link AGENT_COMPONENT_INVENTORY_CAP} value is unchanged; what changed is the
 * unit it counts. Capping raw rows made the retained population depend on which
 * facet was requested (ISS-4797/ISS-4799); capping identities does not, because
 * a facet only ever removes identities from the same recency-ordered spine.
 */
export const MAX_ORG_POPULATION_COMPONENTS = AGENT_COMPONENT_INVENTORY_CAP;

/**
 * Rows one retained component identity is expected to contribute to a population
 * read: its install multiplicity (compute targets × observed versions) for the
 * inventory lane, and its per-session usage groups for the orphan lane.
 *
 * Sized as a generous allowance, not a measured maximum — it exists only to give
 * {@link MAX_ORG_POPULATION_ROWS} a number with a legible derivation.
 */
const MAX_ROWS_PER_COMPONENT = 20;

/**
 * Bind slots one prepared statement may carry on the Postgres wire protocol.
 *
 * Load-bearing here because Prisma binds every element of an `IN (...)` list as
 * its OWN parameter, and the inventory row ids this module returns are fed
 * straight into `agentComponentId: { in: [...] }` by the FK usage rollup (see
 * `loadUsageGroupsForInventory`). A row read that happily returns more ids than
 * this hands the NEXT read a statement the driver refuses outright — so the
 * ceiling below is derived from this limit rather than chosen freely.
 */
export const POSTGRES_MAX_BIND_PARAMETERS = 32_767;

/**
 * Bind slots held back for the rest of that rollup's predicate — the org id, one
 * arm per `?kinds=` value, one per `?search=` OR arm, the window bounds, and the
 * content scope. A deliberately generous reserve: the exact count varies with
 * the facets, and erring large costs a few retained rows while erring small
 * costs the whole request.
 */
const BIND_PARAMETERS_RESERVED_FOR_FACETS = 767;

/**
 * Hard ceiling on the rows either population row read may materialize.
 *
 * This is a MEMORY-and-driver bound, not the correctness bound — {@link
 * MAX_ORG_POPULATION_COMPONENTS} is the correctness bound, and it is the one
 * that decides which components a facet retains. The distinction matters because
 * a row ceiling is inherently facet-DEPENDENT (a `?kinds=` read starts from
 * fewer identities, so it reaches any row ceiling later than the unfiltered read
 * does), which is precisely the defect ISS-4797/ISS-4799 reported. So this
 * ceiling is set as far above the identity cap as it safely can be — 6x it —
 * and under it the facet invariants hold unconditionally.
 *
 * "As far as it safely can be" is the whole reason this is a `Math.min` rather
 * than a round number. The alternative to a ceiling is genuinely unbounded: the
 * inventory row ids feed an `agentComponentId: { in: [...] }` predicate, so an
 * org with pathological install multiplicity would build an unbounded IN-list as
 * well as an unbounded result set. But an IN-list is not merely expensive past
 * {@link POSTGRES_MAX_BIND_PARAMETERS} — it FAILS, taking the whole catalog
 * request with it. A ceiling above that limit would therefore trade a truncated
 * answer for a 500, which is why the driver limit, not the memory allowance,
 * decides the value at the current identity cap.
 *
 * Reaching it is an ANOMALY, not routine truncation, and callers log it (see
 * `warnOnRowCeiling`) rather than silently returning a facet-dependent
 * population. Raising it past the bind limit requires chunking that IN-list
 * first; the principled fix for an org that legitimately exceeds it is a
 * per-identity row limit (a lateral join), which would preserve the invariants
 * at any size. Both are deliberately out of scope here.
 */
export const MAX_ORG_POPULATION_ROWS = Math.min(
  MAX_ORG_POPULATION_COMPONENTS * MAX_ROWS_PER_COMPONENT,
  POSTGRES_MAX_BIND_PARAMETERS - BIND_PARAMETERS_RESERVED_FOR_FACETS
);

/** The columns the org population read selects off each inventory row. */
const ORG_INVENTORY_SELECT = {
  id: true,
  organizationId: true,
  computeTargetId: true,
  componentKind: true,
  externalComponentId: true,
  harness: true,
  name: true,
  componentKey: true,
  // FEA-3982 (Slice 2): the coarse fingerprint widens the org dedup key so two
  // same-named components with different bytes render as distinct versioned rows
  // (see `mergeComponentRows`).
  contentHash: true,
  sourceUrl: true,
  installPath: true,
  packId: true,
  scope: true,
  projectPath: true,
  // FEA-4247: needed to detect cloud-authored (sentinel-owned) rows — their
  // `computeTarget.userId` is the org's earliest active user (the sentinel
  // owner), NOT the creator, so it must NOT feed the owner fallback (see
  // `mergeComponentRows`).
  metadata: true,
  firstSeenAt: true,
  lastSeenAt: true,
  // FEA-4098 (Slice 3): only the target id/userId are needed now — authorship
  // comes from the `DefinitionVersionEditor` lineage, not the compute-target
  // user, so the nested `user` select is dropped.
  computeTarget: {
    select: {
      id: true,
      userId: true,
    },
  },
} as const;

/**
 * Inventory-lane `where` for the org-scoped component read: the org scope plus
 * the optional kind/search facets. Shared by the catalog list and the ranking
 * leaderboard so both count the same population (ISS-4635).
 *
 * Each facet is an all-or-nothing spread that contributes no predicate when
 * absent. FEA-3758: the `harness` facet is deliberately NOT applied here — it
 * filters post-fold on the derived (per-session) harness, not the inventory-row
 * column (see `listForOrg`).
 *
 * FEA-4086: `uninstalledAt: null` scopes the inventory to CURRENTLY-installed
 * rows. The desktop scanner tombstones a component it can no longer see by
 * stamping `uninstalledAt` (it does not delete the row), so without this
 * predicate the org inventory the web/desktop-Cloud read surfaces keeps
 * uninstalled components forever — the honest "No plugins installed." empty
 * state is then unreachable because a tombstoned plugin still counts as a row.
 * Rows predating the column carry `NULL` and correctly stay visible.
 */
export function orgInventoryWhere(
  organizationId: string,
  facets: Pick<AgentComponentListQuery, "kinds" | "search">
): Prisma.AgentComponentWhereInput {
  const { kinds, search } = facets;
  return {
    organizationId,
    uninstalledAt: null,
    ...(kinds && kinds.length > 0 ? { componentKind: { in: kinds } } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { componentKey: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

/**
 * ISS-4660 (item 3): the `?search=` facet, in the shape both usage lanes need to
 * apply it. `nameMatchedIdentities` carries the `(kind, key)` of inventory rows
 * that matched `search` on their display `name` — see
 * `collectNameMatchedIdentities`.
 */
export type UsageSearchFacet = {
  search: string | undefined;
  nameMatchedIdentities: readonly { kind: string; key: string }[];
};

/**
 * ISS-4660 (item 3): the ONE `?search=` predicate BOTH usage lanes apply — the
 * orphan (null-FK) read and the FK-linked `groupBy`.
 *
 * The FK lane needs it for the same reason ISS-4635 gave it the `kinds` facet:
 * `foldFkUsageIntoMerged` (ISS-4630) attributes FK-linked usage by the usage
 * row's OWN `(componentKind, componentKey)` and SEEDS a synthetic bucket for an
 * identity the (search-filtered) inventory read never returned. So a usage row
 * FK-linked to a search-matching inventory row but carrying a different,
 * non-matching own key would otherwise surface a component the caller filtered
 * out. The list applies no post-fold `search` filter, so this read is the only
 * place that leak can be closed.
 *
 * Deriving the predicate once — rather than restating it per lane — is the point:
 * the two lanes drifting apart is exactly the class of defect ISS-4630/4635 kept
 * re-opening. The `nameMatchedIdentities` arm is what keeps this a FILTER and not
 * an undercount: a component found by its display `name` has no `name` column on
 * the usage table, so its rows are readmitted by identity.
 */
export function usageSearchWhere(
  facet: UsageSearchFacet | null
): Prisma.AgentComponentSessionUsageWhereInput {
  if (!facet?.search) {
    return {};
  }
  return {
    OR: [
      { componentKey: { contains: facet.search, mode: "insensitive" } },
      ...facet.nameMatchedIdentities.map((identity) => ({
        componentKind: identity.kind,
        componentKey: {
          equals: identity.key,
          mode: "insensitive" as const,
        },
      })),
    ],
  };
}

/**
 * ISS-4797: read the org's inventory rows for the requested facets, bounded by
 * DISTINCT COMPONENT IDENTITY rather than by raw row count.
 *
 * Pass 1 resolves the identity spine — the distinct `(componentKind,
 * componentKey)` pairs the facets admit, ordered most-recently-seen first and
 * capped at {@link MAX_ORG_POPULATION_COMPONENTS}. Pass 2 reads every row
 * belonging to those identities. When the spine did not truncate (the realistic
 * case — the cap is sized to exceed any realistic distinct-component count) pass
 * 2 is the plain facet read with no row ceiling, so no component is ever
 * partially materialized and no component is dropped because a NOISIER kind
 * consumed the row budget first.
 *
 * The row read stays uncapped by design: its size is the retained identity count
 * times each component's install multiplicity (compute targets × observed
 * versions), which the identity cap bounds in the dimension that actually grows
 * with org size. The former raw-row cap bounded it in the dimension that made
 * the count wrong.
 */
export async function readOrgInventoryRows(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  facets: Pick<AgentComponentListQuery, "kinds" | "search">
) {
  const { where, scope } = await resolveInventoryIdentityScope(
    db,
    organizationId,
    facets
  );
  // No empty-spine short-circuit here, unlike the orphan lane below. It would be
  // sound against the database — the spine evaluated this read's own predicate —
  // but it is only ever worth one saved round trip on an org with no matching
  // components at all, and it would make the row read's result depend on a spine
  // the inventory test doubles are not all wired to derive. The asymmetry is
  // deliberate, not an oversight.
  const rows = await db.agentComponent.findMany({
    where: scope.truncated
      ? { AND: [where, inventoryIdentityScopeWhere(scope)] }
      : where,
    select: ORG_INVENTORY_SELECT,
    // Deterministic order so downstream consumers see a stable row sequence, and
    // so the memory ceiling below drops a stable tail if it ever binds.
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: MAX_ORG_POPULATION_ROWS,
  });
  warnOnRowCeiling(rows.length, OrgPopulationLane.Inventory, organizationId);
  return retainedRows(rows, scope);
}

/**
 * The org inventory identity spine, resolved once and shared by every read that
 * must reproduce the LIST's population. Kept as one helper so an ids-only read
 * (`readOrgInventoryIds`) and the full row read cannot resolve different
 * populations — the exact drift ISS-5363 exists to close.
 *
 * Most-recently-seen identities win the cap, with a deterministic tiebreak so an
 * org above the cap drops a STABLE set of components rather than an arbitrary one
 * that shifts request-to-request. `AgentComponent.lastSeenAt` is nullable, so
 * `pass` narrows the read to one half of that column when the cap binds — see
 * `readIdentitySpine`.
 */
async function resolveInventoryIdentityScope(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  facets: Pick<AgentComponentListQuery, "kinds" | "search">
): Promise<{ where: Prisma.AgentComponentWhereInput; scope: IdentityScope }> {
  const where = orgInventoryWhere(organizationId, facets);
  const readSpine = (pass: SpinePass, take: number) => {
    const recency = spinePassFilter(pass);
    return db.agentComponent.groupBy({
      by: ["componentKind", "componentKey"],
      where:
        recency === undefined
          ? where
          : { AND: [where, { lastSeenAt: recency }] },
      _max: { lastSeenAt: true },
      orderBy: [
        { _max: { lastSeenAt: "desc" } },
        { componentKind: "asc" },
        { componentKey: "asc" },
      ],
      take,
    });
  };
  return {
    where,
    scope: buildIdentityScope(await readIdentitySpine(readSpine)),
  };
}

/**
 * ISS-5363 (wongk review): the ids of the CURRENT org inventory the unfaceted
 * list bounds its FK usage read by — `uninstalledAt: null`, within the retained
 * identity spine.
 *
 * The detail's elsewhere-linked lane must ask its question over exactly this
 * population. Bounding that lane with `notIn <this family's ids>` instead was
 * BROADER than the list: it admitted usage FK-linked to a TOMBSTONED inventory
 * row, and to a current row the identity cap truncated away — neither of which
 * the list can load through its FK lane or its orphan lane, so the detail read
 * HIGH against the list. Same population in, same number out.
 *
 * Unfaceted deliberately: a detail route carries no `?kinds=`/`?search=`, so the
 * population it reconciles against is the All view's.
 */
export async function readOrgInventoryIds(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string
): Promise<string[]> {
  const { where, scope } = await resolveInventoryIdentityScope(
    db,
    organizationId,
    {}
  );
  const rows = await db.agentComponent.findMany({
    where: scope.truncated
      ? { AND: [where, inventoryIdentityScopeWhere(scope)] }
      : where,
    select: { id: true, componentKind: true, componentKey: true },
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: MAX_ORG_POPULATION_ROWS,
  });
  warnOnRowCeiling(rows.length, OrgPopulationLane.Inventory, organizationId);
  return retainedRows(rows, scope).map((row) => row.id);
}

/**
 * Read the org's ORPHANED usage — the rows no LIVE inventory row owns, either
 * because the `agentComponentId` FK is still null (the usage synced before its
 * inventory row existed, or the component-sync lane never linked it) or because
 * the FK points at a TOMBSTONED component (ISS-6180). These rows are invisible to
 * the FK-keyed `groupBy`, which is bounded by the live inventory's ids, so a
 * surface that reads only that lane silently reports zero for a component whose
 * detail page shows real invocations (ISS-4635).
 *
 * ISS-4799: bounded by DISTINCT COMPONENT IDENTITY (pass 1), then aggregated in
 * SQL over exactly those identities (pass 2) — the same `groupBy` shape the
 * FK-linked lane already uses, which also folds away the `gitBranch` dimension
 * this lane never reads. The former shape was a raw-row `findMany` under a
 * facet-scoped row cap, so a `?kinds=tool` request materialized far more of a
 * tool's usage than the unfiltered request did, and the same component reported
 * three different invocation totals across the All list, the filtered list, and
 * its detail page. Summing per (identity, session, harness, version) in SQL is
 * exactly what the row-by-row fold did in JS, so the folded totals are unchanged
 * — only the truncation is gone.
 */
export async function loadOrphanUsageRows(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  facets: {
    kinds?: readonly string[];
    search?: string;
    nameMatchedIdentities: { kind: string; key: string }[];
  },
  window: UsageWindow
): Promise<OrphanUsageRow[]> {
  const { kinds, search, nameMatchedIdentities } = facets;
  const where: Prisma.AgentComponentSessionUsageWhereInput = {
    // ISS-6180 (wongk review): usage-only means "no LIVE inventory row owns this
    // usage", not merely "the FK is null" — see `usageWithoutLiveInventoryWhere`.
    // Nested under `AND` rather than spread in, because `usageSearchWhere` below
    // owns the top-level `OR` key and a spread would silently replace this one.
    AND: [usageWithoutLiveInventoryWhere()],
    ...(kinds && kinds.length > 0 ? { componentKind: { in: [...kinds] } } : {}),
    // FEA-3215 / ISS-4660: the same `search` predicate the FK lane applies, from
    // the one shared derivation, so orphan (usage-only) rows folded into the
    // merged set can't leak components that fall outside the active filter.
    //
    // FEA-3758: harness is deliberately NOT pre-filtered here. The derived
    // harness needs ALL of a component's usage rows (a component used in both
    // harnesses resolves to `both`); pre-filtering orphan usage by a single
    // harness would drop the other harness's rows and corrupt the derived value.
    // The harness facet is applied post-fold on the derived harness.
    ...usageSearchWhere({ search, nameMatchedIdentities }),
    // Usage carries no organizationId of its own; it isolates through
    // session→artifact.organizationId.
    session: {
      artifact: {
        organizationId,
      },
    },
    // FEA-3160 / FEA-3178: scope orphan usage to the time window so synthetic
    // (usage-only) entries only surface when they were used in-window. Both
    // bounds apply.
    ...usageWindowWhere(window),
  };

  // Most-recently-invoked identities win the cap, with a deterministic tiebreak
  // so an org above the cap drops a STABLE set of components.
  // `AgentComponentSessionUsage.lastInvokedAt` is nullable and an all-time window
  // adds no bound of its own, so the never-stamped tail is demoted by the same
  // `pass` narrowing the inventory lane uses — see `readIdentitySpine`. The
  // predicate is nested under `AND` rather than spread in, because a
  // `?startDate=`/`?endDate=` window already owns the `lastInvokedAt` key here and
  // a spread would silently replace that bound.
  const readSpine = (pass: SpinePass, take: number) => {
    const recency = spinePassFilter(pass);
    return db.agentComponentSessionUsage.groupBy({
      by: ["componentKind", "componentKey"],
      where:
        recency === undefined
          ? where
          : { AND: [where, { lastInvokedAt: recency }] },
      _max: { lastInvokedAt: true },
      orderBy: [
        { _max: { lastInvokedAt: "desc" } },
        { componentKind: "asc" },
        { componentKey: "asc" },
      ],
      take,
    });
  };
  const scope = buildIdentityScope(await readIdentitySpine(readSpine));
  if (scope.retained.size === 0) {
    return [];
  }

  const groups = await db.agentComponentSessionUsage.groupBy({
    // Mirrors the FK lane's grouping key minus `agentComponentId` (this lane
    // attributes by the row's own identity, never by the FK — which is null or
    // tombstoned here) and `gitBranch` (this lane never read it — the branch
    // split is a detail-view concern). Summing across branches is what the
    // former row-by-row fold did.
    by: [
      "componentKind",
      "componentKey",
      "agentSessionId",
      "harness",
      // FEA-3982: the version identity the orphan usage was recorded against, so
      // the fold attributes it to the matching version bucket rather than a
      // catch-all unversioned one.
      "componentVersionHash",
      "definitionVersionId",
    ],
    where: scope.truncated
      ? { AND: [where, { componentKey: { in: scope.keys } }] }
      : where,
    // ISS-4635: errors ride the same lane as invocations so the ranking
    // leaderboard's `errorRate` covers orphan usage too.
    _sum: { invocationCount: true, errorCount: true },
    _min: { firstInvokedAt: true },
    _max: { lastInvokedAt: true },
    // Deterministic order so the memory ceiling below drops a stable tail if it
    // ever binds, and so the tail it drops is the least-recently-invoked one.
    orderBy: [
      { _max: { lastInvokedAt: "desc" } },
      { componentKind: "asc" },
      { componentKey: "asc" },
      { agentSessionId: "asc" },
    ],
    take: MAX_ORG_POPULATION_ROWS,
  });
  warnOnRowCeiling(
    groups.length,
    OrgPopulationLane.OrphanUsage,
    organizationId
  );
  const retained = retainedRows(groups, scope);

  // FEA-3982 (wongk decision): resolve each group's `definitionVersionId` to its
  // exact `definitionHash`, so it attributes on the F1 fingerprint when linked
  // and the coarse `componentVersionHash` otherwise.
  const orphanDefinitionHashById = await resolveDefinitionHashes(
    db,
    organizationId,
    retained.map((group) => group.definitionVersionId)
  );
  return retained.map((group) => ({
    agentSessionId: group.agentSessionId,
    componentKind: group.componentKind,
    componentKey: group.componentKey,
    harness: group.harness,
    invocationCount: group._sum?.invocationCount ?? 0,
    errorCount: group._sum?.errorCount ?? 0,
    firstInvokedAt: group._min?.firstInvokedAt ?? null,
    lastInvokedAt: group._max?.lastInvokedAt ?? null,
    componentVersionHash: group.componentVersionHash,
    definitionHash: group.definitionVersionId
      ? (orphanDefinitionHashById.get(group.definitionVersionId) ?? null)
      : null,
  }));
}

/**
 * The retained slice of one facet's identity spine: which `(kind, key)` pairs the
 * cap kept, whether it truncated at all, and the key list a follow-up row read
 * narrows on when it did.
 */
type IdentityScope = {
  truncated: boolean;
  keys: string[];
  retainsNullKey: boolean;
  retained: ReadonlySet<string>;
};

/**
 * One lane's resolved identity spine: the identities the cap kept, plus whether
 * the cap is what decided that set.
 *
 * `truncated` is reported by the read that hit its `take`, NOT measured off
 * `identities` — see `readIdentitySpine` for the dedupe that makes those two
 * different answers.
 */
type ResolvedSpine = {
  identities: IdentityShaped[];
  truncated: boolean;
};

/** One row shaped enough to be tested against a resolved {@link IdentityScope}. */
type IdentityShaped = {
  componentKind: string;
  componentKey: string | null;
};

/**
 * The comparable form of a `(componentKind, componentKey)` identity. `\u0000`
 * separates the halves because it cannot occur in either column, so no pair of
 * distinct identities can collide on a concatenation boundary.
 */
function identityKeyOf(kind: string, key: string | null): string {
  return `${kind}\u0000${key ?? ""}`;
}

/**
 * Resolve a {@link ResolvedSpine} into the scope a follow-up row read applies.
 *
 * `truncated` is carried in from the spine rather than re-derived from
 * `identities.length` here. Those are NOT the same test: the demotion path can
 * return fewer than {@link MAX_ORG_POPULATION_COMPONENTS} identities from a
 * population that genuinely exceeds the cap (see `readIdentitySpine`'s dedupe),
 * and a length-based test would read that as "not truncated" — dropping the
 * identity narrowing on exactly the above-cap orgs it exists for, and handing the
 * population back to the facet-DEPENDENT row ceiling this whole change removes.
 */
function buildIdentityScope(spine: ResolvedSpine): IdentityScope {
  const retained = new Set<string>();
  const keys = new Set<string>();
  let retainsNullKey = false;
  for (const identity of spine.identities) {
    retained.add(identityKeyOf(identity.componentKind, identity.componentKey));
    if (identity.componentKey === null) {
      retainsNullKey = true;
    } else {
      keys.add(identity.componentKey);
    }
  }
  return {
    truncated: spine.truncated,
    keys: [...keys],
    retainsNullKey,
    retained,
  };
}

/**
 * The `componentKey` narrowing a truncated inventory spine adds to its row read.
 * Nested under an `AND` by the caller rather than spread into the base `where`,
 * because the `?search=` facet already owns that where-clause's `OR` key and a
 * spread would silently replace it. `AgentComponent.componentKey` is nullable, so
 * a retained null-key identity needs its own arm — an `IN` list never matches
 * `NULL` in SQL. (`AgentComponentSessionUsage.componentKey` is NOT NULL, so that
 * lane narrows with a plain `IN` and needs no such arm.)
 */
function inventoryIdentityScopeWhere(
  scope: IdentityScope
): Prisma.AgentComponentWhereInput {
  return {
    OR: [
      { componentKey: { in: scope.keys } },
      ...(scope.retainsNullKey
        ? [{ componentKey: null } satisfies Prisma.AgentComponentWhereInput]
        : []),
    ],
  };
}

/**
 * Drop rows whose identity the spine did not retain. The `componentKey`
 * narrowing above is key-only (a two-column `IN` is not expressible), so a
 * retained key can readmit rows of a NON-retained kind that happens to share it;
 * this exact-pair filter is what makes the scope precise.
 */
function retainedRows<T extends IdentityShaped>(
  rows: T[],
  scope: IdentityScope
): T[] {
  if (!scope.truncated) {
    return rows;
  }
  return rows.filter((row) =>
    scope.retained.has(identityKeyOf(row.componentKind, row.componentKey))
  );
}

/**
 * Which half of a lane's nullable recency column one spine read covers.
 *
 * `All` is the single read every below-cap org resolves its spine with;
 * `Stamped` and `Unstamped` exist only to reproduce `NULLS LAST` when the cap
 * actually binds. See {@link readIdentitySpine}.
 */
const SpinePass = {
  All: "all",
  Stamped: "stamped",
  Unstamped: "unstamped",
} as const;
type SpinePass = (typeof SpinePass)[keyof typeof SpinePass];

/**
 * The predicate a {@link SpinePass} narrows its lane's recency column with, or
 * `undefined` for the unnarrowed `All` pass. Callers key it under their own
 * column name (`lastSeenAt` / `lastInvokedAt`), which is why this returns the
 * bare filter rather than a whole `where`.
 */
function spinePassFilter(pass: SpinePass): { not: null } | null | undefined {
  if (pass === SpinePass.Stamped) {
    return { not: null };
  }
  if (pass === SpinePass.Unstamped) {
    return null;
  }
  return undefined;
}

/**
 * Resolve one lane's identity spine, with the NEVER-STAMPED identities demoted
 * behind every stamped one whenever the cap actually decides what to keep.
 *
 * Both lanes order their spine by an aggregate of a NULLABLE recency column
 * (`max(lastSeenAt)`, `max(lastInvokedAt)`), and Postgres sorts NULLs FIRST under
 * `DESC`. Left alone, identities the scanner has never stamped a timestamp on
 * would outrank every genuinely recent component and win the cap outright — the
 * cap would retain the org's least-informative components and truncate away its
 * live ones. The obvious repair, `NULLS LAST`, is not expressible: Prisma accepts
 * the `{ sort, nulls }` order object only on a plain scalar column (as the
 * inventory ROW read uses it), never on a `groupBy` aggregate key, whose `_max`
 * order input is typed as a bare `SortOrder`.
 *
 * So the demotion is done with reads that reproduce `NULLS LAST` exactly — but
 * only when it can change the answer. A first `All` pass that comes back BELOW
 * the cap returned every identity the facets admit, and no ordering of a complete
 * set changes its membership, so that pass is the whole story and the realistic
 * org pays exactly one query. Only when it comes back AT the cap — the one case
 * where the order decides who is dropped — is the spine re-resolved as the
 * stamped identities by recency, then the unstamped ones by the same
 * deterministic `(componentKind, componentKey)` tiebreak that keeps an above-cap
 * org dropping a STABLE component set request-to-request.
 *
 * An identity holding both stamped and unstamped rows satisfies BOTH narrowed
 * `where`s — its stamped rows form one group and its unstamped rows another —
 * even though its true aggregate is non-null and it therefore belongs to the
 * stamped pass. The dedupe is what keeps the unstamped pass from re-admitting
 * it, and it is why `truncated` is reported by the READ that hit its cap rather
 * than measured off the returned array: dropping those duplicates can land the
 * spine under the cap for a population that plainly exceeds it (the demotion
 * only runs because the `All` pass came back AT the cap), and a length-based
 * test would then call an above-cap org untruncated.
 */
async function readIdentitySpine(
  readSpine: (
    pass: SpinePass,
    take: number
  ) => Promise<readonly IdentityShaped[]>
): Promise<ResolvedSpine> {
  const spine = await readSpine(SpinePass.All, MAX_ORG_POPULATION_COMPONENTS);
  if (spine.length < MAX_ORG_POPULATION_COMPONENTS) {
    return { identities: [...spine], truncated: false };
  }
  const stamped = await readSpine(
    SpinePass.Stamped,
    MAX_ORG_POPULATION_COMPONENTS
  );
  const remaining = MAX_ORG_POPULATION_COMPONENTS - stamped.length;
  if (remaining <= 0) {
    return { identities: [...stamped], truncated: true };
  }
  const seen = new Set(
    stamped.map((identity) =>
      identityKeyOf(identity.componentKind, identity.componentKey)
    )
  );
  const unstamped = await readSpine(SpinePass.Unstamped, remaining);
  return {
    identities: [
      ...stamped,
      ...unstamped.filter(
        (identity) =>
          !seen.has(
            identityKeyOf(identity.componentKind, identity.componentKey)
          )
      ),
    ],
    truncated: true,
  };
}

/**
 * Which population row read hit its ceiling. A closed, low-cardinality set so
 * the emitted event carries the lane as a tag rather than free text.
 */
export const OrgPopulationLane = {
  Inventory: "inventory",
  OrphanUsage: "orphan_usage",
} as const;
export type OrgPopulationLane =
  (typeof OrgPopulationLane)[keyof typeof OrgPopulationLane];

/**
 * Report a population row read that materialized all the way to
 * {@link MAX_ORG_POPULATION_ROWS}.
 *
 * Reaching this ceiling is an ANOMALY, not the routine truncation the old raw-row
 * cap performed: the correctness bound is {@link MAX_ORG_POPULATION_COMPONENTS}
 * (identities), and the row ceiling sits an order of magnitude above what that
 * cap can legitimately expand to. So a read that touches it means the population
 * is pathological — and, because a row ceiling is inherently facet-DEPENDENT, it
 * is the one condition under which the ISS-4797/ISS-4799 invariants could stop
 * holding. It is therefore surfaced rather than swallowed, at error level so it
 * reaches the alerting path instead of being lost in info-level noise.
 *
 * Deliberately does NOT throw or truncate differently: the caller still returns
 * its identity-scoped rows, so a pathological org degrades to a bounded answer
 * rather than a failed request.
 */
function warnOnRowCeiling(
  rowCount: number,
  lane: OrgPopulationLane,
  organizationId: string
): void {
  if (rowCount < MAX_ORG_POPULATION_ROWS) {
    return;
  }
  log.error("agent_components_org_population_row_ceiling_reached", {
    ceiling: MAX_ORG_POPULATION_ROWS,
    identityCap: MAX_ORG_POPULATION_COMPONENTS,
    lane,
    organizationId,
    rowCount,
  });
}
