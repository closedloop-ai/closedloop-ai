"use client";

import {
  type ArtifactStatus,
  type DocumentStatus,
  DocumentType,
  type IssueStatus,
} from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { IssueStatusIcon } from "@repo/app/documents/components/issue-status-icon";
import {
  type DocumentRowData,
  documentRowStatusEvidence,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { documentStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import type { ReactNode } from "react";
import { useKanbanStatusLabel } from "./use-kanban-status-label";

/** Resolves one card's complete legacy or champion status presentation. */
export function useKanbanArtifactStatus(
  artifact: DocumentRowData,
  laneStatuses?: readonly ArtifactStatus[]
): Readonly<{
  draggableOptions: Readonly<{ disabled?: boolean }>;
  statusContent: ReactNode;
  trailingStatusIcon: ReactNode;
}> {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const legacyLabel = useKanbanStatusLabel(artifact.status, artifact.type);

  if (champion) {
    const capability = documentArtifactStatusCapability({
      documentType: artifact.type,
      operation: DocumentStatusMutationOperation.Single,
      rawStatus: documentRowStatusEvidence(artifact),
      statusMutation: artifact.statusMutation,
    });
    // A one-status lane states the status once in its own header. The drag
    // preview passes no lane context and keeps the status because it floats
    // outside that header; mixed-status lanes keep it because the header does
    // not identify any one card's state.
    const statusContent =
      laneStatuses?.length === 1 ? null : (
        <UniversalArtifactStatus
          variant={ArtifactStatusVariant.Display}
          view={documentStatusView(
            artifact.id,
            artifact.type,
            documentRowStatusEvidence(artifact)
          )}
        />
      );
    return {
      draggableOptions: { disabled: !capability.editable },
      statusContent,
      trailingStatusIcon: null,
    };
  }

  return {
    draggableOptions: {},
    statusContent: legacyLabel,
    trailingStatusIcon:
      artifact.type === DocumentType.Feature ? (
        <IssueStatusIcon size={16} status={artifact.status as IssueStatus} />
      ) : (
        <DocumentStatusIcon
          size={16}
          status={artifact.status as DocumentStatus}
        />
      ),
  };
}
