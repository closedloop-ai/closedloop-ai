import { ArtifactBulkKind } from "@repo/api/src/types/artifact-bulk-action";
import { DocumentType } from "@repo/api/src/types/document";
import { GenericArtifactKind } from "../components/generic-artifact-surface/generic-artifact-status";

/** A FEATURE document is an Issue action row, not a generic Document row. */
export function documentBulkKind(type: DocumentType): ArtifactBulkKind {
  return type === DocumentType.Feature
    ? ArtifactBulkKind.Issue
    : ArtifactBulkKind.Document;
}

/** The portable list's display kind has one canonical capability kind. */
export function genericBulkKind(
  kind: GenericArtifactKind
): ArtifactBulkKind | null {
  return GENERIC_BULK_KIND[kind];
}

/** Page capability kinds derived from the exhaustive display-kind adapter. */
export function genericBulkPageKinds(): ArtifactBulkKind[] {
  return Object.values(GENERIC_BULK_KIND).flatMap((kind) =>
    kind === null ? [] : [kind]
  );
}

const GENERIC_BULK_KIND = {
  [GenericArtifactKind.Agent]: null,
  [GenericArtifactKind.Branch]: ArtifactBulkKind.Branch,
  [GenericArtifactKind.Document]: ArtifactBulkKind.Document,
  [GenericArtifactKind.Deployment]: ArtifactBulkKind.Deployment,
  [GenericArtifactKind.Issue]: ArtifactBulkKind.Issue,
  [GenericArtifactKind.Prototype]: null,
  [GenericArtifactKind.Session]: ArtifactBulkKind.Session,
} as const satisfies Record<GenericArtifactKind, ArtifactBulkKind | null>;
