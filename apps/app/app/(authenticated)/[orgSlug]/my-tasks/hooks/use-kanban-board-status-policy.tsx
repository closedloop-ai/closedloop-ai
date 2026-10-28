"use client";

import { UNKNOWN_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import {
  type ArtifactStatusCapability,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { ArtifactStatusIcon } from "@repo/app/documents/components/artifact-status-icon";
import {
  type DocumentRowData,
  documentRowStatusEvidence,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  artifactStatusFacet,
  documentStatusFacet,
} from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { type ReactNode, useCallback, useMemo } from "react";
import { DISPLAY_GROUPS } from "../utils";

export type KanbanStatusGroupPresentation = Readonly<{
  headerIcon?: ReactNode;
  headerTitle: string;
  items: readonly DocumentRowData[];
  key: string;
  label: string;
  statuses: readonly ArtifactStatus[];
}>;

/** Resolves the board's complete legacy or champion lane and write policy. */
export function useKanbanBoardStatusPolicy(
  artifacts: readonly DocumentRowData[]
): Readonly<{
  canMoveArtifactTo: (
    artifact: DocumentRowData,
    target: ArtifactStatus
  ) => boolean;
  groupKeyForArtifact: (artifact: DocumentRowData) => string | undefined;
  groups: readonly KanbanStatusGroupPresentation[];
}> {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const groups = useMemo(
    () =>
      champion ? buildChampionGroups(artifacts) : buildLegacyGroups(artifacts),
    [artifacts, champion]
  );
  const canMoveArtifactTo = useCallback(
    (artifact: DocumentRowData, target: ArtifactStatus) => {
      if (!champion) {
        return true;
      }
      const capability = boardStatusCapability(artifact);
      return capability.editable && capability.allowedTargets.includes(target);
    },
    [champion]
  );
  const groupKeyForArtifact = useCallback(
    (artifact: DocumentRowData) =>
      groups.find((group) =>
        group.items.some((item) => item.id === artifact.id)
      )?.key,
    [groups]
  );
  return { canMoveArtifactTo, groupKeyForArtifact, groups };
}

function buildLegacyGroups(
  artifacts: readonly DocumentRowData[]
): KanbanStatusGroupPresentation[] {
  return DISPLAY_GROUPS.map((group) => ({
    ...group,
    headerIcon: <ArtifactStatusIcon size={16} status={group.statuses[0]} />,
    headerTitle: group.label,
    items: artifacts.filter((artifact) =>
      group.statuses.includes(artifact.status)
    ),
  }));
}

function buildChampionGroups(
  artifacts: readonly DocumentRowData[]
): KanbanStatusGroupPresentation[] {
  const unmatched: DocumentRowData[] = [];
  const itemsByKey = new Map<string, DocumentRowData[]>(
    DISPLAY_GROUPS.map((group) => [group.key, []])
  );
  for (const artifact of artifacts) {
    const group = DISPLAY_GROUPS.find((candidate) =>
      candidate.statuses.includes(artifact.status)
    );
    if (hasUnrecognizedRetainedEvidence(artifact)) {
      unmatched.push(artifact);
    } else if (group) {
      itemsByKey.get(group.key)?.push(artifact);
    } else {
      unmatched.push(artifact);
    }
  }
  const groups = DISPLAY_GROUPS.map((group) => ({
    ...group,
    ...championHeader(group),
    items: itemsByKey.get(group.key) ?? [],
  }));
  if (unmatched.length > 0) {
    groups.push({
      headerTitle: "Unknown",
      items: unmatched,
      key: "unknown",
      label: "Unknown",
      statuses: [],
    });
  }
  return groups;
}

function championHeader(group: (typeof DISPLAY_GROUPS)[number]): Readonly<{
  headerIcon?: ReactNode;
  headerTitle: string;
}> {
  const firstStatus = group.statuses[0];
  if (firstStatus === undefined) {
    return { headerTitle: group.label };
  }
  if (group.statuses.length !== 1) {
    return {
      headerIcon: <ArtifactStatusIcon size={16} status={firstStatus} />,
      headerTitle: group.label,
    };
  }
  const vocabulary =
    group.key === "approved" || group.key === "executed"
      ? ArtifactStatusVocabulary.Document
      : ArtifactStatusVocabulary.Issue;
  return {
    headerIcon: (
      <UniversalArtifactStatus
        facet={artifactStatusFacet(vocabulary, firstStatus)}
        variant={ArtifactStatusVariant.BoardLane}
      />
    ),
    headerTitle: "",
  };
}

function boardStatusCapability(
  artifact: DocumentRowData
): ArtifactStatusCapability {
  return documentArtifactStatusCapability({
    documentType: artifact.type,
    operation: DocumentStatusMutationOperation.Single,
    rawStatus: documentRowStatusEvidence(artifact),
    statusMutation: artifact.statusMutation,
  });
}

function hasUnrecognizedRetainedEvidence(artifact: DocumentRowData): boolean {
  return (
    artifact.rawStatus !== undefined &&
    documentStatusFacet(artifact.type, artifact.rawStatus).normalized ===
      UNKNOWN_ARTIFACT_STATUS
  );
}
