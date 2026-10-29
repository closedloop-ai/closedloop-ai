import { ArtifactStatusReadOnlyReason } from "@repo/api/src/types/artifact-status-contract";
import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentStatus,
  DocumentType,
  ISSUE_STATUS_OPTIONS,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  type DocumentStatusMutationCapability,
  DocumentStatusMutationOperation,
} from "@repo/api/src/types/document-status-mutation";
import { describe, expect, it } from "vitest";
import { documentArtifactStatusCapability } from "../artifact-status-capability";

function statusMutation(
  overrides: Partial<DocumentStatusMutationCapability> = {}
): DocumentStatusMutationCapability {
  return {
    allowedStatuses: [DocumentStatus.Draft],
    expectedStatusByIdField: "expectedStatusById",
    expectedStatusField: "expectedStatus",
    ...overrides,
  };
}

describe("documentArtifactStatusCapability", () => {
  it("refuses a missing or unrecognized current status", () => {
    for (const rawStatus of [null, undefined, "FUTURE_STATUS"]) {
      expect(
        documentArtifactStatusCapability({
          documentType: DocumentType.Prd,
          operation: DocumentStatusMutationOperation.Single,
          rawStatus,
        })
      ).toEqual({
        editable: false,
        reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
      });
    }
  });

  it("honors an explicit permission refusal for the requested operation", () => {
    expect(
      documentArtifactStatusCapability({
        documentType: DocumentType.Feature,
        operation: DocumentStatusMutationOperation.Bulk,
        rawStatus: IssueStatus.InProgress,
        statusMutation: statusMutation({
          permissions: {
            [DocumentStatusMutationOperation.Bulk]: false,
            [DocumentStatusMutationOperation.Single]: true,
          },
        }),
      })
    ).toEqual({
      editable: false,
      reason: ArtifactStatusReadOnlyReason.NotPermitted,
    });
  });

  it("preserves a producer's narrowed target set", () => {
    const allowedStatuses = [DocumentStatus.Approved, DocumentStatus.Obsolete];

    expect(
      documentArtifactStatusCapability({
        documentType: DocumentType.Prd,
        operation: DocumentStatusMutationOperation.Single,
        rawStatus: DocumentStatus.InReview,
        statusMutation: statusMutation({ allowedStatuses }),
      })
    ).toEqual({ editable: true, allowedTargets: allowedStatuses });
  });

  it("falls back to the complete subtype vocabulary when list rows omit capability", () => {
    expect(
      documentArtifactStatusCapability({
        documentType: DocumentType.Prd,
        operation: DocumentStatusMutationOperation.Single,
        rawStatus: DocumentStatus.Draft,
      })
    ).toEqual({ editable: true, allowedTargets: DOCUMENT_STATUS_OPTIONS });

    expect(
      documentArtifactStatusCapability({
        documentType: DocumentType.Feature,
        operation: DocumentStatusMutationOperation.Bulk,
        rawStatus: IssueStatus.Todo,
      })
    ).toEqual({ editable: true, allowedTargets: ISSUE_STATUS_OPTIONS });
  });
});
