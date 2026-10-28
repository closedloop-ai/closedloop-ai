/**
 * Maps the canonical org-wide agent-component analytics
 * (`AgentComponent` / `AgentComponentDetail`) onto the `PackView` analytics
 * blocks — the single source of truth for per-pack usage, code productivity, and
 * adoption. No new aggregation: these are the metrics the agent-components
 * services already compute (FEA-3090 LOC/$, invocation/session rollups,
 * adoption breadth).
 */

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { resolveLocPerDollar } from "@repo/api/src/utils/loc-per-dollar";
import { packInstallersFromNames } from "./pack-installers";
import type { PackPerformance, PackTeamUsage } from "./pack-view";

/**
 * Derive the `teamUsage` (adoption) and `performance` blocks for a pack from its
 * linked agent-component DETAIL. `computeTargetIds` is the device adoption
 * breadth. The comparison metrics (success rate, token efficiency, merged PRs,
 * deltas, hidden quality) are carried on `AgentComponentDetail` — the detail
 * read computes them over the component's session cohort — so this maps them
 * 1:1 onto `PackPerformance`, no re-aggregation.
 */
export function agentComponentToPackAnalytics(
  component: AgentComponentDetail
): {
  teamUsage: PackTeamUsage;
  performance: PackPerformance;
} {
  // codex P1 (FEA-4098): the `installers` / "Used By" roster models who USED the
  // pack — NOT the version AUTHORS in `collaborators` (discoverer + editors).
  // Mapping authors → installers corrupts the adoption model: it would show
  // authors as users, omit real users who never edited the definition, and
  // inflate `installedCount`, popular sorting, and teammate recommendations.
  //
  // ISS-6768: the roster itself now travels on the detail contract
  // (`installers`), folded by the cloud from the identity's live inventory rows
  // by the SAME producer that fills the desktop overlay's
  // `PackAnalyticsResponse.owners`. Before this the mapper hardcoded an empty
  // roster, so one pack reported a populated "Used by" stack on desktop and
  // "Used by (0)" on web.
  //
  // `installers` is optional on the wire, and its ABSENCE means the producer
  // could not compute a roster — a rolling deploy, or a producer that does not
  // carry one. Coercing that to `[]` would re-tell the same lie in the other
  // direction: `Used by (0)` on a pack whose device adoption is nonzero. So the
  // unavailable case omits both fields and `PackTeamUsage` carries it through to
  // the render; only an explicit `[]` from the producer is a measured zero.
  // `deviceCount` remains device-level adoption breadth, not a headcount.
  const trend = [...component.trend];
  const installers =
    component.installers === undefined
      ? undefined
      : packInstallersFromNames(component.installers);

  return {
    teamUsage: {
      ...(installers === undefined
        ? {}
        : { installedCount: installers.length, installers }),
      deviceCount: component.computeTargetIds.length,
      installTrend: trend,
    },
    performance: {
      // ISS-4667 version skew: `usePackAnalytics` hands this raw
      // `AgentComponentDetail`, which a server predating the rename fills with the
      // KLOC-unit `klocPerDollar`/`klocDelta` and OMITS the canonical fields.
      // Resolve LOC/$ through the shared resolver, and fall back from the omitted
      // `locDelta` to the unit-free `klocDelta` (same number, no scaling), so the
      // Performance tab renders valid legacy data instead of unavailable.
      locPerDollar: resolveLocPerDollar(
        component.locPerDollar,
        component.klocPerDollar
      ),
      locDelta:
        component.locDelta === undefined
          ? (component.klocDelta ?? null)
          : component.locDelta,
      successRate: component.successRate,
      successDelta: component.successDelta,
      tokenEfficiencyDelta: component.tokenEfficiencyDelta,
      efficiencyTrend: [...component.efficiencyTrend],
      invocations: component.invocations,
      sessions: component.sessions,
      mergedPrs: component.mergedPrs,
      // ISS-6462: carried, NOT defaulted. Dropping it here made the Packs tile
      // print a capped scan as an exact count; folding an omission to `false`
      // would make it assert full-cohort coverage under version skew instead.
      mergedPrsTruncated: component.mergedPrsTruncated,
      // ISS-9853: carried, NOT defaulted — same reason as the flag above. A
      // producer that omits it did not measure its comparator's coverage, and
      // folding that to `null` would assert a whole-window comparison.
      baselineSampleSize: component.baselineSampleSize,
      qualityScore: component.qualityScore,
      qualityDelta: component.qualityDelta,
      usageTrend: trend,
    },
  };
}
