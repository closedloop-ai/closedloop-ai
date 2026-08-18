import {
  DEFAULT_SESSION_QUALITY,
  type SessionQuality,
} from "@repo/api/src/agent-session-filters";
import type { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import type {
  AgentSessionQueryFilters,
  AgentSessionUsageQueryFilters,
} from "../data-source/agent-sessions-data-source";

/**
 * FEA-4177 — the summary/usage read's cache identity.
 *
 * The Sessions summary cards aggregate the whole (faceted) set, so their usage
 * read must be keyed by the summary filters ONLY — never the list's pagination or
 * sort fields, which the usage endpoint ignores. Folding usage into a list-keyed
 * combined query made it needlessly re-fetch on every page/sort change; splitting
 * it back out under a summary-scoped key keeps it cached across table navigation.
 *
 * This helper also normalizes the scope so an equivalent read hashes to the SAME
 * React Query key and dedupes automatically:
 *  - empty facet arrays are dropped (an unset facet is not part of the identity),
 *  - `quality` (optional; the web UI no longer sends one — FEA-4194) is dropped
 *    when absent or equal to the fail-open default (`all`), which the server
 *    treats identically to an absent param.
 * On the no-facet / all-quality path the result therefore deep-equals the
 * facet-option usage read's `{ startDate, endDate, userId }` scope, so the two
 * share one cache entry and issue ONE request instead of two identical no-facet
 * reads.
 */
export function buildSessionSummaryUsageFilters(input: {
  startDate?: string;
  endDate?: string;
  userId?: string;
  quality?: SessionQuality;
  statuses?: string[];
  userIds?: string[];
  repositories?: string[];
  harnesses?: string[];
  models?: string[];
  autonomyTiers?: string[];
  costBuckets?: string[];
  changePresence?: string[];
  prAssociation?: string[];
  projectIds?: string[];
  search?: string;
  /** ISS-5809: opt into the server-computed period-over-period comparison. */
  comparison?: AgentSessionComparisonMode;
}): AgentSessionUsageQueryFilters {
  const filters: AgentSessionUsageQueryFilters = {};
  if (input.comparison !== undefined) {
    filters.comparison = input.comparison;
  }
  if (input.startDate !== undefined) {
    filters.startDate = input.startDate;
  }
  if (input.endDate !== undefined) {
    filters.endDate = input.endDate;
  }
  if (input.userId !== undefined) {
    filters.userId = input.userId;
  }
  if (input.search !== undefined) {
    filters.search = input.search;
  }
  assignFacet(filters, "statuses", input.statuses);
  assignFacet(filters, "userIds", input.userIds);
  assignFacet(filters, "repositories", input.repositories);
  assignFacet(filters, "harnesses", input.harnesses);
  assignFacet(filters, "models", input.models);
  assignFacet(filters, "autonomyTiers", input.autonomyTiers);
  assignFacet(filters, "costBuckets", input.costBuckets);
  assignFacet(filters, "changePresence", input.changePresence);
  assignFacet(filters, "prAssociation", input.prAssociation);
  assignFacet(filters, "projectIds", input.projectIds);
  if (
    input.quality !== undefined &&
    input.quality !== DEFAULT_SESSION_QUALITY
  ) {
    filters.quality = input.quality;
  }
  return filters;
}

function assignFacet(
  target: AgentSessionQueryFilters,
  key:
    | "statuses"
    | "userIds"
    | "repositories"
    | "harnesses"
    | "models"
    | "autonomyTiers"
    | "costBuckets"
    | "changePresence"
    | "prAssociation"
    | "projectIds",
  value: string[] | undefined
): void {
  if (value !== undefined && value.length > 0) {
    target[key] = value;
  }
}
