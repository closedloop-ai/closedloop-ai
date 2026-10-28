import "server-only";

import { AGENT_COMPONENT_INVENTORY_CAP } from "@repo/api/src/types/agent-component";
import type { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { countPredicateBindParameters } from "@/lib/postgres-bind-parameters";
import { resolveDefinitionHashes } from "./definition-hash-resolution";
import { foldedIdentityKeys } from "./detail-usage-reads";
import type { OrphanUsageRow } from "./identity";
import {
  type UsageWindow,
  usageWindowWhere,
  usageWithoutLiveInventoryWhere,
} from "./plugin-child-usage";
import { orArmsPerStatement } from "./usage-bind-budget";
import type { AgentComponentListQuery } from "./validators";

// ---------------------------------------------------------------------------
// ISS-4797 / ISS-4799 / ISS-6891: the two FACET-SCOPED reads that feed the org
// component population — the inventory scan and the ORPHAN (null-FK) usage scan.
//
// Both once carried a terminal `take` applied AFTER the request's `?kinds=` /
// `?search=` predicate. That ordering makes a STRICTER filter return MORE data:
// the unfiltered read spends its budget across every kind and drops its older
// tail, while a `?kinds=subagent` read starts from a far smaller set and never
// truncates at all. The reported symptoms were exactly that — per-kind totals
// summing to 2,174 against an All total of 2,138 (51 subagent slugs visible only
// in the filtered view, all older than All's truncation floor), and one `tool`
// component reporting 1 invocation in the All list, 15 in the kind-filtered
// list, and 61 on its (identity-scoped, untruncated) detail page.
//
// ISS-4797 moved that cap off raw ROWS and onto distinct component IDENTITY, and
// ISS-5516 removed the second, raw-row ceiling that sat beside it. Both repairs
// narrowed the defect without closing it: the identity cap was still evaluated
// against the FACETED predicate and was still TERMINAL — no page could reach past
// it — so above 5,000 identities a `?kinds=subagent` read still surfaced an older
// subagent that the All read had truncated away. The module's own header used to
// concede this ("Above it the spine still truncates"). A cap that decides which
// identities exist is not a safety valve, it is the answer.
//
// ISS-6891 removes the cap rather than relocating it a third time. Both reads now
// evaluate their facet predicate and return the population it selects, complete.
// With no truncation anywhere in the pipeline the subset property is structural
// rather than conditional: a facet can only REMOVE identities from a complete
// population, so a filtered read is a subset of the unfiltered one at every org
// size, per-kind totals sum exactly to the All total, and the `total`/`hasMore`
// the list emits describe the whole population instead of a capped view of it.
// Pagination stays where it belongs — on the caller's `limit`/`offset` over that
// complete population — so a page is a window, never a truncation.
//
// What bounds cost now is the same thing that bounds the FK-linked rollup in
// `org-population.ts`, which has always run with NO cap over a strictly LARGER
// grouping key on the same table: the org's real size, plus the chunking
// `loadUsageGroupsForInventory` applies to its `agentComponentId: { in: [...] }`
// predicate for the driver's bind budget. The remaining exposure is a genuinely
// enormous org's scan volume, and it is REPORTED rather than silently truncated —
// see `warnOnOversizePopulation`, which never changes what the read returns.
// ---------------------------------------------------------------------------

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
 *
 * ISS-6756 (whitlockk): that readmission arm is an IDENTITY equality, so it matches
 * the persisted fold like every other identity lane. Asking Prisma for
 * `{ equals, mode: "insensitive" }` compiles to `component_key ILIKE $n`, which
 * binds the key as an unescaped PATTERN — so readmitting `mcp__closedloop__ping`
 * also readmitted `mcpXXclosedloopYYping`, seeding a synthetic bucket for a
 * DIFFERENT component into a `?search=` response the caller never asked for. The
 * substring arm below stays on the raw column: it is a genuine `contains` over
 * whatever the user typed, not an identity, and there is no folded value to
 * compare a fragment against.
 */
export function usageSearchWhere(
  facet: UsageSearchFacet | null
): Prisma.AgentComponentSessionUsageWhereInput {
  if (!facet?.search) {
    return {};
  }
  return {
    OR: [
      searchContainsArm(facet.search),
      ...searchIdentityArms(facet.nameMatchedIdentities),
    ],
  };
}

/**
 * The substring half of the `?search=` predicate: a genuine `contains` over
 * whatever the user typed, on the raw column. Built in ONE place because
 * {@link usageSearchWherePasses} needs the identical object to negate — a
 * hand-copied twin there would make the complement inexact the moment either
 * side moved, and an inexact complement drops or duplicates rows rather than
 * erroring.
 */
function searchContainsArm(
  search: string
): Prisma.AgentComponentSessionUsageWhereInput {
  return { componentKey: { contains: search, mode: "insensitive" } };
}

/**
 * The readmission half: one identity-equality arm per name-matched inventory
 * identity. An identity whose key folds to nothing contributes NO arm — `""`
 * here would readmit every row still on the column's `DEFAULT ''` value, which
 * is the opposite of what a filter arm is for.
 */
function searchIdentityArms(
  identities: readonly { kind: string; key: string }[]
): Prisma.AgentComponentSessionUsageWhereInput[] {
  return identities.flatMap((identity) =>
    foldedIdentityKeys([identity.key]).map((componentKeyNormalized) => ({
      componentKind: identity.kind,
      componentKeyNormalized,
    }))
  );
}

/**
 * What one readmission arm costs, MEASURED off a representative arm rather than
 * restated as a number beside it — the reason
 * {@link countPredicateBindParameters} exists at all. A hand count goes stale the
 * moment the arm grows a term, and this one is what divides the budget in
 * {@link usageSearchWherePasses}.
 */
export const SEARCH_IDENTITY_ARM_BIND_WIDTH = countPredicateBindParameters({
  componentKind: "",
  componentKeyNormalized: "",
});

/**
 * ISS-8932: {@link usageSearchWhere} decomposed into passes narrow enough that
 * each one fits a single statement's bind budget, and DISJOINT so their results
 * may be concatenated.
 *
 * ISS-6891 removed the 5,000-identity population cap, which was the only thing
 * bounding this facet's arm count: an org with roughly 16k name-matching
 * components emitted a statement Postgres refuses outright, 500ing a broad
 * `?search=` instead of returning the complete inventory. The bound belongs here,
 * upstream of every consumer, because narrowing the OTHER half of those
 * statements — the id `IN` — cannot shrink the arms.
 *
 * THE SPLIT IS A PARTITION, NOT A CHUNKING, and that is the whole design. A usage
 * row can satisfy BOTH the `contains` arm and an identity arm, so slicing the
 * `OR` naively returns the same row under two passes; a consumer that
 * concatenates would then double-count invocations and sessions — a silently
 * inflated total, strictly worse than the refusal it replaced. So the first pass
 * is the `contains` arm ALONE and every identity pass carries an explicit `NOT`
 * of it. Their union is exactly the original `OR`, and their pairwise
 * intersections are empty:
 *   - a row matching `contains` satisfies only pass one, by the `NOT`;
 *   - a row not matching it carries exactly ONE `componentKeyNormalized` (the
 *     column is a database-derived `lower(btrim(component_key))`, not a writer's
 *     value), and {@link foldedIdentityKeys} de-duplicates, so the identity arms
 *     partition and it matches at most one identity pass.
 *
 * Every term is a function of `(componentKind, componentKey)` alone, which is why
 * a `groupBy` consumer inherits the partition at GROUP granularity as long as
 * both columns are in its `by` key — see {@link usageSearchWherePasses}'s callers,
 * where that is the load-bearing precondition.
 *
 * A facet that already fits returns the single, byte-identical
 * {@link usageSearchWhere} predicate, so every request this product actually
 * serves issues exactly the statements it does today.
 *
 * The no-search case returns ONE empty pass rather than none: callers loop over
 * passes, and returning `[]` would silently skip the read entirely.
 */
export function usageSearchWherePasses(
  facet: UsageSearchFacet | null,
  identityArmsPerPass: number
): readonly Prisma.AgentComponentSessionUsageWhereInput[] {
  if (!facet?.search) {
    return [{}];
  }
  // Clamped at BOTH ends by the caller's own budget arithmetic, and again here:
  // a zero or fractional width would step the loop below by zero and never
  // terminate, which is a hang rather than a wrong answer.
  const perPass = Math.max(1, Math.floor(identityArmsPerPass));
  const arms = searchIdentityArms(facet.nameMatchedIdentities);
  if (arms.length <= perPass) {
    return [usageSearchWhere(facet)];
  }
  const containsArm = searchContainsArm(facet.search);
  const passes: Prisma.AgentComponentSessionUsageWhereInput[] = [containsArm];
  for (let offset = 0; offset < arms.length; offset += perPass) {
    passes.push({
      NOT: containsArm,
      OR: arms.slice(offset, offset + perPass),
    });
  }
  return passes;
}

/**
 * ISS-6891: read the org's inventory rows for the requested facets — the
 * COMPLETE population the facets select, with no terminal cap.
 *
 * A caller pages this population through `limit`/`offset` in `listForOrg`, so
 * every identity the facets admit stays reachable. That is what makes a filtered
 * read a subset of the unfiltered one at any org size: with nothing truncated,
 * the only thing a facet can do is remove identities.
 */
export async function readOrgInventoryRows(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  facets: Pick<AgentComponentListQuery, "kinds" | "search">
) {
  const rows = await db.agentComponent.findMany({
    where: orgInventoryWhere(organizationId, facets),
    select: ORG_INVENTORY_SELECT,
    // Deterministic order so downstream consumers see a stable row sequence.
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  });
  warnOnOversizePopulation(
    rows.length,
    OrgPopulationLane.Inventory,
    organizationId
  );
  return rows;
}

/**
 * ISS-5363 (whitlockk review): the ids of the CURRENT org inventory the unfaceted
 * list bounds its FK usage read by — `uninstalledAt: null`.
 *
 * The detail's elsewhere-linked lane must ask its question over exactly this
 * population. Bounding that lane with `notIn <this family's ids>` instead was
 * BROADER than the list: it admitted usage FK-linked to a TOMBSTONED inventory
 * row, which the list can load through neither its FK lane nor its orphan lane,
 * so the detail read HIGH against the list. Same population in, same number out.
 *
 * Unfaceted deliberately: a detail route carries no `?kinds=`/`?search=`, so the
 * population it reconciles against is the All view's.
 */
export async function readOrgInventoryIds(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string
): Promise<string[]> {
  const rows = await db.agentComponent.findMany({
    where: orgInventoryWhere(organizationId, {}),
    select: { id: true, componentKind: true, componentKey: true },
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  });
  warnOnOversizePopulation(
    rows.length,
    OrgPopulationLane.Inventory,
    organizationId
  );
  return rows.map((row) => row.id);
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
 * ISS-4799 / ISS-6891: aggregated in SQL over the facet's COMPLETE population —
 * the same `groupBy` shape the FK-linked lane already uses, which also folds away
 * the `gitBranch` dimension this lane never reads. The former shape was a raw-row
 * `findMany` under a facet-scoped row cap, so a `?kinds=tool` request materialized
 * far more of a tool's usage than the unfiltered request did, and the same
 * component reported three different invocation totals across the All list, the
 * filtered list, and its detail page. Summing per (identity, session, harness,
 * version) in SQL is exactly what the row-by-row fold did in JS, so the folded
 * totals are unchanged — only the truncation is gone.
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
  const baseWhere: Prisma.AgentComponentSessionUsageWhereInput = {
    // ISS-6180 (whitlockk review): usage-only means "no LIVE inventory row owns this
    // usage", not merely "the FK is null" — see `usageWithoutLiveInventoryWhere`.
    // Nested under `AND` rather than spread in, because the search pass spread in
    // below owns the top-level `OR` key and a spread would silently replace this
    // one.
    AND: [usageWithoutLiveInventoryWhere()],
    ...(kinds && kinds.length > 0 ? { componentKind: { in: [...kinds] } } : {}),
    // FEA-3758: harness is deliberately NOT pre-filtered here. The derived
    // harness needs ALL of a component's usage rows (a component used in both
    // harnesses resolves to `both`); pre-filtering orphan usage by a single
    // harness would drop the other harness's rows and corrupt the derived value.
    // The harness facet is applied post-fold on the derived harness.
    //
    // The `?search=` facet is deliberately ABSENT from this object — it is spread
    // in per PASS below.
    //
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

  // FEA-3215 / ISS-4660: the `search` predicate is the FK lane's own, from the
  // one shared derivation, so orphan (usage-only) rows folded into the merged set
  // can't leak components that fall outside the active filter.
  //
  // ISS-8932: it now arrives as disjoint PASSES, one statement each. Unlike the
  // FK lane this one has no second chunk loop to multiply with, so the arms take
  // the whole remaining budget (`shares: 1`), measured off the predicate this
  // request actually built rather than assumed small.
  const passes = usageSearchWherePasses(
    { search, nameMatchedIdentities },
    orArmsPerStatement(
      countPredicateBindParameters(baseWhere),
      SEARCH_IDENTITY_ARM_BIND_WIDTH,
      1
    )
  );
  const groups: OrphanUsageGroup[] = [];
  for (const searchPass of passes) {
    const passGroups = await readOrphanUsageGroups(db, {
      ...baseWhere,
      ...searchPass,
    });
    // Appended one at a time rather than spread: a large org's orphan lane can
    // return far more groups than the engine accepts as ARGUMENTS to one call.
    for (const group of passGroups) {
      groups.push(group);
    }
  }
  warnOnOversizePopulation(
    groups.length,
    OrgPopulationLane.OrphanUsage,
    organizationId
  );
  // FEA-3982 (whitlockk decision): resolve each group's `definitionVersionId` to its
  // exact `definitionHash`, so it attributes on the F1 fingerprint when linked
  // and the coarse `componentVersionHash` otherwise.
  const orphanDefinitionHashById = await resolveDefinitionHashes(
    db,
    organizationId,
    groups.map((group) => group.definitionVersionId)
  );
  return groups.map((group) => ({
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
 * One grouped orphan-usage row, exactly as the `groupBy` returns it. Named so the
 * per-pass accumulator in {@link loadOrphanUsageRows} has a type without
 * restating the aggregate shape.
 */
type OrphanUsageGroup = Awaited<
  ReturnType<typeof readOrphanUsageGroups>
>[number];

/**
 * The orphan lane's one `groupBy`, issued once per disjoint `?search=` pass.
 *
 * SOUND TO CONCATENATE ACROSS PASSES WITH NO DEDUPE and no re-aggregation. Every
 * term {@link usageSearchWherePasses} emits is a function of
 * `(componentKind, componentKey)` alone, and BOTH are in the `by` key below, so
 * every row of a given group satisfies the same one pass — no group can span two,
 * exactly as `agentComponentId` makes the FK lane's id chunking sound.
 */
function readOrphanUsageGroups(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  where: Prisma.AgentComponentSessionUsageWhereInput
) {
  return db.agentComponentSessionUsage.groupBy({
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
    where,
    // ISS-4635: errors ride the same lane as invocations so the ranking
    // leaderboard's `errorRate` covers orphan usage too.
    _sum: { invocationCount: true, errorCount: true },
    _min: { firstInvokedAt: true },
    _max: { lastInvokedAt: true },
    // Deterministic order so downstream consumers see a stable group sequence.
    orderBy: [
      { _max: { lastInvokedAt: "desc" } },
      { componentKind: "asc" },
      { componentKey: "asc" },
      { agentSessionId: "asc" },
    ],
  });
}

/**
 * Which population read materialized an oversize result. A closed,
 * low-cardinality set so the emitted event carries the lane as a tag rather than
 * free text.
 */
export const OrgPopulationLane = {
  Inventory: "inventory",
  OrphanUsage: "orphan_usage",
} as const;
export type OrgPopulationLane =
  (typeof OrgPopulationLane)[keyof typeof OrgPopulationLane];

/**
 * Rows a single component identity is expected to contribute — install
 * multiplicity for the inventory lane, per-session usage groups for the orphan
 * lane. A generous allowance, not a measured maximum: it exists only to give
 * {@link OVERSIZE_POPULATION_ROWS} a legible derivation.
 */
const EXPECTED_ROWS_PER_COMPONENT = 20;

/**
 * Informational threshold above which a population read is worth an operator's
 * attention.
 *
 * ISS-5516 removed the raw-row CEILING these lanes used to carry, and ISS-6891
 * removed the identity cap that replaced it; the visibility both truncations
 * carried did not go with them. This is now the ONLY thing these lanes report
 * about their own size, so it is the honest signal that an org's population has
 * outgrown what a single request should materialize.
 *
 * The distinction is the whole point: this threshold NEVER changes what the read
 * returns. Crossing it means "this org's population is large enough that an SRE
 * should look before it becomes a transaction timeout", not "rows were dropped"
 * — nothing is dropped, which is exactly why the signal has to exist.
 *
 * Sized off the shared {@link AGENT_COMPONENT_INVENTORY_CAP}, which after ISS-6891
 * bounds no read: it survives as the largest page a caller may request and, here,
 * as the distinct-component count above which an org stops being routine.
 */
export const OVERSIZE_POPULATION_ROWS =
  AGENT_COMPONENT_INVENTORY_CAP * EXPECTED_ROWS_PER_COMPONENT;

/**
 * Report a population read whose result crossed {@link OVERSIZE_POPULATION_ROWS}.
 *
 * Emitted at error level so it reaches the alerting path rather than being lost
 * in info-level noise — the same lane `fetchDetailUsageSeenBounds` uses for its
 * own anomaly signal. Deliberately observational: it does not throw, truncate, or
 * otherwise alter the returned population, because a facet-dependent truncation
 * here is precisely the defect ISS-5516 and ISS-6891 removed.
 */
function warnOnOversizePopulation(
  rowCount: number,
  lane: OrgPopulationLane,
  organizationId: string
): void {
  if (rowCount < OVERSIZE_POPULATION_ROWS) {
    return;
  }
  log.error("agent_components_org_population_oversize", {
    lane,
    organizationId,
    rowCount,
    threshold: OVERSIZE_POPULATION_ROWS,
  });
}
