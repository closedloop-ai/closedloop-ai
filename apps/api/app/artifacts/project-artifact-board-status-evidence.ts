import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import {
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardSort,
} from "@repo/api/src/types/project-artifact-board-page";
import {
  evaluateFeatureFlagForAnyIdentity,
  type FeatureFlagIdentity,
} from "@/lib/feature-flag-identity";
import { UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { resolveAssignedTreeSectionOrdering } from "./assigned-tree-section-ordering";
import { BoardStatusEvidence } from "./project-artifact-board-roots";

const FLAG_LOG_KEY = "project_board.status_evidence.flag_evaluation_failed";

/**
 * ISS-12929 (724-F5): which status the board's status filter matches, decided
 * by the same universal-artifact-status flag the browser's table filter reads
 * (`use-table-filters.ts`), so a server-filtered board keeps the population the
 * browser predicate kept. Evaluated only when a status filter is set, and above
 * the read snapshot so a PostHog round trip never spends the transaction's
 * budget. An unevaluable flag is off, the closed-by-default answer.
 */
export async function resolveBoardStatusEvidence(
  identity: FeatureFlagIdentity,
  filters: ProjectArtifactBoardFilters | undefined
): Promise<BoardStatusEvidence> {
  if (!filters?.statuses?.length) {
    return BoardStatusEvidence.Stored;
  }
  const universalStatus = await evaluateFeatureFlagForAnyIdentity(
    UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG,
    identity,
    FLAG_LOG_KEY
  );
  return universalStatus === true
    ? BoardStatusEvidence.Projected
    : BoardStatusEvidence.Stored;
}

/**
 * The order a status sort follows, resolved with the browser's precedence
 * (`useTableViewOrdering`) by the resolver the assigned tree already uses.
 * Read only when the board is sorted by status; any other order never
 * consults it.
 */
export function resolveBoardStatusOrdering(
  identity: FeatureFlagIdentity,
  sortBy: ProjectArtifactBoardSort | undefined
): Promise<ArtifactSectionOrdering> {
  if (sortBy !== ProjectArtifactBoardSort.Status) {
    return Promise.resolve(ArtifactSectionOrdering.Vocabulary);
  }
  return resolveAssignedTreeSectionOrdering(identity);
}
