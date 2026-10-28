import { UNKNOWN_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import {
  type ArtifactStatusCapability,
  ArtifactStatusReadOnlyReason,
} from "@repo/api/src/types/artifact-status-contract";
import type {
  ArtifactStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { statusOptionsForSubtype } from "@repo/api/src/types/document";
import type {
  DocumentStatusMutationCapability,
  DocumentStatusMutationOperation,
} from "@repo/api/src/types/document-status-mutation";
import { documentStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";

/**
 * Resolves a Document/Issue row's editor capability without inferring authority
 * from handler presence. Explicit permission denial and unrecognized current
 * evidence always refuse; capability-omitting list/tree rows retain the
 * existing same-vocabulary fallback while the write route re-authorizes.
 */
export function documentArtifactStatusCapability({
  documentType,
  operation,
  rawStatus,
  statusMutation,
}: Readonly<{
  documentType: DocumentType;
  operation: DocumentStatusMutationOperation;
  rawStatus: string | null | undefined;
  statusMutation?: DocumentStatusMutationCapability;
}>): ArtifactStatusCapability {
  const facet = documentStatusFacet(documentType, rawStatus);
  if (rawStatus == null || facet.normalized === UNKNOWN_ARTIFACT_STATUS) {
    return {
      editable: false,
      reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
    };
  }

  if (statusMutation?.permissions?.[operation] === false) {
    return {
      editable: false,
      reason: ArtifactStatusReadOnlyReason.NotPermitted,
    };
  }

  const allowedTargets =
    statusMutation?.allowedStatuses ?? statusOptionsForSubtype(documentType);
  return { editable: true, allowedTargets: allowedTargets as ArtifactStatus[] };
}
