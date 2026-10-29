/**
 * @file session-count-population-reconciliation.ts
 * @description The cross-surface reconciliation contract for ISS-8474: which
 * rendered counts MUST agree with each other, and which are expected to differ.
 *
 * A count's population (the sibling `session-count-population.ts`) says what one
 * number measures. This module answers the question a reader actually asks when
 * two numbers are on screen at once: "should these be the same?" ISS-7905's
 * whole complaint was that the product never answered it, so a user seeing 178
 * in one place and 18 in another had to guess whether they had found a bug.
 *
 * ## The verdict is DERIVED, not declared
 *
 * Two SITES reconcile exactly when they render the same POPULATION. Nothing here
 * hand-writes "these two agree" beside a pair, because a hand-written verdict
 * can drift away from the scopes it claims to summarize — which is the ISS-8474
 * defect one level up. When two sites differ, `differingScopeAxes` names the
 * axes responsible, so the reason a user is shown comes from the same record the
 * count's own disclosure comes from.
 *
 * The pinned expectations live in the test beside this file, written out as
 * independent literals. They are deliberately NOT derived from this module: a
 * fixture that reads its answer from the code it polices cannot fail.
 *
 * ## What the registry models, and what it makes no claim about
 *
 * Every site here is modeled as the UNFILTERED read at the scope its population
 * names: the Sessions toolbar at its empty facet selection, and — for the org
 * spellings — the whole-org aggregation. That is the only read a site id
 * identifies, so it is the only read a derived verdict speaks for. Stated as
 * {@link SESSION_COUNT_MODELED_READ} below (ISS-10888).
 *
 * The registry makes NO claim about two mounts the same components also have:
 *
 * - A FACET-NARROWED list. The footer honours the toolbar's Status and harness
 *   facets; the dashboard tile has no facet control. With a facet picked the two
 *   numbers legitimately disagree while `reconcileSessionCountSites` still says
 *   `reconciles`, and `differingScopeAxes` cannot attribute the difference,
 *   because `SessionCountPopulationScope` has no facet axis.
 * - A Me- or Team-SCOPED insights mount. Neither route pins the org scope:
 *   `/{orgSlug}/dashboard` and `/{orgSlug}/insights` both render the same tile
 *   under a scope selector that defaults to Me (the dashboard's reaches
 *   Organization, the insights page's also Team), and one site id serves both
 *   (`insights-data-source-provider.tsx`). Only an Organization-scoped mount,
 *   on either route, is the read the org-footer verdict speaks for.
 *
 * Recorded rather than modeled on purpose. Nothing outside this package consumes
 * the verdict, so a facet axis or a per-scope site split would be taxonomy with
 * no reader; the reader this protects is the next engineer, who must not take a
 * `reconciles` as a promise about a filtered or narrowed mount.
 */
import { InsightsScope } from "@repo/api/src/types/insights";
import {
  SESSION_COUNT_POPULATION,
  SESSION_COUNT_POPULATION_SCOPE,
  type SessionCountPopulation,
  type SessionCountPopulationScope,
} from "./session-count-population";

/**
 * The one read every site is modeled at — see "What the registry models" in the
 * file docblock. Values, not prose, so a test can pin them and a reader can
 * cite them: `facetSelection` is the Sessions toolbar's facet state, and
 * `orgAggregationScope` is the insights aggregation scope an org-spelled site
 * stands for — the real `InsightsScope.Org`, not a hand spelling of it. No
 * production code reads it; the org tile's render guard
 * (`insights-data-source-provider-session-count-render.test.tsx`) mounts the
 * dashboard read AT this scope and asserts the request it sends, so the value
 * and the read the guard observes cannot drift apart (ISS-10888).
 */
export const SESSION_COUNT_MODELED_READ = {
  facetSelection: "empty",
  orgAggregationScope: InsightsScope.Org,
} as const;

/**
 * Every place in the product that renders one of these counts. A site is a
 * RENDER LOCATION, not a population: two sites can show the same population
 * (the Dashboard header and the onboarding tour both read `sessionsTotal`), and
 * one component can be two sites' worth of population depending on the read mode
 * it is mounted under.
 */
export const SESSION_COUNT_SITE = {
  /** Sessions list footer, "Showing 1-25 of 240 sessions", cloud/org read. */
  SessionsListFooterOrg: "sessionsListFooterOrg",
  /** The same footer in desktop local mode, reading this machine's store. */
  SessionsListFooterThisDevice: "sessionsListFooterThisDevice",
  /**
   * Dashboard KPI tile "Sessions", web (org/cloud).
   *
   * ORG-SCOPED, as {@link SESSION_COUNT_MODELED_READ} states for every org
   * spelling: the `reconciles` verdict this site derives against the org list
   * footer holds only while the tile is mounted at Organization scope, on
   * `/{orgSlug}/dashboard` or `/{orgSlug}/insights`. Both routes default to Me,
   * so the verdict is no claim about a Me- or Team-scoped mount of the same
   * tile. The registry has one tile member per SHELL and none
   * per aggregation scope; why that is recorded rather than modeled is in the
   * file docblock (ISS-10888).
   */
  DashboardKpiTileOrg: "dashboardKpiTileOrg",
  /** Dashboard KPI tile "Sessions", desktop (local). */
  DashboardKpiTileThisDevice: "dashboardKpiTileThisDevice",
  // There is NO tour-intro site any more. ISS-10546 (#7513) retired the
  // opening summary card Desktop prepended to its run — the normative
  // prototype opens on the first spotlight — so `build-tour-intro-step.tsx`,
  // the `intro` variant of `TourStep`, and the "Sessions" summary row that
  // rendered this count are all gone. A site is a RENDER LOCATION, and this one
  // no longer exists on any surface, so an entry for it would be a registry
  // claiming a count the product does not draw.
  // The four sync-banner sites are GONE, on the same rule that retired the
  // tour-intro one above. `SessionsSyncProgressBanner` was the only component
  // that rendered them, and #7291 deleted it as collateral while retiring the
  // workspace-experience v2 gate. A site is a render location, so with no
  // component drawing the pair these entries would be the registry claiming
  // counts the product does not draw. The sync pair DID come back, on the
  // desktop startup readiness bar (ISS-11668 ruling 10), which feeds the lane's
  // delivered and in-flight counts through `resolveSyncCounter`; that bar is
  // not a registered site, and the two populations it draws carry the note
  // (ISS-10658).
} as const;
export type SessionCountSite =
  (typeof SESSION_COUNT_SITE)[keyof typeof SESSION_COUNT_SITE];

/** Which population each site actually renders. */
export const SESSION_COUNT_SITE_POPULATION: Record<
  SessionCountSite,
  SessionCountPopulation
> = {
  [SESSION_COUNT_SITE.SessionsListFooterOrg]:
    SESSION_COUNT_POPULATION.SessionsInWindowOrg,
  [SESSION_COUNT_SITE.SessionsListFooterThisDevice]:
    SESSION_COUNT_POPULATION.SessionsInWindowThisDevice,
  // ISS-10541: the tile renders the SAME population as the list footer beside
  // it, which is what makes `reconcileSessionCountSites` derive `reconciles` for
  // the pair. A repoint rather than a scope edit — the tile's SQL windows on
  // `lastActivityAt` unconditionally now, so a `dashboardWindowed*` member would
  // be the registry holding a population no code produces.
  [SESSION_COUNT_SITE.DashboardKpiTileOrg]:
    SESSION_COUNT_POPULATION.SessionsInWindowOrg,
  [SESSION_COUNT_SITE.DashboardKpiTileThisDevice]:
    SESSION_COUNT_POPULATION.SessionsInWindowThisDevice,
};

/** The answer to "should these two numbers be the same?" */
export const SESSION_COUNT_RECONCILIATION = {
  /** Same population: a disagreement here is a defect, not a scope difference. */
  Reconciles: "reconciles",
  /** Different populations: they are not expected to match, and never were. */
  IntentionallyDiffers: "intentionallyDiffers",
} as const;
export type SessionCountReconciliation =
  (typeof SESSION_COUNT_RECONCILIATION)[keyof typeof SESSION_COUNT_RECONCILIATION];

/**
 * The scope axes, in disclosure order, that a difference can be attributed to.
 *
 * `dateBasis` sits immediately after `time` because it refines it: `time` says a
 * range applies, `dateBasis` says which column the range is measured against.
 */
export const SESSION_COUNT_SCOPE_AXES = [
  "unit",
  "owner",
  "device",
  "workspace",
  "time",
  "dateBasis",
] as const;
export type SessionCountScopeAxis = (typeof SESSION_COUNT_SCOPE_AXES)[number];

/**
 * Compile-time proof that the array above names every key of a scope record.
 *
 * It is a side inventory of `SessionCountPopulationScope`'s keys, and an axis
 * present on the record but missing here is never compared — two populations
 * would then be derived as differing on nothing while genuinely covering
 * different rows, which is the exact hole ISS-10604 found `dateBasis` sitting
 * in. A key added to the record must be added here, and its value must already
 * be a member of the array, or this fails to compile.
 *
 * MAPPED rather than `Record<keyof …, SessionCountScopeAxis>`, which is what
 * makes the sentence above true (#7549 review). A `Record` whose value type is
 * the whole union relates key to value not at all: `foo: "time"` for a key the
 * array never names compiles clean, and `foo` goes on never being compared.
 * `Extract` resolves to `never` for a key absent from the array, and nothing
 * satisfies `never`.
 */
export const SESSION_COUNT_SCOPE_AXIS_COVERAGE: {
  [K in keyof SessionCountPopulationScope]: Extract<SessionCountScopeAxis, K>;
} = {
  unit: "unit",
  owner: "owner",
  device: "device",
  workspace: "workspace",
  time: "time",
  dateBasis: "dateBasis",
};

/** Every site, in declaration order, for exhaustive iteration. */
export const ALL_SESSION_COUNT_SITES: readonly SessionCountSite[] =
  Object.values(SESSION_COUNT_SITE);

/**
 * Which scope axes two populations disagree on. Empty means they are the same
 * population, which is the only case in which their counts must match.
 */
export const differingScopeAxes = (
  left: SessionCountPopulation,
  right: SessionCountPopulation
): readonly SessionCountScopeAxis[] => {
  const leftScope = SESSION_COUNT_POPULATION_SCOPE[left];
  const rightScope = SESSION_COUNT_POPULATION_SCOPE[right];
  return SESSION_COUNT_SCOPE_AXES.filter(
    (axis) => leftScope[axis] !== rightScope[axis]
  );
};

/**
 * Whether two rendered counts are expected to agree. Same population is the ONLY
 * reconciling case: two populations whose scope records happen to be identical
 * are still distinct populations counted by different code, so this returns
 * `IntentionallyDiffers` for them rather than promising an equality the product
 * does not enforce.
 */
export const reconcileSessionCountSites = (
  left: SessionCountSite,
  right: SessionCountSite
): SessionCountReconciliation =>
  SESSION_COUNT_SITE_POPULATION[left] === SESSION_COUNT_SITE_POPULATION[right]
    ? SESSION_COUNT_RECONCILIATION.Reconciles
    : SESSION_COUNT_RECONCILIATION.IntentionallyDiffers;
