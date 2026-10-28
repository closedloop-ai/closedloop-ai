/**
 * One authenticated Branches-List row, built from the shared comprehensive
 * Branch detail fixture.
 *
 * Extracted from `branches-awaiting-sync-row.spec.ts` (ISS-5559) when a second
 * launched-app spec needed the same row (ISS-6385, the tag colour step). The
 * shape is not small — a `BranchRow` carries the canonical projection as well
 * as the flat legacy fields, and the two must agree on identity — so a second
 * copy would have drifted the moment either producer changed.
 *
 * Both callers pass the fields they actually vary; everything else comes from
 * `detailFor(ACTIVE_PR)` so the row stays consistent with the detail page the
 * same fixture serves.
 */

import {
  type BranchDataState,
  type BranchRow,
  BranchTagAvailability,
  type BranchTagPermissions,
} from "@repo/api/src/types/branch.ts";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics.ts";
import type { TagColor } from "@repo/api/src/types/tag.ts";
import {
  ACTIVE_PR,
  detailFor,
} from "../../../../../e2e/helpers/branch-details-comprehensive-data";

export type BranchListRowFixtureOptions = {
  branchName: string;
  id: string;
  /** `canonicalProjection.list.dataState` — the state the shared adapter reads. */
  canonicalDataState: BranchDataState;
  /** Flat legacy `dataState`, deliberately settable apart from the canonical one. */
  topLevelDataState: BranchDataState;
  /** ISO timestamp reported as a complete `lastActiveAt`. */
  lastActivityAt: string;
  /** Tags already applied to the row. Empty is a real state, not a missing one. */
  tags?: readonly { color: TagColor; id: string; name: string }[];
  tagPermissions: BranchTagPermissions;
};

export function branchListRowFixture({
  branchName,
  id,
  canonicalDataState,
  topLevelDataState,
  lastActivityAt,
  tags = [],
  tagPermissions,
}: Readonly<BranchListRowFixtureOptions>): BranchRow {
  const detail = detailFor(ACTIVE_PR);
  const projection = detail.canonicalProjection;
  if (!projection) {
    throw new Error(
      "Branches-List row fixture requires the canonical Branch projection."
    );
  }
  const appliedTags = [...tags];
  return {
    additions: detail.additions,
    ahead: detail.ahead,
    artifactId: id,
    attributedCostUsd: detail.attributedCostUsd,
    baseBranch: detail.baseBranch,
    behind: detail.behind,
    branchName,
    canonicalProjection: {
      ...projection,
      common: {
        ...projection.common,
        identity: {
          ...projection.common.identity,
          artifactId: id,
          branchName,
        },
        lastActiveAt: {
          state: BranchMetricAvailability.Complete,
          value: lastActivityAt,
        },
        tags: {
          availability: BranchTagAvailability.Available,
          items: appliedTags,
          permissions: tagPermissions,
        },
      },
      list: { ...projection.list, dataState: canonicalDataState },
    },
    checksPassed: detail.checksPassed,
    checksStatus: detail.checksStatus,
    checksTotal: detail.checksTotal,
    dataState: topLevelDataState,
    deletions: detail.deletions,
    estimatedCostUsd: detail.estimatedCostUsd,
    filesChanged: detail.filesChanged,
    id,
    lastActivityAt,
    multiPrWarning: detail.multiPrWarning,
    owner: detail.owner,
    prNumber: detail.prNumber,
    prState: detail.prState,
    prTitle: detail.prTitle,
    prUrl: detail.prUrl,
    projectId: projection.common.identity.projectId,
    repoFullName: detail.repoFullName,
    reviewDecision: detail.reviewDecision,
    sessionIds: detail.sessionIds,
    status: detail.status,
    tagAvailability: BranchTagAvailability.Available,
    tagPermissions,
    tags: appliedTags,
  };
}
