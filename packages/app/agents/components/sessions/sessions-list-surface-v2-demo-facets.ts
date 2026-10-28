import {
  isExhaustiveCostFilter,
  matchesChangePresence,
  matchesCostBucket,
  matchesPrAssociation,
  SESSION_UNKNOWN_COST_BUCKET_ID,
  type SessionChangeCounts,
  sessionHasChanges,
} from "@repo/api/src/agent-session-filters";
import { matchesAutonomyTier } from "@repo/api/src/session-autonomy-tiers";
import { costLabelIsFigure } from "../../lib/cost-availability";
import type { SessionFacetFilters } from "../../lib/session-filter-adapter";
import type { SessionTableRow } from "../../lib/session-list-row";
import { ownerId } from "./sessions-list-group-values";

/**
 * Per-row evidence a mock host holds outside {@link SessionTableRow}. The row
 * carries no diff counts and no project ids, so without it the Changes facet
 * reads every row as unchanged and the Project facet matches none.
 */
export type SessionsPreviewFacetEvidence = {
  changeCounts?: (row: SessionTableRow) => SessionChangeCounts;
  projectIds?: (row: SessionTableRow) => readonly string[];
};

/**
 * Whether a preview row survives every facet the server-driven Sessions menu
 * offers, with the server's semantics: OR within a facet, AND across facets,
 * and an empty selection narrows nothing.
 */
export function matchesSessionsPreviewFacets(
  row: SessionTableRow,
  facets: SessionFacetFilters,
  evidence: SessionsPreviewFacetEvidence = {}
): boolean {
  return Object.values(FACET_MATCHERS).every((matches) =>
    matches(row, facets, evidence)
  );
}

type FacetMatcher = (
  row: SessionTableRow,
  facets: SessionFacetFilters,
  evidence: SessionsPreviewFacetEvidence
) => boolean;

// Keyed by every facet so a new one fails typecheck until the demo applies it.
const FACET_MATCHERS: Record<keyof SessionFacetFilters, FacetMatcher> = {
  autonomyTiers: (row, { autonomyTiers }) =>
    anySelected(autonomyTiers, (tier) =>
      matchesAutonomyTier(row.autonomy ?? null, tier)
    ),
  changePresence: (row, { changePresence }, evidence) =>
    anySelected(changePresence, (option) =>
      matchesChangePresence(
        sessionHasChanges(evidence.changeCounts?.(row) ?? {}),
        option
      )
    ),
  costBuckets: (row, { costBuckets }) =>
    isExhaustiveCostFilter(costBuckets) ||
    anySelected(costBuckets, (bucketId) => matchesCost(row, bucketId)),
  harnesses: (row, { harnesses }) =>
    anySelected(harnesses, (harness) => harness === row.harness),
  models: (row, { models }) =>
    anySelected(models, (model) => model === (row.model ?? UNKNOWN_VALUE)),
  prAssociation: (row, { prAssociation }) =>
    anySelected(prAssociation, (option) =>
      matchesPrAssociation(row.pullRequests.length > 0, option)
    ),
  projectIds: (row, { projectIds }, evidence) =>
    anySelected(projectIds, (projectId) =>
      (evidence.projectIds?.(row) ?? []).includes(projectId)
    ),
  repositories: (row, { repositories }) =>
    anySelected(repositories, (repository) => repository === row.repo),
  statuses: (row, { statuses }) =>
    anySelected(statuses, (status) => status === row.status),
  userIds: (row, { userIds }) =>
    anySelected(userIds, (userId) => userId === ownerId(row)),
};

// The facet options key a missing harness or model under this value.
const UNKNOWN_VALUE = "unknown";

function anySelected(
  selected: readonly string[],
  matches: (value: string) => boolean
): boolean {
  return selected.length === 0 || selected.some(matches);
}

function matchesCost(row: SessionTableRow, bucketId: string): boolean {
  const cost = row.costValue;
  const numeric =
    costLabelIsFigure(row.costAvailability) &&
    typeof cost === "number" &&
    Number.isFinite(cost);
  if (bucketId === SESSION_UNKNOWN_COST_BUCKET_ID) {
    return !numeric;
  }
  return numeric && matchesCostBucket(cost, bucketId);
}
