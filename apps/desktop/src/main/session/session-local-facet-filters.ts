import {
  isExhaustiveCostFilter,
  matchesChangePresence,
  matchesPrAssociation,
  sessionHasChanges,
} from "@repo/api/src/agent-session-filters";
import { matchesAutonomyTier } from "@repo/api/src/session-autonomy-tiers";
import { matchesPriorityFilter } from "@repo/api/src/types/priority-filter";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { matchesLocalCostBucketFilter } from "./local-cost-bucket-filter.js";
import { localSessionHasPr } from "./local-session-pull-requests.js";
import {
  localSubstantiveCounts,
  sumTokenUsage,
} from "./session-usage-totals.js";
import type { SanitizedQuery } from "./shared-agent-sessions-query.js";

/**
 * Harness/model multi-select, autonomy-tier / cost-bucket threshold, change /
 * PR evidence and (ISS-10332) priority facets, split out of `matchesQuery` to keep its complexity
 * bounded. Each dimension matches when the session falls in ANY selected value
 * (OR within a dimension); the dimensions compose with AND. Uses the shared
 * @repo/api SSOT so the desktop classification is identical to the cloud query
 * builder.
 *
 * Moved out of `shared-agent-sessions-api.ts` (grandfathered, shrink-only) by
 * ISS-10332 when the priority facet joined it.
 */
export function matchesLocalFacetFilters(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  return (
    matchesLocalValueFacets(session, query) &&
    matchesLocalEvidenceFacets(session, query) &&
    // ISS-10332: the cloud facet's predicate, so an unset selection gathers
    // the rows holding no priority.
    matchesPriorityFilter(session.priority, query.priorities)
  );
}

/** Free-text match over the local session identity and repository context. */
export function matchesLocalSessionSearch(
  session: SyncedAgentSession,
  search: string
): boolean {
  const needle = search.toLowerCase();
  const fields = [
    session.name,
    session.externalSessionId,
    session.harness,
    session.cwd,
    session.branch,
    session.attribution?.repositoryFullName,
    session.attribution?.baseBranch,
  ];
  return fields.some((value) => value?.toLowerCase().includes(needle));
}

function matchesLocalValueFacets(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  // Normalize a null harness/model to "unknown" so the facet selection matches
  // the option keys the usage breakdown emits (byHarness/byModel key null under
  // "unknown"); otherwise selecting "unknown" would hide the very rows it counts.
  if (
    query.harnesses.length > 0 &&
    !query.harnesses.includes(session.harness ?? "unknown")
  ) {
    return false;
  }
  // FEA-4303: match on the single PRIMARY displayed model (`session.model`), NOT
  // the per-token-usage set — the Model facet options are now sourced from the
  // primary-model rollup (`modelFilterOptions`) and the Sessions table paints the
  // primary model, so options, predicate, and column share one vocabulary. This
  // mirrors the cloud predicate in `query-builder.ts`, which filters on
  // `SessionDetail.model`. A null primary model normalizes to "unknown" (the
  // facet drops it, but a restored/deep-linked "unknown" selection still matches
  // rather than hiding the rows it would count).
  if (
    query.models.length > 0 &&
    !query.models.includes(session.model ?? "unknown")
  ) {
    return false;
  }
  if (
    query.autonomyTiers.length > 0 &&
    !query.autonomyTiers.some((tier) =>
      matchesAutonomyTier(session.autonomy ?? null, tier)
    )
  ) {
    return false;
  }
  return !(
    query.costBuckets.length > 0 &&
    // shafty thread (ISS-4481): an exhaustive selection excludes no row — skip
    // the matcher entirely so it composes as a no-op (and matches the
    // `hasNoLocalFacetFilters` fast-path decision).
    !isExhaustiveCostFilter(query.costBuckets) &&
    !matchesLocalCostBucketFilter(
      sumTokenUsage(session).estimatedCost,
      session.billingMode ?? null,
      // ISS-4481: the numeric-vs-unknown boundary gates on measurable work (a
      // no-work subscription session renders "—"), so pass the SAME substantive
      // counts the Idle badge derives.
      localSubstantiveCounts(session),
      query.costBuckets
    )
  );
}

// Change presence / PR association use the same signals the local Sessions row
// is built from (mapListItem → buildLocalSessionTraceFields), which the
// assembler may populate as either the top-level scalar LOC fields or the
// dedicated git/branch diff-stat objects, and PRs as either `prs` (trace) or
// `prRefs` (artifact-link) — so consider all of them to stay in step with the
// row and with the cloud query (which likewise checks both PR sources).
function matchesLocalEvidenceFacets(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  if (query.changePresence.length > 0) {
    const hasChanges = localSessionHasChanges(session);
    if (
      !query.changePresence.some((option) =>
        matchesChangePresence(hasChanges, option)
      )
    ) {
      return false;
    }
  }
  if (query.prAssociation.length > 0) {
    const hasPr = localSessionHasPr(session);
    if (
      !query.prAssociation.some((option) => matchesPrAssociation(hasPr, option))
    ) {
      return false;
    }
  }
  return true;
}

/** True when any local diff signal (top-level LOC or git/branch stats) is non-empty. */
function localSessionHasChanges(session: SyncedAgentSession): boolean {
  return (
    sessionHasChanges(session) ||
    sessionHasChanges(session.gitDiffStats ?? {}) ||
    sessionHasChanges(session.branchDiffStats ?? {})
  );
}
