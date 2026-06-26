import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, expect, test } from "vitest";
import type { ArtifactWithDocumentDetail } from "@/app/documents/document-utils";
import { toDocument } from "@/app/documents/document-utils";

const ARTIFACT_CREATED_AT = new Date("2026-01-05T12:00:00Z");
const ARTIFACT_UPDATED_AT = new Date("2026-01-06T12:00:00Z");

const artifactCreator: BasicUser = {
  id: "artifact-creator",
  email: "creator@example.com",
  firstName: "Artifact",
  lastName: "Creator",
  avatarUrl: null,
};

describe("toDocument", () => {
  test("maps populated artifact creator while preserving legacy createdById", () => {
    const document = toDocument(
      buildArtifactWithDocumentDetail({
        createdBy: artifactCreator,
        createdById: artifactCreator.id,
      })
    );

    expect(document.createdBy).toEqual(artifactCreator);
    expect(document.createdById).toBe(artifactCreator.id);
  });

  test("maps missing artifact creator to null while preserving legacy id fallback", () => {
    const document = toDocument(
      buildArtifactWithDocumentDetail({
        createdBy: null,
        createdById: null,
      })
    );

    expect(document.createdBy).toBeNull();
    expect(document.createdById).toBe("");
  });
});

function buildArtifactWithDocumentDetail(
  overrides: Partial<ArtifactWithDocumentDetail> = {}
): ArtifactWithDocumentDetail {
  return {
    id: "artifact-1",
    organizationId: "org-1",
    projectId: "project-1",
    workstreamId: null,
    type: ArtifactType.Document,
    subtype: DocumentType.Prd,
    name: "Artifact title",
    slug: "ART-1",
    assigneeId: null,
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: ARTIFACT_CREATED_AT,
    createdById: artifactCreator.id,
    updatedAt: ARTIFACT_UPDATED_AT,
    assignee: null,
    createdBy: artifactCreator,
    document: {
      artifactId: "artifact-1",
      fileName: null,
      approverId: null,
      templateForType: null,
      latestVersion: 1,
      repositorySnapshot: { repositories: [], source: "none" },
      approver: null,
    },
    ...overrides,
  } as ArtifactWithDocumentDetail;
}
