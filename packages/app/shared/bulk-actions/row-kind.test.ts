import { ArtifactBulkKind } from "@repo/api/src/types/artifact-bulk-action";
import { DocumentType } from "@repo/api/src/types/document";
import { GenericArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { describe, expect, it } from "vitest";
import { documentBulkKind, genericBulkKind } from "./row-kind";

describe("artifact bulk row adapters", () => {
  it("classifies FEATURE documents as Issues and every other document type as Documents", () => {
    expect(documentBulkKind(DocumentType.Feature)).toBe(ArtifactBulkKind.Issue);
    for (const type of Object.values(DocumentType)) {
      if (type !== DocumentType.Feature) {
        expect(documentBulkKind(type)).toBe(ArtifactBulkKind.Document);
      }
    }
  });

  it("maps every production portable-list kind and withholds prototype-only kinds", () => {
    expect(Object.values(GenericArtifactKind).map(genericBulkKind)).toEqual([
      null,
      ArtifactBulkKind.Branch,
      ArtifactBulkKind.Document,
      ArtifactBulkKind.Deployment,
      ArtifactBulkKind.Issue,
      null,
      ArtifactBulkKind.Session,
    ]);
  });
});
