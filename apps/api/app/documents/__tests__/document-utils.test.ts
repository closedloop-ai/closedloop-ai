import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, expect, test } from "vitest";
import type { ArtifactWithDocumentDetail } from "@/app/documents/document-utils";
import {
  splitDocumentPayload,
  toDocument,
} from "@/app/documents/document-utils";

const ARTIFACT_CREATED_AT = new Date("2026-01-05T12:00:00Z");
const ARTIFACT_UPDATED_AT = new Date("2026-01-06T12:00:00Z");
const ARTIFACT_DUE_DATE = new Date("2026-07-24T00:00:00.000Z");

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

  test("maps artifact due date into the document contract", () => {
    const document = toDocument(
      buildArtifactWithDocumentDetail({
        dueDate: ARTIFACT_DUE_DATE,
      })
    );

    expect(document.dueDate).toBe(ARTIFACT_DUE_DATE);
  });

  test("normalizes a skew-stored ISSUE subtype to the canonical FEATURE (FEA-3956)", () => {
    // A skewed newer client could persist the canonical ISSUE value; on read the
    // document contract must expose the canonical FEATURE type, never ISSUE.
    const document = toDocument(
      buildArtifactWithDocumentDetail({
        subtype: "ISSUE" as ArtifactWithDocumentDetail["subtype"],
      })
    );

    expect(document.type).toBe(DocumentType.Feature);
  });

  test("keeps a legacy FEATURE subtype unchanged (skew-safe compat)", () => {
    const document = toDocument(
      buildArtifactWithDocumentDetail({ subtype: DocumentType.Feature })
    );

    expect(document.type).toBe(DocumentType.Feature);
  });
});

describe("splitDocumentPayload", () => {
  test("keeps dueDate on the artifact payload", () => {
    const { artifact, detail } = splitDocumentPayload({
      dueDate: ARTIFACT_DUE_DATE,
    });

    expect(artifact).toMatchObject({ dueDate: ARTIFACT_DUE_DATE });
    expect(detail).not.toHaveProperty("dueDate");
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
