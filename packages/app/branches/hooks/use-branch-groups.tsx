"use client";

import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import { BranchListFilterFacet } from "@repo/api/src/types/branch-list-contract";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { presentArtifactStatusBand } from "@repo/app/shared/components/artifact-status/artifact-status-group-band";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { artifactStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import {
  groupBranchRows,
  groupUniversalBranchRows,
} from "../lib/branch-column-view-model";
import type { BranchRow } from "../lib/branch-row";
import { branchStatusEvidence } from "../lib/branch-row";

/** Selects canonical Branch status bands while leaving other dimensions intact. */
export function useBranchGroups(
  rows: readonly BranchRow[],
  labelRows: readonly BranchRow[],
  grouping: TableGroupingState | undefined
): GridTableV2Group<BranchRow>[] | undefined {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  if (!grouping) {
    return;
  }
  const groups = champion
    ? groupUniversalBranchRows(rows, grouping, labelRows)
    : groupBranchRows(rows, grouping, labelRows);
  if (!champion) {
    return groups;
  }
  return groups.map((group) => ({
    ...presentBranchGroup(group, grouping.primary.fieldId),
    subgroups: group.subgroups?.map((subgroup) =>
      presentBranchGroup(subgroup, grouping.secondary.fieldId)
    ),
  }));
}

function presentBranchGroup(
  group: GridTableV2Group<BranchRow>,
  fieldId: string | null
): GridTableV2Group<BranchRow> {
  if (fieldId !== BranchListFilterFacet.Status) {
    return group;
  }
  const firstRow = group.items[0];
  if (!firstRow) {
    return group;
  }
  const facet = artifactStatusFacet(
    ArtifactStatusVocabulary.Branch,
    branchStatusEvidence(firstRow)
  );
  return presentArtifactStatusBand(group, facet);
}
