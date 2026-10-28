"use client";

import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { Chip } from "@repo/design-system/components/ui/chip";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  BranchRowStatus,
  branchStatusEvidence,
} from "../lib/branch-row";

/**
 * Shared Branch status treatment for both List tables. Lifecycle states remain
 * low-emphasis labels; Changes requested keeps the actionable filled chip.
 */
export function renderBranchStatus(
  row: Pick<BranchRow, "rawStatus" | "status">,
  artifactId: string
) {
  return <BranchStatusMark artifactId={artifactId} row={row} />;
}

function BranchStatusMark({
  artifactId,
  row,
}: Readonly<{
  artifactId: string;
  row: Pick<BranchRow, "rawStatus" | "status">;
}>) {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  if (champion) {
    return (
      <UniversalArtifactStatus
        variant={ArtifactStatusVariant.CompactCell}
        view={artifactStatusView(
          artifactId,
          ArtifactStatusVocabulary.Branch,
          branchStatusEvidence(row)
        )}
      />
    );
  }
  const { status } = row;
  const config = BRANCH_STATUS_CONFIG[status];
  if (status === BranchRowStatus.Blocked) {
    return (
      <Chip variant={config.variant}>
        <span className="size-1.5 rounded-full bg-current" />
        {config.label}
      </Chip>
    );
  }
  return <ToneLabel variant={config.variant}>{config.label}</ToneLabel>;
}
