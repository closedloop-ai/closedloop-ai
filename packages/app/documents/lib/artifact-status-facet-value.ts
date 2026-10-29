import {
  DISPLAYED_ARTIFACT_STATUS,
  UNKNOWN_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import {
  type ArtifactStatus,
  DOCUMENT_STATUS_OPTIONS,
  type DocumentType,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { documentStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";

/** A persisted project/My Tasks Status facet value, including version skew. */
export type ArtifactStatusFacetValue =
  | ArtifactStatus
  | typeof DISPLAYED_ARTIFACT_STATUS.Unknown;

const KNOWN_ARTIFACT_STATUSES = new Set<string>([
  ...DOCUMENT_STATUS_OPTIONS,
  ...ISSUE_STATUS_OPTIONS,
]);

/** Projects raw Document/Issue evidence into the one selectable facet value. */
export function artifactStatusFacetValue(
  documentType: DocumentType,
  rawStatus: string | null | undefined
): ArtifactStatusFacetValue | null {
  if (rawStatus == null) {
    return null;
  }
  const facet = documentStatusFacet(documentType, rawStatus);
  if (facet.normalized === UNKNOWN_ARTIFACT_STATUS) {
    return DISPLAYED_ARTIFACT_STATUS.Unknown;
  }
  return isArtifactStatus(rawStatus)
    ? rawStatus
    : DISPLAYED_ARTIFACT_STATUS.Unknown;
}

/** Restore-boundary guard for known raw values plus canonical Unknown. */
export function isArtifactStatusFacetValue(
  value: unknown
): value is ArtifactStatusFacetValue {
  return value === DISPLAYED_ARTIFACT_STATUS.Unknown || isArtifactStatus(value);
}

/**
 * Narrows to a STORED status, excluding the render-only `Unknown` bucket.
 *
 * Exported for the callers that have to split a facet selection by what is
 * persistable — a query parameter whose enum is the stored inventory cannot
 * carry `Unknown` (ISS-10472). Shares this module's one status inventory rather
 * than letting a caller rebuild it.
 */
export function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return typeof value === "string" && KNOWN_ARTIFACT_STATUSES.has(value);
}
